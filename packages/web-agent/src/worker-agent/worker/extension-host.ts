/**
 * Worker-side controller for the Phase 1 extension runtime.
 *
 * Extracted from `WorkerAgentHost` so the ~200 lines of extension
 * lifecycle bookkeeping live as a single cohesive unit. The host
 * delegates vault-mount / unmount / prompt / agent-end hooks here and
 * exposes no extension-specific fields of its own.
 *
 * Responsibilities:
 *   - discover + load extensions from the vault, honouring the
 *     persisted enabled map (`enabledState`, host-owned),
 *   - dispatch `before_agent_start` / `tool_result` hooks,
 *   - reconcile enable-state changes (mid-stream updates are buffered
 *     via a single `pendingFlush` flag and applied at `agent_end`),
 *   - register extension-contributed slash commands on the shared
 *     `CommandRegistry`,
 *   - own the wrapping of registered tools into `AgentTool` instances,
 *   - forward descriptor updates and runtime errors through
 *     `extension_states` / `extension_error` RPC events.
 */

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@mariozechner/pi-agent-core';
import type { AgentSession } from '../core/agent-session';
import type { CommandRegistry } from '../core/commands';
import {
  ExtensionRunner,
  ReadonlySessionForwarder,
  loadExtensionsFromVault,
  wrapRegisteredTools,
  type AfterCompactEvent,
  type BeforeCompactEvent,
  type BeforeCompactOutcome,
  type Extension,
  type ExtensionContext,
  type ExtensionDescriptor,
  type ExtensionError,
  type ExtensionUIContext,
  type SessionLoadedReason,
} from '../core/extensions';
import type { SessionManager } from '../core/session/session-manager';
import type { VaultOperations } from '../fs/zenfs-operations';
import type { RpcEventEnvelope } from '../rpc/rpc-types';
import type { ExtensionProviderController } from './extension-provider-controller';
import type { ExtensionSkillController } from './extension-skill-controller';
import type { ExtensionUIController } from './extension-ui-controller';

/**
 * Collaborators the controller needs from the worker-host. Kept as a
 * narrow interface so the controller can be exercised in isolation
 * (see `extension-host.test.ts`) without standing up a real
 * `WorkerAgentHost`.
 */
export interface ExtensionHostDeps {
  session: AgentSession;
  commands: CommandRegistry;
  getVaultOps(): VaultOperations | null;
  getVaultMount(): string;
  isVaultAttached(): boolean;
  refreshTools(): void;
  emitEvent(event: RpcEventEnvelope): void;
  /** UI controller that backs `ctx.ui` / `pi.ui`. */
  uiController: ExtensionUIController;
  /** Provider controller that backs `pi.registerProvider`. */
  providerController: ExtensionProviderController;
  /** Skill controller that backs `pi.registerSkill`. */
  skillController: ExtensionSkillController;
  /**
   * Supplier for the active `SessionManager`. Extensions see it via
   * `ctx.session` through a `ReadonlySessionForwarder` that pins the
   * id current at `buildContext` time — swaps mid-handler throw.
   */
  getSessionManager(): SessionManager | null;
}

export class ExtensionHostController {
  private readonly runner = new ExtensionRunner();
  private readonly deps: ExtensionHostDeps;
  /** Authoritative enable map; merged in on every `setStates` call. */
  private enabledState: Record<string, boolean>;
  /** Last-seen descriptor list (both loaded and broken entries). */
  private descriptors: ExtensionDescriptor[] = [];
  /** True when a mid-stream `setStates` call needs flushing at agent_end. */
  private pendingFlush = false;
  /** Installed lazily once any extension is loaded; idempotent on reloads. */
  private toolCallHookInstalled = false;
  /** Lazy-install flag for pi-agent-core's `beforeToolCall` (context: `tool_call`). */
  private beforeToolCallHookInstalled = false;
  /** Lazy-install flag for pi-agent-core's `transformContext` (context: `context`). */
  private transformContextHookInstalled = false;
  /** Disposer for the session-event fan-out installed in `attachLifecycleSubscribers`. */
  private lifecycleUnsubscribe: (() => void) | null = null;

