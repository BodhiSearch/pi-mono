/**
 * Worker-side AgentSessionHost implementation.
 *
 * Wraps a single `AgentSession`, owns the ZenFS attach/detach lifecycle on
 * the VFS port, and constructs MCP proxy tools that upcall to the main
 * thread for execution.
 */

import { attachFS, configure, detachFS, fs, InMemory, vfs } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import type { AgentEvent, AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { AgentSession } from '../core/agent-session';
import { createVaultTools } from '../core/tools';
import { createZenfsVaultOperations } from '../fs/zenfs-operations';
import { VAULT_MOUNT } from '../fs/zenfs-provider';
import type { AgentSessionHost, ToolUpcallInvoker } from '../rpc/rpc-server';
import type { McpToolDescriptor, RpcSessionState } from '../rpc/rpc-types';
import type { InMemoryVaultSeed } from './init-protocol';

// ZenFS's `Channel` type union includes WebSocket which makes structural
// matching against the browser's MessagePort fail. At runtime `RPC.from`
// detects MessagePort via `addEventListener in port`, so the cast is safe.
type ZenfsChannel = Parameters<typeof attachFS>[0];
const asChannel = (port: MessagePort): ZenfsChannel => port as unknown as ZenfsChannel;

export interface WorkerHostOptions {
  session: AgentSession;
  vfsPort: MessagePort;
}

export class WorkerAgentHost implements AgentSessionHost {
  private vaultTools: AgentTool[] = [];
  private mcpTools: AgentTool[] = [];
  private attachedFs: { detach: () => void } | null = null;

  private readonly session: AgentSession;
  private readonly vfsPort: MessagePort;

  constructor(session: AgentSession, vfsPort: MessagePort) {
    this.session = session;
    this.vfsPort = vfsPort;
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
  // Internals
  // ==========================================================================

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
