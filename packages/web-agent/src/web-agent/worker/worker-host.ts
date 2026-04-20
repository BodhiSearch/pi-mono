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
import { SessionManager } from '../core/session/session-manager';
import type { SessionStore } from '../core/session/store';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { createVaultTools } from '../core/tools';
import { createZenfsVaultOperations } from '../fs/zenfs-operations';
import { VAULT_MOUNT } from '../fs/zenfs-provider';
import type { AgentSessionHost, HostEventSink, ToolUpcallInvoker } from '../rpc/rpc-server';
import type { McpToolDescriptor, RpcSessionState } from '../rpc/rpc-types';
import type { InMemoryVaultSeed } from './init-protocol';

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

  constructor(session: AgentSession, vfsPort: MessagePort, store: SessionStore) {
    this.session = session;
    this.vfsPort = vfsPort;
    this.store = store;
    // Persist user/assistant/toolResult messages on turn boundaries.
    this.session.subscribe(event => {
      if (event.type !== 'message_end') return;
      const sm = this.sessionManager;
      if (!sm) return;
      const role = (event.message as { role?: string }).role;
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return;
      this.writeChain = this.writeChain
        .then(() => sm.appendMessage(event.message))
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
  setModel(model: Model<Api> | undefined): void {
    this.session.setModel(model);
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

  setAuthToken(token: string | null): void {
    this.session.setAuthToken(token);
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
    vfs.mount(VAULT_MOUNT, webAccessFs);
    attachFS(asChannel(this.vfsPort), webAccessFs);
    this.attachedFs = {
      detach: () => {
        try {
          detachFS(asChannel(this.vfsPort), webAccessFs);
        } catch {
          // best-effort; channel may already be closed
        }
        try {
          vfs.umount(VAULT_MOUNT);
        } catch {
          // best-effort
        }
      },
    };
    this.vaultTools = createVaultTools(createZenfsVaultOperations());
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
    vfs.mount(VAULT_MOUNT, memFs);
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
    this.vaultTools = createVaultTools(createZenfsVaultOperations());
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

  /**
   * Swap the active session to `sessionId`. Rebuilds the in-memory tree from
   * the store, resets the agent's message buffer, then rehydrates it from the
   * persisted entries. Emits a synthetic `session_loaded` event so the main
   * thread can refresh its UI from one envelope.
   */
  async loadSession(sessionId: string): Promise<void> {
    const sm = await SessionManager.load(this.store, sessionId);
    this.sessionManager = sm;
    this.session.reset();
    const ctx = sm.buildSessionContext();
    this.session.restoreMessages(ctx.messages);
    this.emitSessionLoaded();
  }

  async newSession(parentSession?: string): Promise<{ sessionId: string }> {
    const sm = await SessionManager.create(this.store, {
      parentSession,
      cwd: VAULT_MOUNT,
    });
    this.sessionManager = sm;
    this.session.reset();
    this.session.restoreMessages([]);
    this.emitSessionLoaded();
    return { sessionId: sm.getSessionId() };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.store.deleteSession(sessionId);
    if (this.sessionManager?.getSessionId() === sessionId) {
      // Active session gone — spin up a fresh one so the next prompt lands
      // somewhere sane. Main-thread UI will react via session_loaded.
      await this.newSession();
    }
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
  // Internals
  // ==========================================================================

  private emitSessionLoaded(): void {
    const sink = this.hostEventSink;
    const sm = this.sessionManager;
    if (!sink || !sm) return;
    sink({
      type: 'session_loaded',
      sessionId: sm.getSessionId(),
      header: sm.getHeader(),
      name: sm.getSessionName(),
      messages: sm.buildSessionContext().messages,
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
