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
import {
  compactSummarize,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  shouldCompact,
  type CompactionSettings,
} from '../core/compaction';
import type { LlmAuthCredential, LlmAuthProvider } from '../llm/types';
import { SessionManager } from '../core/session/session-manager';
import type { SessionStore } from '../core/session/store';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { createVaultTools } from '../core/tools';
import { createZenfsVaultOperations } from '../fs/zenfs-operations';
import { VAULT_MOUNT } from '../fs/zenfs-provider';
import type { AgentSessionHost, HostEventSink, ToolUpcallInvoker } from '../rpc/rpc-server';
import type { McpToolDescriptor, RpcSessionState } from '../rpc/rpc-types';
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
  private readonly authProvider: LlmAuthProvider;
  private readonly vaultMount: string;
  private readonly compactionSettings: CompactionSettings;
  /**
   * Model registry seeded from the main thread via `setAvailableModels`.
   * Coding-agent's node Worker owns its `ModelRegistry` via config-file
   * seed at boot; web-agent's Worker gets the catalog pushed from the
   * main thread (only it has the catalog fetcher). Resolution is the
   * same: match by `(provider, id)`.
   */
  private availableModels: Model<Api>[] = [];
  /** Re-entrancy guard for the compaction pipeline. */
  private compactionInFlight = false;
  /** Cancels an in-flight summarisation LLM call on session swaps. */
  private compactionAbort: AbortController | null = null;

  constructor(
    session: AgentSession,
    vfsPort: MessagePort,
    store: SessionStore,
    authProvider: LlmAuthProvider,
    options: WorkerAgentHostOptions = {}
  ) {
    this.session = session;
    this.vfsPort = vfsPort;
    this.store = store;
    this.authProvider = authProvider;
    this.vaultMount = options.vaultMount ?? VAULT_MOUNT;
    this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compactionSettings };
    // Persist user/assistant/toolResult messages on turn boundaries. After
    // each successful append, re-emit `session_loaded` so the main thread's
    // message↔entryId mapping stays aligned (used by per-message Fork /
    // Branch actions).
    this.session.subscribe(event => {
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

  prompt(message: string): Promise<void> {
    return this.session.prompt(message);
  }
  abort(): void {
    this.session.abort();
  }
  /**
   * Set the active model by `(provider, modelId)`. Mirrors coding-agent
   * `AgentSession.setModel` (agent-session.ts:1394-1409): resolve via
   * the Worker's registry, update in-memory state, then persist a
   * `model_change` entry **iff** the identity actually changed along
   * the current branch. The dedupe makes the main-thread's
   * `onSessionLoaded → setModel` re-apply idempotent.
   */
  async setModel(provider: string, modelId: string): Promise<Model<Api>> {
    const resolved = this.findModel(provider, modelId);
    if (!resolved) {
      throw new Error(
        `Model not registered: ${provider}/${modelId}. Seed the registry via setAvailableModels first.`
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
  setAvailableModels(models: Model<Api>[]): void {
    this.availableModels = [...models];
    // Boot-race recovery: a session may have loaded before the catalog
    // was seeded, in which case `restoreModelFromContext` couldn't
    // resolve its persisted `model_change` and left the session model
    // undefined. Re-run the restore + re-emit so the main thread's
    // `onSessionLoaded → getState` sync picks up the now-resolvable
    // identifier. Idempotent when resolution already succeeded.
    const sm = this.sessionManager;
    if (sm) {
      const ctx = sm.buildSessionContext();
      this.restoreModelFromContext(ctx.model);
      this.emitSessionLoaded();
    }
  }
  getAvailableModels(): Model<Api>[] {
    return [...this.availableModels];
  }
  private findModel(provider: string, modelId: string): Model<Api> | undefined {
    return this.availableModels.find(m => m.provider === provider && m.id === modelId);
  }
  /**
   * Restore the in-memory model from a persisted branch. No side effect
   * on the session's JSONL transcript — the caller has already read
   * `ctx.model` from `buildSessionContext`, so there is nothing to append.
   * If the registry can't resolve the identifier (pre-seed or stale
   * entry), leaves the session's model undefined and lets the main
   * thread's first-available fallback take over.
   */
  private restoreModelFromContext(ctxModel: { provider: string; modelId: string } | null): void {
    if (!ctxModel) {
      this.session.setModel(undefined);
      return;
    }
    const resolved = this.findModel(ctxModel.provider, ctxModel.modelId);
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
    this.authProvider.setAuthToken?.(credential);
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
    this.vaultTools = createVaultTools(createZenfsVaultOperations(), { cwd: this.vaultMount });
    this.refreshTools();
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
    this.vaultTools = createVaultTools(createZenfsVaultOperations(), { cwd: this.vaultMount });
    this.refreshTools();
  }

  async unmountVault(): Promise<void> {
    this.detachVault();
    this.vaultTools = [];
    this.refreshTools();
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
    this.restoreModelFromContext(ctx.model);
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
    this.restoreModelFromContext(ctx.model);
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
    this.restoreModelFromContext(ctx.model);
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
    this.restoreModelFromContext(ctx.model);
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
        authProvider: this.authProvider,
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
    sink({
      type: 'session_loaded',
      sessionId: sm.getSessionId(),
      header: sm.getHeader(),
      name: sm.getSessionName(),
      messages: ctx.messages,
      messageMeta: ctx.messageMeta,
    });
  }

  private detachVault(): void {
    if (!this.attachedFs) return;
    this.attachedFs.detach();
    this.attachedFs = null;
  }

  private refreshTools(): void {
    this.session.setTools([...this.vaultTools, ...this.mcpTools]);
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