  constructor(deps: ExtensionHostDeps, initialEnabledState: Record<string, boolean> = {}) {
    this.deps = deps;
    this.enabledState = { ...initialEnabledState };
    // Runner errors fan out to the RPC transient channel. Installed
    // once and kept for the lifetime of the host — extensions come and
    // go across vault mounts but the controller instance does not.
    this.runner.onError(err => this.emitError(err));
    // Attach the `turn_start` / `message_end` fan-out once; the handler
    // short-circuits when no extensions subscribe so the happy path
    // carries zero overhead.
    this.attachLifecycleSubscribers();
  }

  // --------------------------------------------------------------------------
  // Public surface consumed by WorkerAgentHost
  // --------------------------------------------------------------------------

  /** Plain-data descriptor list for the `list_extensions` RPC command. */
  list(): ExtensionDescriptor[] {
    return this.descriptors;
  }

  /** Wrapped `AgentTool`s contributed by extensions, in load order. */
  getWrappedTools(): AgentTool[] {
    return wrapRegisteredTools(this.runner.getAllRegisteredTools(), () => this.buildContext());
  }

  /** Invoked from every vault mount path (`mountVault` / `mountDevSeed` / `reloadCommands`). */
  async loadFromVault(): Promise<void> {
    const vaultOps = this.deps.getVaultOps();
    if (!vaultOps) {
      this.clear();
      return;
    }
    let result: { extensions: Extension[]; descriptors: ExtensionDescriptor[] };
    try {
      result = await loadExtensionsFromVault(vaultOps, this.deps.getVaultMount(), {
        enabledState: this.enabledState,
        buildUIContext: path => this.deps.uiController.createContextFor(path),
      });
    } catch (err) {
      console.error('[ExtensionHostController] scan failed:', err);
      this.clear();
      return;
    }
    // Prune entries that no longer exist in the vault so the map does
    // not grow monotonically across session lifetimes.
    this.reconcileEnabledState(result.descriptors);
    this.runner.setExtensions(result.extensions);
    this.descriptors = result.descriptors;
    this.deps.commands.setExtensionCommands(this.runner.getRegisteredCommands());
    // Reconcile contributed providers + skills after every load so the
    // composite provider, the provider-list RPC event, and the slash
    // palette reflect the freshly loaded set. Both controllers are
    // idempotent on unchanged input.
    this.deps.providerController.setFromExtensions(result.extensions);
    this.deps.skillController.setFromExtensions(result.extensions);
    this.ensureToolCallHook();
    this.ensureTransformContextHook();
    this.ensureBeforeToolCallHook();
  }

  /**
   * Fire the `session_loaded` extension event. Phase 2b widens the
   * reason to every session-transition path — mount / reload / switch
   * / fork / new / navigate — so extensions get one observable call
   * per transition.
   */
  async emitSessionLoaded(reason: SessionLoadedReason): Promise<void> {
    await this.runner.emitSessionLoaded({ type: 'session_loaded', reason }, this.buildContext());
  }

  /**
   * Fire the `before_compact` extension event. Returns the merged
   * `{ cutIndex?, preserveEntries? }` the worker should apply before
   * preparing the summary. Error-isolated inside the runner.
   */
  async emitBeforeCompact(event: BeforeCompactEvent): Promise<BeforeCompactOutcome | undefined> {
    return this.runner.emitBeforeCompact(event, this.buildContext());
  }

  /** Fire the `after_compact` extension event. Observer only. */
  async emitAfterCompact(event: AfterCompactEvent): Promise<void> {
    await this.runner.emitAfterCompact(event, this.buildContext());
  }

  /** `set_extension_states` RPC command entry point. */
  async setStates(states: Record<string, boolean>): Promise<ExtensionDescriptor[]> {
    this.enabledState = { ...this.enabledState, ...states };
    if (this.deps.session.isStreaming()) {
      // Reloading now would yank tools out from under an in-flight
      // tool call; defer until agent_end. Mirrors coding-agent's
      // pendingExtensionChanges semantics.
      this.pendingFlush = true;
      return this.descriptors;
    }
    await this.reloadAndRefresh();
    return this.descriptors;
  }

