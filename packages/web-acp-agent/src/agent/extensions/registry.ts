/**
 * Boot-time orchestration for the extension subsystem.
 *
 * `ExtensionRegistry.loadAll(...)`:
 *   1. Calls `discoverExtensions(...)` to get `LoadedExtensionModule[]`
 *      (already dynamic-imported and validated).
 *   2. Constructs a per-extension `ExtensionAPI` and capability
 *      recorder.
 *   3. Awaits the factory function (`(pi) => void | Promise<void>`).
 *   4. Adds the resulting `ActiveExtension` to the runner.
 *
 * Failures during a single factory invocation are caught and
 * logged; peer extensions still load.
 */

import {
  type CapabilityRecorder,
  type CommandRegistrar,
  createExtensionAPI,
  type ExtensionSubscription,
  type ProviderRegistrar,
  type ToolRegistrar,
} from './api';
import {
  createExtensionEventBus,
  type ExtensionEventBusController,
  type ExtensionEventBusUnsubscribe,
} from './event-bus';
import { discoverExtensions, type DiscoverExtensionsInput } from './loader';
import { ExtensionRunner } from './runner';
import type { Api, Model } from '@mariozechner/pi-ai';
import type {
  AfterProviderResponseEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ExtensionCapabilities,
  ExtensionCommandDefinition,
  ExtensionCommandInfo,
  ExtensionEvent,
  ExtensionEventsView,
  ExtensionInfo,
  ExtensionSessionView,
  ExtensionTool,
  ExtensionVolumesView,
  InputEvent,
  InputEventResult,
  ProviderConfig,
  ProviderModelConfig,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from './types';

/**
 * Host-supplied bridge that the registry calls into for
 * session-bound APIs (`pi.session.appendEntry`, `setName`, etc.).
 * The runtime is responsible for wiring an instance via
 * `setSessionBridge` early — usually right after constructing
 * the registry and before the first session dispatch.
 *
 * The registry passes the active `sessionId` explicitly so the
 * bridge stays stateless; `pi.session.*` calls outside an
 * active dispatch are rejected upstream with a clear error.
 */
export interface SessionBridge {
  appendEntry(
    sessionId: string,
    extensionName: string,
    customType: string,
    data: unknown
  ): Promise<void>;
  setName(sessionId: string, name: string): Promise<void>;
  getName(sessionId: string): string | null;
  setLabel(
    sessionId: string,
    extensionName: string,
    entryId: string,
    label: string | undefined
  ): Promise<void>;
  sendMessage(sessionId: string, extensionName: string, text: string): Promise<void>;
  sendUserMessage(sessionId: string, extensionName: string, text: string): Promise<void>;
}

export type LoadAllInput = DiscoverExtensionsInput;

interface ToolRegistration {
  ownerExtension: string;
  tool: ExtensionTool;
}

interface CommandRegistration {
  ownerExtension: string;
  name: string;
  definition: ExtensionCommandDefinition;
}

interface ProviderRegistration {
  ownerExtension: string;
  name: string;
  config: ProviderConfig;
}

export class ExtensionRegistry {
  readonly #runner = new ExtensionRunner();
  readonly #tools = new Map<string, ToolRegistration>();
  readonly #toolCapabilities = new Map<string, ExtensionCapabilities>();
  readonly #commands = new Map<string, CommandRegistration>();
  readonly #providers = new Map<string, ProviderRegistration>();
  readonly #eventBus: ExtensionEventBusController = createExtensionEventBus();
  #mounts: DiscoverExtensionsInput['mounts'] | undefined;
  #lastInput: LoadAllInput | undefined;
  #disabled = new Set<string>();
  #knownNames = new Set<string>();
  #sessionBridge: SessionBridge | undefined;
  #activeSessionId: string | null = null;
  #reloadInFlight: Promise<void> | undefined;

  /**
   * Install the host's session bridge. Calls without a bridge
   * raise from `pi.session.*` so misconfigured embeds fail loudly
   * rather than silently dropping `appendEntry` writes.
   */
  setSessionBridge(bridge: SessionBridge): void {
    this.#sessionBridge = bridge;
  }

  /**
   * Set by `dispatchSessionStart` / `dispatchBeforeAgentStart` /
   * `dispatchInput` / `dispatchToolCall` / `dispatchToolResult`
   * before invoking handlers. `pi.session.getId()` reads from
   * here. Cleared back to `null` when the dispatch returns.
   */
  setActiveSession(sessionId: string | null): void {
    this.#activeSessionId = sessionId;
  }

  /**
   * Replace the active disabled set. Disabled names are skipped on
   * the next `loadAll` / `reload`. Pass an empty array to enable
   * everything.
   */
  setDisabled(names: readonly string[]): void {
    this.#disabled = new Set(names);
  }

  /** Snapshot of currently disabled extension names. */
  getDisabled(): string[] {
    return [...this.#disabled];
  }

  /** Names of every extension the loader has *ever* discovered. */
  getKnownNames(): string[] {
    return [...this.#knownNames].sort((a, b) => a.localeCompare(b));
  }

  async loadAll(input: LoadAllInput): Promise<void> {
    this.#mounts = input.mounts;
    this.#lastInput = input;
    const volumes: ExtensionVolumesView = {
      list: () => [...(this.#mounts ?? [])],
    };
    const warn = input.warn ?? defaultWarn;
    const modules = await discoverExtensions(input);
    for (const mod of modules) {
      this.#knownNames.add(mod.name);
      if (this.#disabled.has(mod.name)) continue;
      const subscriptions: ExtensionSubscription[] = [];
      const capabilities = emptyCapabilities();
      this.#toolCapabilities.set(mod.name, capabilities);
      const recorder: CapabilityRecorder = {
        recordEvent: (name: ExtensionEvent) => {
          if (!capabilities.events.includes(name)) capabilities.events.push(name);
        },
        recordTool: (name: string) => {
          if (!capabilities.tools.includes(name)) capabilities.tools.push(name);
        },
        recordCommand: (name: string) => {
          if (!capabilities.commands.includes(name)) capabilities.commands.push(name);
        },
        recordProvider: (name: string) => {
          if (!capabilities.providers.includes(name)) capabilities.providers.push(name);
        },
      };
      const tools = this.#createToolRegistrar(warn);
      const commands = this.#createCommandRegistrar(warn);
      const providers = this.#createProviderRegistrar(warn);
      const session = this.#createSessionView(mod.name);
      const eventUnsubs: ExtensionEventBusUnsubscribe[] = [];
      const events = this.#createEventsView(eventUnsubs);
      const pi = createExtensionAPI({
        extensionName: mod.name,
        recorder,
        subscriptions,
        fs: input.fs,
        volumes,
        tools,
        commands,
        providers,
        session,
        events,
      });
      try {
        await mod.factory(pi);
      } catch (err) {
        console.error(`[extensions] factory threw for '${mod.name}' (${mod.sourcePath}):`, err);
        continue;
      }
      const info: ExtensionInfo = {
        name: mod.name,
        mountName: mod.mountName,
        sourcePath: mod.sourcePath,
        capabilities,
      };
      const cleanupOwnedRegistrations = () => {
        for (const [toolName, reg] of [...this.#tools.entries()]) {
          if (reg.ownerExtension === mod.name) this.#tools.delete(toolName);
        }
        for (const [cmdName, reg] of [...this.#commands.entries()]) {
          if (reg.ownerExtension === mod.name) this.#commands.delete(cmdName);
        }
        for (const [provName, reg] of [...this.#providers.entries()]) {
          if (reg.ownerExtension === mod.name) this.#providers.delete(provName);
        }
        this.#toolCapabilities.delete(mod.name);
        for (const unsub of eventUnsubs) {
          try {
            unsub();
          } catch (err) {
            console.error(`[extensions] failed to unsubscribe pi.events for '${mod.name}':`, err);
          }
        }
        eventUnsubs.length = 0;
      };
      this.#runner.add({
        info,
        subscriptions,
        dispose: async () => {
          for (const sub of subscriptions) sub.disposed = true;
          cleanupOwnedRegistrations();
        },
      });
    }
  }

  #createEventsView(unsubs: ExtensionEventBusUnsubscribe[]): ExtensionEventsView {
    const bus = this.#eventBus;
    return {
      async emit(channel, data) {
        await bus.emit(channel, data);
      },
      on(channel, handler) {
        const unsub = bus.on(channel, handler);
        unsubs.push(unsub);
        return {
          dispose() {
            const idx = unsubs.indexOf(unsub);
            if (idx >= 0) unsubs.splice(idx, 1);
            unsub();
          },
        };
      },
    };
  }

  list(): ExtensionInfo[] {
    return this.#runner.list();
  }

  /**
   * Snapshot of every tool registered by extensions. The
   * prompt-driver merges these into the per-turn `tools` array
   * alongside `bash` and MCP tools.
   */
  listTools(): ExtensionTool[] {
    return [...this.#tools.values()].map(r => r.tool);
  }

  /**
   * Snapshot of every slash command registered by extensions.
   * Surfaced through `available_commands_update` and routed
   * through the builtin-dispatch path.
   */
  listCommands(): ExtensionCommandInfo[] {
    return [...this.#commands.values()].map(r => ({
      name: r.name,
      ownerExtension: r.ownerExtension,
      ...(r.definition.description !== undefined ? { description: r.definition.description } : {}),
      ...(r.definition.inputHint !== undefined ? { inputHint: r.definition.inputHint } : {}),
    }));
  }

  /**
   * Look up an extension command by canonical name. Returns
   * `null` when no extension owns a command with that name.
   * Returned `definition` is the live registration (handler is
   * the extension's own function).
   */
  findCommand(
    name: string
  ): { ownerExtension: string; definition: ExtensionCommandDefinition } | null {
    const reg = this.#commands.get(name);
    if (!reg) return null;
    return { ownerExtension: reg.ownerExtension, definition: reg.definition };
  }

  #createSessionView(extensionName: string): ExtensionSessionView {
    const requireBridge = (): SessionBridge => {
      if (!this.#sessionBridge) {
        throw new Error(
          `[extensions] '${extensionName}' invoked pi.session.* before host wired a SessionBridge`
        );
      }
      return this.#sessionBridge;
    };
    const requireActive = (op: string): void => {
      if (!this.#activeSessionId) {
        throw new Error(
          `[extensions] '${extensionName}' called pi.session.${op} outside an active session dispatch`
        );
      }
    };
    return {
      getId: () => this.#activeSessionId,
      appendEntry: async (customType: string, data: unknown) => {
        requireActive('appendEntry');
        const id = this.#activeSessionId as string;
        await requireBridge().appendEntry(id, extensionName, customType, data);
      },
      setName: async (name: string) => {
        requireActive('setName');
        const id = this.#activeSessionId as string;
        await requireBridge().setName(id, name);
      },
      getName: () => {
        const id = this.#activeSessionId;
        if (!id) return null;
        return requireBridge().getName(id);
      },
      setLabel: async (entryId: string, label: string | undefined) => {
        requireActive('setLabel');
        const id = this.#activeSessionId as string;
        await requireBridge().setLabel(id, extensionName, entryId, label);
      },
      sendMessage: async (text: string) => {
        requireActive('sendMessage');
        const id = this.#activeSessionId as string;
        await requireBridge().sendMessage(id, extensionName, text);
      },
      sendUserMessage: async (text: string) => {
        requireActive('sendUserMessage');
        const id = this.#activeSessionId as string;
        await requireBridge().sendUserMessage(id, extensionName, text);
      },
    };
  }

  #createCommandRegistrar(warn: (msg: string) => void): CommandRegistrar {
    return {
      register: (extensionName, name, def) => {
        if (typeof name !== 'string' || !name) {
          warn(`[extensions] '${extensionName}' tried to register a command with no name`);
          return false;
        }
        const existing = this.#commands.get(name);
        if (existing && existing.ownerExtension !== extensionName) {
          warn(
            `[extensions] command '/${name}' from '${extensionName}' replaces prior owner '${existing.ownerExtension}' (last-write-wins)`
          );
          const priorCaps = this.#toolCapabilities.get(existing.ownerExtension);
          if (priorCaps) {
            priorCaps.commands = priorCaps.commands.filter(n => n !== name);
          }
        }
        this.#commands.set(name, { ownerExtension: extensionName, name, definition: def });
        return true;
      },
      unregister: (extensionName, name) => {
        const existing = this.#commands.get(name);
        if (!existing) return;
        if (existing.ownerExtension !== extensionName) return;
        this.#commands.delete(name);
      },
    };
  }

  #createProviderRegistrar(warn: (msg: string) => void): ProviderRegistrar {
    return {
      register: (extensionName, name, config) => {
        if (typeof name !== 'string' || !name) {
          warn(`[extensions] '${extensionName}' tried to register a provider with no name`);
          return false;
        }
        const existing = this.#providers.get(name);
        if (existing && existing.ownerExtension !== extensionName) {
          warn(
            `[extensions] provider '${name}' from '${extensionName}' replaces prior owner '${existing.ownerExtension}' (last-write-wins)`
          );
          const priorCaps = this.#toolCapabilities.get(existing.ownerExtension);
          if (priorCaps) {
            priorCaps.providers = priorCaps.providers.filter(n => n !== name);
          }
        }
        this.#providers.set(name, { ownerExtension: extensionName, name, config });
        return true;
      },
      unregister: (extensionName, name) => {
        const existing = this.#providers.get(name);
        if (!existing) return;
        if (existing.ownerExtension !== extensionName) return;
        this.#providers.delete(name);
      },
    };
  }

  /**
   * Snapshot of provider models contributed by extensions. Hosts
   * (or the runtime's `getAvailableModels` chain) merge these with
   * the host provider's catalog before exposing models to the
   * client.
   */
  listProviderModels(): Model<Api>[] {
    const models: Model<Api>[] = [];
    for (const reg of this.#providers.values()) {
      const cfg = reg.config;
      const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '';
      const fallbackApi = cfg.api;
      for (const m of cfg.models ?? []) {
        const api = (m.api ?? fallbackApi) as Api | undefined;
        if (!api) continue;
        models.push({
          id: m.id,
          name: m.name,
          api,
          provider: reg.name,
          baseUrl,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        } as Model<Api>);
      }
    }
    return models;
  }

  /**
   * Resolve the provider configuration that owns a model id. The
   * caller (typically the stream-fn) uses the returned config to
   * pick `apiKey` / `headers` / `streamSimple` overrides.
   */
  findProviderForModel(modelId: string): {
    ownerExtension: string;
    providerName: string;
    config: ProviderConfig;
    model: ProviderModelConfig;
  } | null {
    for (const reg of this.#providers.values()) {
      for (const m of reg.config.models ?? []) {
        if (m.id === modelId) {
          return {
            ownerExtension: reg.ownerExtension,
            providerName: reg.name,
            config: reg.config,
            model: m,
          };
        }
      }
    }
    return null;
  }

  #createToolRegistrar(warn: (msg: string) => void): ToolRegistrar {
    return {
      register: (extensionName, tool) => {
        if (typeof tool?.name !== 'string' || !tool.name) {
          warn(`[extensions] '${extensionName}' tried to register a tool with no name`);
          return false;
        }
        const existing = this.#tools.get(tool.name);
        if (existing && existing.ownerExtension !== extensionName) {
          warn(
            `[extensions] tool '${tool.name}' from '${extensionName}' replaces prior owner '${existing.ownerExtension}' (last-write-wins)`
          );
          const priorCaps = this.#toolCapabilities.get(existing.ownerExtension);
          if (priorCaps) {
            priorCaps.tools = priorCaps.tools.filter(n => n !== tool.name);
          }
        }
        this.#tools.set(tool.name, { ownerExtension: extensionName, tool });
        return true;
      },
      unregister: (extensionName, toolName) => {
        const existing = this.#tools.get(toolName);
        if (!existing) return;
        if (existing.ownerExtension !== extensionName) return;
        this.#tools.delete(toolName);
      },
    };
  }

  async dispatchSessionStart(event: SessionStartEvent): Promise<void> {
    this.#activeSessionId = event.sessionId;
    try {
      await this.#runner.dispatchSessionStart(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  async dispatchBeforeAgentStart(
    event: BeforeAgentStartEvent
  ): Promise<BeforeAgentStartEventResult | undefined> {
    this.#activeSessionId = event.sessionId;
    try {
      return await this.#runner.dispatchBeforeAgentStart(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  async dispatchInput(event: InputEvent): Promise<InputEventResult | undefined> {
    this.#activeSessionId = event.sessionId;
    try {
      return await this.#runner.dispatchInput(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  async dispatchToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    this.#activeSessionId = event.sessionId;
    try {
      return await this.#runner.dispatchToolCall(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  async dispatchToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    this.#activeSessionId = event.sessionId;
    try {
      return await this.#runner.dispatchToolResult(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  async dispatchBeforeProviderRequest(event: BeforeProviderRequestEvent): Promise<unknown> {
    this.#activeSessionId = event.sessionId;
    try {
      return await this.#runner.dispatchBeforeProviderRequest(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  async dispatchAfterProviderResponse(event: AfterProviderResponseEvent): Promise<void> {
    this.#activeSessionId = event.sessionId;
    try {
      await this.#runner.dispatchAfterProviderResponse(event);
    } finally {
      this.#activeSessionId = null;
    }
  }

  /**
   * Re-run discovery against the last `loadAll` input and apply the
   * current disabled set. Active extensions are torn down (their
   * `dispose()` runs, owned tools/commands/providers/event handlers
   * are dropped); newly enabled or newly discovered extensions are
   * instantiated. Throws when called before the first `loadAll`.
   *
   * Concurrent calls share a single in-flight promise so two ACP
   * `_bodhi/extensions/reload` requests (or a reload racing with a
   * `_bodhi/extensions/add`-triggered reload) converge to one fresh
   * state instead of tearing the registry by interleaving disposal
   * + reload.
   */
  async reload(): Promise<void> {
    if (this.#reloadInFlight) return this.#reloadInFlight;
    if (!this.#lastInput) {
      throw new Error('[extensions] reload() called before loadAll()');
    }
    const input = this.#lastInput;
    const run = (async () => {
      try {
        await this.#runner.disposeAll();
        this.#tools.clear();
        this.#commands.clear();
        this.#providers.clear();
        this.#toolCapabilities.clear();
        this.#eventBus.clear();
        await this.loadAll(input);
      } finally {
        this.#reloadInFlight = undefined;
      }
    })();
    this.#reloadInFlight = run;
    return run;
  }

  async dispose(): Promise<void> {
    await this.#runner.disposeAll();
    this.#eventBus.clear();
  }
}

function emptyCapabilities(): ExtensionCapabilities {
  return { events: [], tools: [], commands: [], providers: [] };
}

function defaultWarn(msg: string): void {
  console.warn(msg);
}
