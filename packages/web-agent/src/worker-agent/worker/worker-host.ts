/**
 * Worker-side AgentSessionHost implementation.
 *
 * Wraps a single `AgentSession`, owns the ZenFS attach/detach lifecycle on
 * the VFS port, delegates session persistence to an injected
 * `SessionStore`, and constructs MCP proxy tools that upcall to the main
 * thread for execution.
 */

import { attachFS, configure, detachFS, fs, InMemory, vfs } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import type { AgentEvent, AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { AgentSession } from '../core/agent-session';
import { CommandRegistry } from '../core/commands';
import type { SlashCommandInfo } from '../core/commands';
import {
  compactSummarize,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  shouldCompact,
  type CompactionSettings,
} from '../core/compaction';
import type { ExtensionDescriptor } from '../core/extensions';
import type { LlmAuthCredential, LlmProvider } from '../llm/types';
import { SessionManager } from '../core/session/session-manager';
import type { SessionStore } from '../core/session/store';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { buildSystemPrompt } from '../core/system-prompt';
import { createVaultTools } from '../core/tools';
import { createZenfsVaultOperations, type VaultOperations } from '../fs/zenfs-operations';
import { VAULT_MOUNT } from '../fs/zenfs-provider';
import type { AgentSessionHost, HostEventSink, ToolUpcallInvoker } from '../rpc/rpc-server';
import type { McpToolDescriptor, RpcEventEnvelope, RpcSessionState } from '../rpc/rpc-types';
import { ExtensionHostController } from './extension-host';
import type { InMemoryVaultSeed } from './init-protocol';

export interface WorkerAgentHostOptions {
  /** ZenFS mount path for the vault. Defaults to `VAULT_MOUNT` (`/vault`). */
  vaultMount?: string;
  /**
   * Override the default compaction settings. Tests pass a smaller
   * `contextWindow` + `keepRecentTokens` to exercise the auto path on
   * short transcripts; production takes the defaults.
   */
  compactionSettings?: Partial<CompactionSettings>;
  /**
   * Persisted extension enabled map, forwarded from the main thread's
   * init message so the very first vault load honours the user's
   * previous choices (no load-then-unload churn at boot).
   */
  initialExtensionEnabledState?: Record<string, boolean>;
}

// ZenFS's `Channel` type union includes WebSocket which makes structural
// matching against the browser's MessagePort fail. At runtime `RPC.from`
// detects MessagePort via `addEventListener in port`, so the cast is safe.
type ZenfsChannel = Parameters<typeof attachFS>[0];
const asChannel = (port: MessagePort): ZenfsChannel => port as unknown as ZenfsChannel;

export class WorkerAgentHost implements AgentSessionHost {
  private vaultTools: AgentTool[] = [];
  private mcpTools: AgentTool[] = [];
  private attachedFs: { detach: () => void } | null = null;
  /**
   * Active session's in-memory tree + leaf pointer. `null` until
   * `newSession` or `loadSession` runs. The message_end subscriber
   * short-circuits when null — a prompt sent before either method
   * (shouldn't happen, useAgent primes on mount) would leave that turn
   * un-persisted rather than crash.
   */
  private sessionManager: SessionManager | null = null;
  private hostEventSink: HostEventSink | null = null;
  /**
   * Serialises `appendMessage` calls from the message_end subscriber. Two
   * `message_end` events firing in the same microtask would otherwise both
   * read the same `leafId` before either resolved `store.appendMessage`,
   * leaving the second entry's parent link dangling.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  private readonly session: AgentSession;
  private readonly vfsPort: MessagePort;
  private readonly store: SessionStore;
  /**
   * The pluggable LLM gateway. Owns both auth resolution (used by the
   * live streamFn and the summariser) and the model catalog the Worker
   * resolves `(provider, id)` identifiers against. Coding-agent's node
   * Worker ships a config-file seeded `ModelRegistry`; web-agent's
   * Worker delegates the equivalent responsibility to this provider so
   * the main thread never has to push the catalog itself.
   */
  private readonly provider: LlmProvider;
  private readonly vaultMount: string;
  private readonly compactionSettings: CompactionSettings;
  /** Re-entrancy guard for the compaction pipeline. */
  private compactionInFlight = false;
  /** Cancels an in-flight summarisation LLM call on session swaps. */
  private compactionAbort: AbortController | null = null;
  /**
   * Slash-command registry: builtin metadata + prompt templates loaded
   * from `<vaultMount>/.pi/prompts/` + skills loaded from
   * `<vaultMount>/.pi/skills/`. All three collections are (re)loaded
   * on `mountVault` / `mountDevSeed` and cleared on `unmountVault`.
   * The registry is also consulted from `prompt()` to expand skill
   * and template invocations before they reach the agent.
   */
  private readonly commands = new CommandRegistry();
  /**
   * Currently mounted vault operations handle. Kept so `prompt()` can
   * lazily re-read SKILL.md during `/skill:<name>` expansion without a
   * second `createZenfsVaultOperations` call.
   */
  private vaultOps: VaultOperations | null = null;
  /**
   * All extension lifecycle lives here: discovery, hook dispatch,
   * tool wrapping, enable-state reconciliation, error surfacing.
   */
  private readonly extensions: ExtensionHostController;

  constructor(
    session: AgentSession,
    vfsPort: MessagePort,
    store: SessionStore,
    provider: LlmProvider,
    options: WorkerAgentHostOptions = {}
  ) {
    this.session = session;
    this.vfsPort = vfsPort;
    this.store = store;
    this.provider = provider;
    this.vaultMount = options.vaultMount ?? VAULT_MOUNT;
    this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compactionSettings };
    this.extensions = new ExtensionHostController(
      {
        session: this.session,
        commands: this.commands,
        getVaultOps: () => this.vaultOps,
        getVaultMount: () => this.vaultMount,
        isVaultAttached: () => this.attachedFs !== null,
        refreshTools: () => this.refreshTools(),
        emitEvent: (event: RpcEventEnvelope) => this.hostEventSink?.(event),
      },
      options.initialExtensionEnabledState
    );
    // Persist user/assistant/toolResult messages on turn boundaries. After
    // each successful append, re-emit `session_loaded` so the main thread's
    // message↔entryId mapping stays aligned (used by per-message Fork /
    // Branch actions).
    this.session.subscribe(event => {
      if (event.type === 'agent_end') {
        // Flush any enable-state changes the main thread pushed mid-run
        // now that the agent is idle. Matches coding-agent's
        // `pendingExtensionChanges` discipline.
        void this.extensions.flushIfPending().catch(err => {
          console.error('[WorkerAgentHost] extensions.flushIfPending failed:', err);
        });
        return;
      }
      if (event.type !== 'message_end') return;
      const sm = this.sessionManager;
      if (!sm) return;
      const role = (event.message as { role?: string }).role;
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return;
      this.writeChain = this.writeChain
        .then(async () => {
          await sm.appendMessage(event.message);
          this.emitSessionLoaded();
          // Auto-compaction runs inside the same serialised chain so a
          // follow-up `message_end` can't race a partial summary append.
          await this.maybeCompact().catch(err => {
            console.error('[WorkerAgentHost] maybeCompact failed:', err);
          });
        })
        .catch(err => {
          console.error('[WorkerAgentHost] appendMessage failed:', err);
        });
    });
  }

  // ==========================================================================
  // Plain-data passthroughs
  // ==========================================================================

  async prompt(message: string): Promise<void> {
    // 1. Extension slash command? Dispatch directly — the LLM never
    // sees the invocation. Mirrors coding-agent's extension-command
    // interception in `AgentSession.prompt`.
    if (await this.extensions.tryRunCommand(message)) return;

    // 2. Expand `/skill:<name>` (async) then prompt templates (sync)
    // so the LLM sees fully substituted user text. Unknown `/foo`
    // invocations fall through unchanged, matching coding-agent.
    const expanded = this.vaultOps
      ? await this.commands.expandAsync(message, this.vaultOps.read)
      : this.commands.expand(message);

    // 3. Let extensions shape the system prompt for this turn. Swap
    // any override in before the call and restore the base prompt in
    // a `finally` so the next turn starts clean.
    const previousSystemPrompt = this.session.getSystemPrompt();
    const override = await this.extensions.emitBeforeAgentStart(expanded, previousSystemPrompt);
    if (typeof override === 'string') {
      this.session.setSystemPrompt(override);
    }
    try {
      await this.session.prompt(expanded);
    } finally {
      if (typeof override === 'string') {
        this.session.setSystemPrompt(previousSystemPrompt);
      }
    }
  }
  abort(): void {
    this.session.abort();
  }
  /**
   * Set the active model by `(provider, modelId)`. Mirrors coding-agent
   * `AgentSession.setModel` (agent-session.ts:1394-1409): resolve via
   * the injected provider's catalog, update in-memory state, then persist
   * a `model_change` entry **iff** the identity actually changed along
   * the current branch. The dedupe makes the main-thread's
   * `onSessionLoaded → setModel` re-apply idempotent.
   */
  async setModel(provider: string, modelId: string): Promise<Model<Api>> {
    const resolved = await this.resolveModel(provider, modelId);
    if (!resolved) {
      throw new Error(
        `Model not registered: ${provider}/${modelId}. The provider's catalog did not return a matching entry.`
      );
    }
    this.session.setModel(resolved);
    const sm = this.sessionManager;
    if (sm) {
      const current = sm.buildSessionContext().model;
      const unchanged =
        current !== null && current.provider === provider && current.modelId === modelId;
      if (!unchanged) {
        // Serialise on writeChain so appendModelChange can't race with
        // appendMessage and produce a dangling parentId. Do NOT emit
        // session_loaded here — a model_change entry doesn't shift any
        // message entry ids, and emitting mid-stream would reset the
        // main thread's streamingMessage/isStreaming state. Await the
        // chain so callers observe the persisted state before the next
        // prompt fires (mirrors coding-agent's synchronous
        // `appendModelChange` inside `AgentSession.setModel`).
        this.writeChain = this.writeChain
          .then(async () => {
            await sm.appendModelChange(provider, modelId);
          })
          .catch(err => {
            console.error('[WorkerAgentHost] appendModelChange failed:', err);
          });
        await this.writeChain;
      }
    }
    return resolved;
  }
  /**
   * Return the Worker's authoritative model catalog. Delegates directly
   * to the injected provider — for Bodhi this round-trips
   * `/bodhi/v1/models` on every call.
   */
  getAvailableModels(): Promise<Model<Api>[]> {
    return this.provider.getAvailableModels();
  }
  private async resolveModel(provider: string, modelId: string): Promise<Model<Api> | undefined> {
    const catalog = await this.provider.getAvailableModels();
    return catalog.find(m => m.provider === provider && m.id === modelId);
  }
  /**
   * Restore the in-memory model from a persisted branch. No side effect
   * on the session's JSONL transcript — the caller has already read
   * `ctx.model` from `buildSessionContext`, so there is nothing to append.
   * If the provider's catalog can't resolve the identifier (e.g. the
   * model was removed upstream since the branch was recorded), leaves
   * the session's model undefined and lets the main thread's
   * first-available fallback take over.
   */
  private async restoreModelFromContext(
    ctxModel: { provider: string; modelId: string } | null
  ): Promise<void> {
    if (!ctxModel) {
      this.session.setModel(undefined);
      return;
    }
    const resolved = await this.resolveModel(ctxModel.provider, ctxModel.modelId);
    this.session.setModel(resolved);
  }
  setSystemPrompt(prompt: string): void {
    this.session.setSystemPrompt(prompt);
  }
  reset(): void {
    this.session.reset();
  }
  getState(): RpcSessionState {
    return this.session.getState();
  }
  getMessages(): AgentMessage[] {
    return this.session.getMessages();
  }
  isStreaming(): boolean {
    return this.session.isStreaming();
  }
  getStreamingMessage(): AgentMessage | undefined {
    return this.session.getStreamingMessage();
  }
  getErrorMessage(): string | undefined {
    return this.session.getErrorMessage();
  }
  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void {
    return this.session.subscribe(handler);
  }

  // ==========================================================================
  // M4 additions
  // ==========================================================================

  /**
   * Rotate the credential on the injected `LlmAuthProvider`. The
   * provider inspects the `provider` tag and decides whether to accept
   * or ignore the payload — so multi-provider hosts remain possible.
   */
  setAuthToken(credential: LlmAuthCredential | null): void {
    this.provider.setAuthToken?.(credential);
  }

  /**
   * Mount the user's FSA directory: build a WebAccess backend wrapping the
   * (cloned) handle and attach it to the VFS port so the main-thread PortFS
   * proxy starts answering. After mount, vault tools are constructed against
   * the worker-local ZenFS and pushed to the agent.
   */
  async mountVault(handle: FileSystemDirectoryHandle): Promise<void> {
    if (this.attachedFs) {
      this.detachVault();
    }
    const webAccessFs = await WebAccess.create({ handle });
    vfs.mount(this.vaultMount, webAccessFs);
    attachFS(asChannel(this.vfsPort), webAccessFs);
    this.attachedFs = {
      detach: () => {
        try {
          detachFS(asChannel(this.vfsPort), webAccessFs);
        } catch {
          // best-effort; channel may already be closed
        }
        try {
          vfs.umount(this.vaultMount);
        } catch {
          // best-effort
        }
      },
    };
    const vaultOps = createZenfsVaultOperations();
    this.vaultOps = vaultOps;
    this.vaultTools = createVaultTools(vaultOps, { cwd: this.vaultMount });
    await this.commands.loadPromptsFromVault(vaultOps, this.vaultMount);
    await this.commands.loadSkillsFromVault(vaultOps, this.vaultMount);
    await this.extensions.loadFromVault();
    this.refreshTools();
    this.rebuildSystemPrompt();
    this.extensions.emitStates();
  }

  /**
   * Mount an InMemory backend pre-populated from the dev seed. Used by the
   * Playwright dev-seed path so e2e tests can exercise the vault without
   * driving `showDirectoryPicker`.
   */
  async mountDevSeed(seed: InMemoryVaultSeed): Promise<void> {
    if (this.attachedFs) this.detachVault();
    await configure({ mounts: {} });
    const memFs = InMemory.create({ label: seed.name });
    vfs.mount(this.vaultMount, memFs);
    const paths = Object.keys(seed.files).sort();
    for (const absPath of paths) {
      const lastSlash = absPath.lastIndexOf('/');
      if (lastSlash > 0) {
        const parent = absPath.slice(0, lastSlash);
        try {
          await fs.promises.mkdir(parent, { recursive: true });
        } catch (err: unknown) {
          if (
            err === null ||
            typeof err !== 'object' ||
            !('code' in err) ||
            (err as { code?: string }).code !== 'EEXIST'
          ) {
            throw err;
          }
        }
      }
      await fs.promises.writeFile(absPath, seed.files[absPath], { encoding: 'utf8' });
    }
    attachFS(asChannel(this.vfsPort), memFs);
    this.attachedFs = {
      detach: () => {
        try {
          detachFS(asChannel(this.vfsPort), memFs);
        } catch {
          // best-effort
        }
      },
    };
    const vaultOps = createZenfsVaultOperations();
    this.vaultOps = vaultOps;
    this.vaultTools = createVaultTools(vaultOps, { cwd: this.vaultMount });
    await this.commands.loadPromptsFromVault(vaultOps, this.vaultMount);
    await this.commands.loadSkillsFromVault(vaultOps, this.vaultMount);
    await this.extensions.loadFromVault();
    this.refreshTools();
    this.rebuildSystemPrompt();
    this.extensions.emitStates();
  }

  async unmountVault(): Promise<void> {
    this.detachVault();
    this.vaultTools = [];
    this.vaultOps = null;
    this.extensions.clear();
    this.commands.clearAll();
    this.refreshTools();
    this.rebuildSystemPrompt();
    this.extensions.emitStates();
  }

  /**
   * Return the plain-data slash-command listing for the main-thread
   * autocomplete palette. Includes builtins first, then prompt
   * templates loaded from the vault.
   */
  listCommands(): SlashCommandInfo[] {
    return this.commands.list();
  }

  /**
   * Rescan `<vaultMount>/.pi/prompts/` (templates) and `<vaultMount>/.pi/skills/`
   * (skill descriptors) and return the refreshed listing. No-op when
   * the vault isn't mounted. Rebuilds the system prompt so skill
   * additions/removals are reflected in the next LLM call without
   * needing a session reset.
   */
  async reloadCommands(): Promise<SlashCommandInfo[]> {
    if (this.attachedFs) {
      const ops = this.vaultOps ?? createZenfsVaultOperations();
      this.vaultOps = ops;
      await this.commands.loadPromptsFromVault(ops, this.vaultMount);
      await this.commands.loadSkillsFromVault(ops, this.vaultMount);
      await this.extensions.loadFromVault();
      this.refreshTools();
      this.rebuildSystemPrompt();
      this.extensions.emitStates();
    }
    return this.commands.list();
  }

  // ==========================================================================
  // M8 — extensions (delegated to ExtensionHostController)
  // ==========================================================================

  listExtensions(): ExtensionDescriptor[] {
    return this.extensions.list();
  }

  setExtensionStates(states: Record<string, boolean>): Promise<ExtensionDescriptor[]> {
    return this.extensions.setStates(states);
  }

  setMcpTools(descriptors: McpToolDescriptor[], invoker: ToolUpcallInvoker): void {
    this.mcpTools = descriptors.map(d => buildMcpProxyTool(d, invoker));
    this.refreshTools();
  }

  // ==========================================================================
  // M5 — session persistence (Dexie-backed)
  // ==========================================================================

  setHostEventSink(sink: HostEventSink): void {
    this.hostEventSink = sink;
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.store.listSessions();
  }

  async loadSession(sessionId: string): Promise<void> {
    this.compactionAbort?.abort();
    await this.writeChain;
    this.session.abort();
    const sm = await SessionManager.load(this.store, sessionId);
    this.sessionManager = sm;
    this.session.reset();
    const ctx = sm.buildSessionContext();
    this.session.restoreMessages(ctx.messages);
    await this.restoreModelFromContext(ctx.model);
    this.emitSessionLoaded();
  }

  async newSession(parentSession?: string): Promise<{ sessionId: string }> {
    this.compactionAbort?.abort();
    await this.writeChain;
    this.session.abort();
    const sm = await SessionManager.create(this.store, {
      parentSession,
      cwd: this.vaultMount,
    });
    this.sessionManager = sm;
    this.session.reset();
    this.session.restoreMessages([]);
    const ctx = sm.buildSessionContext();
    await this.restoreModelFromContext(ctx.model);
    this.emitSessionLoaded();
    return { sessionId: sm.getSessionId() };
  }

  async forkSession(fromEntryId: string): Promise<{ sessionId: string }> {
    const current = this.sessionManager;
    if (!current) throw new Error('No active session to fork from');
    this.compactionAbort?.abort();
    await this.writeChain;
    this.session.abort();
    const forked = await current.fork(fromEntryId);
    this.sessionManager = forked;
    this.session.reset();
    const ctx = forked.buildSessionContext();
    this.session.restoreMessages(ctx.messages);
    await this.restoreModelFromContext(ctx.model);
    this.emitSessionLoaded();
    return { sessionId: forked.getSessionId() };
  }

  async navigateToLeaf(entryId: string): Promise<void> {
    const sm = this.sessionManager;
    if (!sm) throw new Error('No active session');
    this.compactionAbort?.abort();
    await this.writeChain;
    this.session.abort();
    sm.navigateToLeaf(entryId);
    this.session.reset();
    const ctx = sm.buildSessionContext();
    this.session.restoreMessages(ctx.messages);
    await this.restoreModelFromContext(ctx.model);
    this.emitSessionLoaded();
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Capture the parent BEFORE deleting — once the row is gone we can't
    // recover the link from the store. Used for the "delete a fork → land
    // on the parent" UX so users don't get a surprise blank session.
    const wasActive = this.sessionManager?.getSessionId() === sessionId;
    const parentId = wasActive ? this.sessionManager?.getHeader()?.parentSession : undefined;
    await this.store.deleteSession(sessionId);
    if (!wasActive) return;
    if (parentId) {
      const parentRow = await this.store.getSession(parentId);
      if (parentRow) {
        await this.loadSession(parentId);
        return;
      }
    }
    await this.newSession();
  }

  async setSessionName(name: string): Promise<void> {
    const sm = this.sessionManager;
    if (!sm) return;
    await sm.appendSessionInfo(name);
    this.emitSessionLoaded();
  }

  async getSessionMeta(): Promise<SessionMeta | null> {
    const sm = this.sessionManager;
    if (!sm) return null;
    return {
      id: sm.getSessionId(),
      path: null,
      name: sm.getSessionName(),
      cwd: sm.getCwd(),
      parentSession: sm.getHeader()?.parentSession,
    };
  }

  // ==========================================================================
  // M7 — compaction
  // ==========================================================================

  async compactNow(): Promise<void> {
    await this.runCompaction({ force: true });
  }

  /** Auto-compaction: runs after every append if above the token threshold. */
  private async maybeCompact(): Promise<void> {
    if (this.compactionInFlight) return;
    const sm = this.sessionManager;
    if (!sm) return;
    const model = this.session.getModel();
    const contextWindow = this.compactionSettings.contextWindow ?? model?.contextWindow ?? 128_000;
    const messages = sm.buildSessionContext().messages;
    if (!shouldCompact(messages, contextWindow, this.compactionSettings)) return;
    await this.runCompaction({ force: false });
  }

  private async runCompaction(opts: { force: boolean }): Promise<void> {
    const sm = this.sessionManager;
    if (!sm) return;
    if (this.compactionInFlight) return;

    const path = sm.getBranch();
    if (path.length < this.compactionSettings.minEntriesToCompact && !opts.force) return;

    const preparation = prepareCompaction(path, this.compactionSettings, {
      force: opts.force,
    });
    if (!preparation) return;

    this.compactionInFlight = true;
    const abort = new AbortController();
    this.compactionAbort = abort;

    this.hostEventSink?.({ type: 'compaction_start' });

    try {
      const model = this.session.getModel();
      if (!model) throw new Error('No model set — cannot summarize');

      const result = await compactSummarize(preparation, model, {
        provider: this.provider,
        signal: abort.signal,
      });

      if (abort.signal.aborted) return;

      await sm.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details
      );

      const ctx = sm.buildSessionContext();
      this.session.restoreMessages(ctx.messages);
      this.emitSessionLoaded();

      this.hostEventSink?.({
        type: 'compaction_end',
        success: true,
        tokensBefore: result.tokensBefore,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[WorkerAgentHost] compaction failed:', message);
      this.hostEventSink?.({
        type: 'compaction_end',
        success: false,
        errorMessage: message,
      });
    } finally {
      this.compactionInFlight = false;
      this.compactionAbort = null;
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private emitSessionLoaded(): void {
    const sink = this.hostEventSink;
    const sm = this.sessionManager;
    if (!sink || !sm) return;
    const ctx = sm.buildSessionContext();
    // `ctx.model` is stored as `{ provider, modelId }` in the session
    // context; rename to `{ provider, id }` on the wire so it matches
    // the shape of `Model<Api>` entries returned by
    // `get_available_models`. The main thread uses this field directly
    // to hydrate combobox state — no follow-up `get_state` round trip
    // needed (that was the boot-race recovery path the old main-thread
    // push model required).
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.modelId } : null;
    sink({
      type: 'session_loaded',
      sessionId: sm.getSessionId(),
      header: sm.getHeader(),
      name: sm.getSessionName(),
      messages: ctx.messages,
      messageMeta: ctx.messageMeta,
      model,
    });
  }

  private detachVault(): void {
    if (!this.attachedFs) return;
    this.attachedFs.detach();
    this.attachedFs = null;
  }

  private refreshTools(): void {
    const extTools = this.extensions.getWrappedTools();
    this.session.setTools([...this.vaultTools, ...this.mcpTools, ...extTools]);
  }

  /**
   * Rebuild the worker-owned system prompt from the current vault +
   * skills state and push it to the agent session. Called after any
   * lifecycle event that can change what the LLM should see in its
   * preamble (vault mount/unmount, `reloadCommands`). Matches
   * coding-agent's pattern of owning the prompt string inside the
   * agent instead of letting the main thread push it.
   */
  private rebuildSystemPrompt(): void {
    const prompt = buildSystemPrompt({
      cwd: this.attachedFs ? this.vaultMount : undefined,
      skills: this.commands.getSkills(),
      hasReadTool: this.vaultTools.length > 0,
    });
    this.session.setSystemPrompt(prompt);
  }
}

/**
 * Build a tool whose `execute` is just an upcall — no real implementation
 * lives in the Worker. The closure ships back over the agent RPC channel
 * so the main thread (where MCP clients hold the bodhiClient + auth) can
 * service the call.
 */
function buildMcpProxyTool(descriptor: McpToolDescriptor, invoker: ToolUpcallInvoker): AgentTool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters as never,
    async execute(_id: string, args: unknown) {
      const result = await invoker(descriptor.name, args);
      if (
        result &&
        typeof result === 'object' &&
        'content' in (result as Record<string, unknown>)
      ) {
        return result as never;
      }
      return {
        content: [
          { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
        ],
      } as never;
    },
  } as unknown as AgentTool;
}