  /** Invoked from the `agent_end` subscriber on WorkerAgentHost. */
  async flushIfPending(): Promise<void> {
    if (!this.pendingFlush) return;
    this.pendingFlush = false;
    if (!this.deps.getVaultOps()) return;
    await this.reloadAndRefresh();
  }

  /** Called from `unmountVault`. */
  clear(): void {
    this.runner.clear();
    this.descriptors = [];
    this.deps.commands.clearExtensionCommands();
    this.deps.providerController.clear();
    this.deps.skillController.clear();
    // Cancel any in-flight UI requests; late replies are dropped.
    this.deps.uiController.cancelAllForSession('vault unmount');
  }

  /** Dispose lifecycle subscribers. Used by tests that stand up / tear down hosts. */
  dispose(): void {
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = null;
    this.deps.uiController.cancelAllForSession('host dispose');
  }

  /** Broadcast the current descriptor snapshot over RPC. */
  emitStates(): void {
    this.deps.emitEvent({ type: 'extension_states', extensions: this.descriptors });
  }

  /** `before_agent_start` dispatch used by `WorkerAgentHost.prompt`. */
  async emitBeforeAgentStart(prompt: string, systemPrompt: string): Promise<string | undefined> {
    return this.runner.emitBeforeAgentStart(
      { type: 'before_agent_start', prompt, systemPrompt },
      this.buildContext()
    );
  }

