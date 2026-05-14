import type {
  AgentSideConnection,
  AvailableCommand,
  McpServerHttp,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { TSchema } from '@sinclair/typebox';
import {
  type CommandDef,
  loadCommandsFromVolumes,
  loadPromptsFromVolumes,
} from '../../agent/commands';
import { builtinAvailableCommands } from '../../agent/commands/builtins';
import { createMcpAgentTool, type McpPoolEvent, type McpToolDetails } from '../../agent/mcp';
import { readFeatureSnapshot } from '../../agent/internal/feature-prefs';
import { readMcpToggles } from '../../agent/internal/mcp-toggle-prefs';
import { FEATURE_DEFAULTS, type FeatureSnapshot } from '../../storage/feature-defaults';
import { isToolEnabled, type McpToggleSnapshot } from '../../storage/mcp-toggle-shape';
import {
  BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD,
  BODHI_MCP_STATE_NOTIFICATION_METHOD,
  type BodhiExtensionDescriptor,
  type BodhiExtensionsStateNotificationParams,
  type BodhiMcpStateNotificationParams,
} from '../../wire';
import { toAvailableCommand } from '../wire-utils';
import { walkEntries } from './replay';
import type { AcpAdapterServices } from './services';
import type { SessionState } from './types';

/**
 * Lifecycle orchestrator for ACP sessions. Owns the per-session map,
 * the active-inline-session pointer, the model + command caches, the
 * MCP pool subscription, and the rehydrate-from-store path.
 */
export class AcpSessionRuntime {
  readonly #conn: AgentSideConnection;
  readonly #services: AcpAdapterServices;
  readonly #mcpSubscription: () => void;
  readonly #sessions = new Map<string, SessionState>();
  #availableCommands: CommandDef[] = [];
  #models: Model<Api>[] = [];
  // The shared inline runtime carries one history at a time; track
  // which session owns it so cross-session prompts can't splice
  // contexts (which would poison `finalMessages` on `recordTurn`).
  #activeInlineSessionId: string | null = null;

  constructor(conn: AgentSideConnection, services: AcpAdapterServices) {
    this.#conn = conn;
    this.#services = services;
    this.#mcpSubscription = this.#services.mcpPool.subscribe(event => {
      void this.broadcastMcpPoolEvent(event);
    });
  }

  getSession(id: string): SessionState | undefined {
    return this.#sessions.get(id);
  }

  setSession(id: string, state: SessionState): void {
    this.#sessions.set(id, state);
  }

  deleteSessionEntry(id: string): void {
    this.#sessions.delete(id);
  }

  get sessions(): Map<string, SessionState> {
    return this.#sessions;
  }

  getActiveInlineSessionId(): string | null {
    return this.#activeInlineSessionId;
  }

  setActiveInlineSessionId(id: string | null): void {
    this.#activeInlineSessionId = id;
  }

  getModels(): Model<Api>[] {
    return this.#mergeExtensionModels(this.#models);
  }

  setModels(models: Model<Api>[]): void {
    this.#models = models;
  }

  // Lazy + cached. Cleared by `authenticate` so a fresh token
  // re-fetches under the new credential.
  async ensureModelsLoaded(): Promise<Model<Api>[]> {
    if (this.#models.length === 0) {
      this.#models = await this.#services.bodhi.getAvailableModels();
    }
    return this.#mergeExtensionModels(this.#models);
  }

  // Extension-contributed models are queried on every read so newly
  // registered providers show up without a re-auth. Extension
  // entries override host entries on id collision (last-write-wins).
  #mergeExtensionModels(host: Model<Api>[]): Model<Api>[] {
    const ext = this.#services.extensions?.listProviderModels() ?? [];
    if (ext.length === 0) return host;
    const merged = host.filter(m => !ext.some(e => e.id === m.id));
    return [...merged, ...ext];
  }

  setSessionModel(sessionId: string, modelId: string | null): void {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    state.currentModelId = modelId;
  }

  /**
   * Unified teardown for `closeSession` + `_bodhi/sessions/delete`:
   * abort matching in-flight turn, release MCP refcounts, drop
   * in-memory state, detach inline runtime if active, optionally
   * delete the persisted row. Idempotent.
   */
  async tearDownSession(
    sessionId: string,
    opts: {
      persistRow?: boolean;
      abortPromptIfActive?: (sessionId: string) => void;
    } = {}
  ): Promise<void> {
    const { persistRow = true, abortPromptIfActive } = opts;
    abortPromptIfActive?.(sessionId);
    await this.#services.mcpPool.releaseAll(sessionId);
    this.#sessions.delete(sessionId);
    if (this.#activeInlineSessionId === sessionId) {
      this.#activeInlineSessionId = null;
      this.#services.inline.clearMessages();
    }
    if (!persistRow && this.#services.store) {
      await this.#services.store.deleteSession(sessionId);
    }
  }

  getAvailableCommands(): CommandDef[] {
    return this.#availableCommands;
  }

  async readFeatures(sessionId: string): Promise<FeatureSnapshot> {
    if (!this.#services.preferences) {
      return { ...FEATURE_DEFAULTS };
    }
    try {
      return await readFeatureSnapshot(this.#services.preferences, sessionId);
    } catch (err) {
      console.error('[acp-session-runtime] failed to load features:', err);
      return { ...FEATURE_DEFAULTS };
    }
  }

  async readMcpToggles(sessionId: string): Promise<McpToggleSnapshot> {
    if (!this.#services.preferences) return { servers: {}, tools: {} };
    try {
      return await readMcpToggles(this.#services.preferences, sessionId);
    } catch (err) {
      console.error('[acp-session-runtime] failed to load mcp toggles:', err);
      return { servers: {}, tools: {} };
    }
  }

  // Errors swallowed: pool emits its own `error` events, and a
  // session should remain usable when one MCP server fails.
  async acquireMcpConnections(sessionId: string, servers: McpServerHttp[]): Promise<void> {
    await Promise.all(
      servers.map(async cfg => {
        try {
          await this.#services.mcpPool.acquire(sessionId, cfg);
        } catch (err) {
          console.error(`[acp-session-runtime] MCP acquire failed for ${cfg.name}:`, err);
        }
      })
    );
  }

  async releaseMcpConnections(sessionId: string, servers: McpServerHttp[]): Promise<void> {
    await Promise.all(servers.map(cfg => this.#services.mcpPool.release(sessionId, cfg)));
  }

  // Server-level toggles are filtered upstream in `composeMcpServers`;
  // here we apply per-tool toggles and skip un-connected servers.
  mcpToolsForSession(
    session: SessionState,
    toggles: McpToggleSnapshot
  ): AgentTool<TSchema, McpToolDetails>[] {
    const out: AgentTool<TSchema, McpToolDetails>[] = [];
    for (const cfg of session.mcpServers) {
      const client = this.#services.mcpPool.getClient(cfg);
      if (!client) continue;
      const tools = this.#services.mcpPool.getTools(cfg);
      for (const tool of tools) {
        if (!isToolEnabled(toggles, cfg.name, tool.name)) continue;
        out.push(createMcpAgentTool({ client, serverName: cfg.name, tool }));
      }
    }
    return out;
  }

  // Notifies hosts that the agent's extension registry shape has
  // changed (boot, `/extension on|off`, `_bodhi/extensions/reload`).
  // Transient — never persisted; hosts subscribe and refresh from
  // `_bodhi/extensions/list`.
  async broadcastExtensionsState(params: {
    extensions: BodhiExtensionDescriptor[];
    disabled: string[];
    knownNames: string[];
  }): Promise<void> {
    const payload: BodhiExtensionsStateNotificationParams = {
      extensions: params.extensions,
      disabled: params.disabled,
      knownNames: params.knownNames,
    };
    await this.#conn.extNotification(
      BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD,
      payload as unknown as Record<string, unknown>
    );
  }

  // Transient — never persisted; replay rebuilds from the live pool.
  async broadcastMcpPoolEvent(event: McpPoolEvent): Promise<void> {
    const affected = new Set<string>();
    for (const [sessionId, state] of this.#sessions) {
      if (state.mcpServers.some(cfg => cfg.name === event.server && cfg.url === event.url)) {
        affected.add(sessionId);
      }
    }
    if (affected.size === 0) return;
    await Promise.all(
      [...affected].map(sessionId => {
        const params: BodhiMcpStateNotificationParams = {
          sessionId,
          server: event.server,
          state: event.type,
          ...(event.error ? { error: event.error } : {}),
          ...(event.tools ? { tools: event.tools } : {}),
        };
        return this.#conn.extNotification(
          BODHI_MCP_STATE_NOTIFICATION_METHOD,
          params as unknown as Record<string, unknown>
        );
      })
    );
  }

  async rehydrateInlineFromStore(sessionId: string): Promise<void> {
    const inline = this.#services.inline;
    if (!this.#services.store) {
      inline.clearMessages();
      this.#activeInlineSessionId = sessionId;
      return;
    }
    const entries = await this.#services.store.readEntries(sessionId);
    let lastTurnMessages: AgentMessage[] | undefined;
    await walkEntries(entries, {
      turn: payload => {
        if (Array.isArray(payload.finalMessages)) {
          lastTurnMessages = payload.finalMessages;
        }
      },
    });
    if (lastTurnMessages) {
      inline.restoreMessages(lastTurnMessages);
    } else {
      inline.clearMessages();
    }
    this.#activeInlineSessionId = sessionId;
  }

  // Refresh cached vault commands + prompts, merge with built-ins,
  // emit `available_commands_update`. Commands win on canonical-name
  // collisions with prompts; the dropped prompt logs a warning.
  async refreshAvailableCommands(sessionId: string): Promise<void> {
    const mounts = this.#services.registry?.list() ?? [];
    let cmdDefs: CommandDef[] = [];
    let promptDefs: CommandDef[] = [];
    if (mounts.length > 0) {
      try {
        cmdDefs = await loadCommandsFromVolumes({
          mounts,
          fs: this.#services.commandsFs,
        });
      } catch (err) {
        console.error('[acp-session-runtime] command load failed:', err);
        cmdDefs = [];
      }
      try {
        promptDefs = await loadPromptsFromVolumes({
          mounts,
          fs: this.#services.commandsFs,
        });
      } catch (err) {
        console.error('[acp-session-runtime] prompt load failed:', err);
        promptDefs = [];
      }
    }
    const merged: CommandDef[] = [...cmdDefs];
    const seenNames = new Set(cmdDefs.map(d => d.name));
    for (const def of promptDefs) {
      if (seenNames.has(def.name)) {
        const existing = cmdDefs.find(d => d.name === def.name);
        const existingPath = existing
          ? `/mnt/${existing.source.mountName}/${existing.source.relPath}`
          : '(unknown command)';
        console.warn(
          `[prompts] '${def.name}' from /mnt/${def.source.mountName}/${def.source.relPath} ` +
            `ignored (command with the same name already registered from ${existingPath})`
        );
        continue;
      }
      merged.push(def);
      seenNames.add(def.name);
    }
    this.#availableCommands = merged;
    // Vault commands + prompts shadow extension commands on cross-source name
    // collisions. Within extensions themselves, last-write-wins is enforced
    // inside the registry (see extensions.md "Conflict resolution"); here we
    // only keep the first-registered name from `seenNames` so a vault command
    // wins over a same-name extension command.
    const extensionCommands: AvailableCommand[] = [];
    const extensions = this.#services.extensions;
    if (extensions) {
      for (const ext of extensions.listCommands()) {
        if (seenNames.has(ext.name)) {
          console.warn(
            `[extensions] command '${ext.name}' from extension '${ext.ownerExtension}' ` +
              `shadowed by a vault command/prompt with the same name`
          );
          continue;
        }
        seenNames.add(ext.name);
        const cmd: AvailableCommand = {
          name: ext.name,
          description: ext.description ?? '',
        };
        if (ext.inputHint) cmd.input = { hint: ext.inputHint };
        extensionCommands.push(cmd);
      }
    }
    const availableCommands: AvailableCommand[] = [
      ...builtinAvailableCommands(),
      ...merged.map(toAvailableCommand),
      ...extensionCommands,
    ];
    await this.emit({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      },
    });
  }

  async sessionStatsFor(sessionId: string): Promise<{ turnCount: number; messageCount: number }> {
    const messageCount = this.#services.inline.getMessages().length;
    if (!this.#services.store) return { turnCount: 0, messageCount };
    try {
      const row = await this.#services.store.getSession(sessionId);
      return { turnCount: row?.turnCount ?? 0, messageCount };
    } catch {
      return { turnCount: 0, messageCount };
    }
  }

  mcpConnectedFor(sessionId: string): string[] {
    const session = this.#sessions.get(sessionId);
    if (!session) return [];
    const out: string[] = [];
    for (const cfg of session.mcpServers) {
      if (this.#services.mcpPool.getClient(cfg)) out.push(cfg.name);
    }
    return out;
  }

  // Single exit for persisted session/update notifications. Use for
  // events that must survive reload; transient events go via
  // `#conn.extNotification` instead.
  async emit(notification: SessionNotification): Promise<void> {
    await this.#conn.sessionUpdate(notification);
    if (this.#services.store) {
      try {
        await this.#services.store.recordNotification(notification.sessionId, notification);
      } catch (err) {
        console.error('[acp-session-runtime] failed to persist notification:', err);
      }
    }
  }

  // Send without persisting. Used by built-in replies (persisted as
  // `'builtin'` instead) and `loadSession` replay (already in store).
  async sendRawNotification(notification: SessionNotification): Promise<void> {
    await this.#conn.sessionUpdate(notification);
  }

  // Transient — feature state is reconstructed from the persisted
  // feature row on every `loadSession`, so no need to persist this.
  async emitConfigOptionUpdate(
    sessionId: string,
    configOptions: SessionConfigOption[]
  ): Promise<void> {
    await this.#conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions,
      },
    });
  }

  // Unsubscribe MCP events, release every refcount, clear sessions.
  // Does NOT stop in-flight turns (driver-owned) or touch the store.
  async dispose(): Promise<void> {
    this.#mcpSubscription();
    const sessionIds = [...this.#sessions.keys()];
    await Promise.all(sessionIds.map(id => this.#services.mcpPool.releaseAll(id)));
    this.#sessions.clear();
  }
}
