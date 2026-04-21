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
  AgentTool,
} from '@mariozechner/pi-agent-core';
import type { AgentSession } from '../core/agent-session';
import type { CommandRegistry } from '../core/commands';
import {
  ExtensionRunner,
  loadExtensionsFromVault,
  wrapRegisteredTools,
  type Extension,
  type ExtensionContext,
  type ExtensionDescriptor,
  type ExtensionError,
} from '../core/extensions';
import type { VaultOperations } from '../fs/zenfs-operations';
import type { RpcEventEnvelope } from '../rpc/rpc-types';

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

  constructor(deps: ExtensionHostDeps, initialEnabledState: Record<string, boolean> = {}) {
    this.deps = deps;
    this.enabledState = { ...initialEnabledState };
    // Runner errors fan out to the RPC transient channel. Installed
    // once and kept for the lifetime of the host — extensions come and
    // go across vault mounts but the controller instance does not.
    this.runner.onError(err => this.emitError(err));
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
    this.ensureToolCallHook();
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
      await cmd.handler(args, this.buildContext());
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
  buildContext(): ExtensionContext {
    return {
      cwd: this.deps.isVaultAttached() ? this.deps.getVaultMount() : undefined,
      isIdle: () => !this.deps.session.isStreaming(),
      abort: () => this.deps.session.abort(),
    };
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