  /**
   * Dispatch `/ext-cmd …` messages before regular command expansion.
   * Returns `true` when an extension handler ran (caller must not
   * forward the message to the LLM).
   */
  async tryRunCommand(message: string): Promise<boolean> {
    const trimmed = message.trimStart();
    if (!trimmed.startsWith('/')) return false;
    const spaceIdx = trimmed.indexOf(' ');
    const commandName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
    const cmd = this.deps.commands.findExtensionCommand(commandName);
    if (!cmd) return false;
    try {
      await cmd.handler(args, this.buildContext(cmd.extensionPath));
    } catch (err) {
      this.emitError({
        extensionPath: cmd.extensionPath,
        event: `command:${commandName}`,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    return true;
  }

  /** Build a fresh `ExtensionContext` per call so handlers see live state. */
  buildContext(extensionPath?: string): ExtensionContext {
    const ui = this.buildUIContextFor(extensionPath);
    // Issue a fresh forwarder per `buildContext` call so the pinned
    // session id tracks the id that was active when the handler was
    // dispatched. Late reads after a session swap throw
    // `InvalidSessionError`.
    const session = ReadonlySessionForwarder.from(() => this.deps.getSessionManager());
    return {
      cwd: this.deps.isVaultAttached() ? this.deps.getVaultMount() : undefined,
      isIdle: () => !this.deps.session.isStreaming(),
      abort: () => this.deps.session.abort(),
      ui,
      hasUI: true,
      session,
    };
  }

  /**
   * Build a UI context. When an extension path is supplied, route UI
   * calls through a per-extension channel so `setStatus` / notify
   * attributions are correct; for hook dispatch where the per-extension
   * path isn't readily available (e.g. chained `context` across
   * handlers), fall back to the root controller with an anonymous
   * path. The runner sees the current path at the call site when it
   * needs to discriminate.
   */
  private buildUIContextFor(extensionPath?: string): ExtensionUIContext {
    return this.deps.uiController.createContextFor(extensionPath ?? 'anonymous');
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async reloadAndRefresh(): Promise<void> {
    await this.loadFromVault();
    this.deps.refreshTools();
    this.emitStates();
  }

  /**
   * Install `setAfterToolCall` exactly once per host. The session
   * retains the hook across resets; later loads just get dispatched
   * through the same closure. When the runner has no extensions the
   * closure short-circuits, so the happy path pays zero overhead.
   */
  private ensureToolCallHook(): void {
    if (this.toolCallHookInstalled) return;
    this.toolCallHookInstalled = true;
    this.deps.session.setAfterToolCall(async (ctx: AfterToolCallContext) => {
      if (!this.runner.hasExtensions()) return undefined;
      const toolCall = ctx.toolCall;
      const result = ctx.result;
      const override = await this.runner.emitToolResult(
        {
          type: 'tool_result',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: (ctx.args ?? {}) as Record<string, unknown>,
          content: result.content ?? [],
          details: result.details,
          isError: ctx.isError,
        },
        this.buildContext()
      );
      if (!override) return undefined;
      const out: AfterToolCallResult = {};
      if (override.content !== undefined) out.content = override.content;
      if (override.details !== undefined) out.details = override.details;
      if (override.isError !== undefined) out.isError = override.isError;
      return out;
    });
  }

  /**
   * Install `setBeforeToolCall` exactly once per host so the runner
   * can observe + mutate tool arguments and emit a block when an
   * extension returns `{ block: true }`. Wrapping runs on every
   * tool invocation; the closure short-circuits when no extensions
   * subscribe.
   */
  private ensureBeforeToolCallHook(): void {
    if (this.beforeToolCallHookInstalled) return;
    this.beforeToolCallHookInstalled = true;
    this.deps.session.setBeforeToolCall(
      async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
        if (!this.runner.hasExtensions()) return undefined;
        if (!this.runner.hasHandlers('tool_call')) return undefined;
        const input = (ctx.args ?? {}) as Record<string, unknown>;
        const outcome = await this.runner.emitToolCall(
          {
            type: 'tool_call',
            toolCallId: ctx.toolCall.id,
            toolName: ctx.toolCall.name,
            input,
          },
          this.buildContext()
        );
        // Mutations on `input` are visible to the executor because
        // pi-agent-core uses the same `args` reference when it invokes
        // the tool — we're just the first observer in the chain.
        if (outcome.blocked) {
          return { block: true, reason: outcome.reason };
        }
        return undefined;
      }
    );
  }

  /**
   * Install `setTransformContext` exactly once per host. The transform
   * runs on every LLM call; the closure short-circuits when no
   * `context` handlers are subscribed so the happy path is a straight
   * pass-through.
   */
  private ensureTransformContextHook(): void {
    if (this.transformContextHookInstalled) return;
    this.transformContextHookInstalled = true;
    this.deps.session.setTransformContext(async (messages: AgentMessage[]) => {
      if (!this.runner.hasExtensions()) return messages;
      if (!this.runner.hasHandlers('context')) return messages;
      const override = await this.runner.emitContext(messages, this.buildContext());
      return override ?? messages;
    });
  }

  /**
   * Fan out `turn_start` / `message_end` pi-agent-core events to the
   * extension runner. The subscription is attached once per host; the
   * dispatch short-circuits when no handlers are subscribed.
   */
  private attachLifecycleSubscribers(): void {
    this.lifecycleUnsubscribe = this.deps.session.subscribe((event: AgentEvent) => {
      if (event.type === 'turn_start') {
        void this.runner.emitTurnStart(this.buildContext());
        return;
      }
      if (event.type === 'message_end') {
        void this.runner.emitMessageEnd(event.message, this.buildContext());
        return;
      }
    });
  }

  /**
   * Prune enabled-state keys that no longer appear in the latest
   * descriptor scan, so the map reflects what's actually on disk.
   * Keeps the wire payload lean across long-lived sessions.
   */
  private reconcileEnabledState(descriptors: ExtensionDescriptor[]): void {
    const known = new Set(descriptors.map(d => d.name));
    const next: Record<string, boolean> = {};
    for (const [name, enabled] of Object.entries(this.enabledState)) {
      if (known.has(name)) next[name] = enabled;
    }
    this.enabledState = next;
  }

  private emitError(err: ExtensionError): void {
    this.deps.emitEvent({ type: 'extension_error', ...err });
  }
}
