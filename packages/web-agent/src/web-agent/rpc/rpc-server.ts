import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { deserializeError, serializeError } from './error';
import type {
  McpToolDescriptor,
  RpcAgentEventEnvelope,
  RpcCommand,
  RpcCommandType,
  RpcResponse,
  RpcSessionState,
  RpcToolCallRequest,
} from './rpc-types';
import type { Transport } from './transport';

/**
 * Narrow interface of the session surface the RPC server drives.
 *
 * `AgentSession` satisfies this structurally. Isolating the shape as an
 * interface keeps the server independent of its default implementation,
 * which lets tests drive the server with a fake session without dragging
 * in `pi-agent-core`'s full Agent machinery.
 */
export interface AgentSessionHost {
  prompt(message: string): Promise<void>;
  abort(): void;
  setModel(model: Model<Api> | undefined): void;
  setSystemPrompt(prompt: string): void;
  reset(): void;
  getState(): RpcSessionState;
  getMessages(): AgentMessage[];
  isStreaming(): boolean;
  getStreamingMessage(): AgentMessage | undefined;
  getErrorMessage(): string | undefined;
  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void;
  // M4 additions — present in the real session, optional on test fakes.
  setAuthToken?(token: string | null): void;
  mountVault?(handle: FileSystemDirectoryHandle): Promise<void>;
  unmountVault?(): Promise<void>;
  setMcpTools?(tools: McpToolDescriptor[], invoker: ToolUpcallInvoker): void;
}

/**
 * Function the host provides for invoking a tool that lives on the other side
 * of the RPC boundary. Worker-side AgentSession's MCP tool stubs call this;
 * the server emits a `tool_call_request` event and resolves when the matching
 * `tool_call_response` command arrives.
 */
export type ToolUpcallInvoker = (toolName: string, args: unknown) => Promise<unknown>;

/**
 * Binds a `Transport` to an `AgentSession`.
 *
 * Incoming RpcCommand messages are dispatched to session methods; the
 * correlated RpcResponse is sent back on the same transport. AgentEvents
 * emitted by the session are wrapped in an RpcAgentEventEnvelope (with a
 * state snapshot) and pushed to the transport unsolicited. MCP tool calls
 * upcall to the client via `tool_call_request`/`tool_call_response`.
 */
export class RpcServer {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly upcallPending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private upcallCounter = 0;
  private disposed = false;

  private readonly transport: Transport;
  private readonly session: AgentSessionHost;

  constructor(transport: Transport, session: AgentSessionHost) {
    this.transport = transport;
    this.session = session;
    this.unsubscribers.push(
      transport.onMessage(raw => {
        void this.handleCommand(raw);
      })
    );

    this.unsubscribers.push(
      session.subscribe(event => {
        if (this.disposed) return;
        const envelope: RpcAgentEventEnvelope = {
          type: 'event',
          event,
          messages: session.getMessages(),
          isStreaming: session.isStreaming(),
          streamingMessage: session.getStreamingMessage(),
          errorMessage: session.getErrorMessage(),
        };
        transport.send(envelope);
      })
    );
  }

  private async handleCommand(raw: unknown): Promise<void> {
    if (!isRpcCommand(raw)) return;
    const { id, type } = raw;
    try {
      switch (type) {
        case 'prompt':
          await this.session.prompt(raw.message);
          this.transport.send(ok(id, 'prompt'));
          return;
        case 'abort':
          this.session.abort();
          this.transport.send(ok(id, 'abort'));
          return;
        case 'get_state':
          this.transport.send({
            id,
            type: 'response',
            command: 'get_state',
            success: true,
            data: this.session.getState(),
          } satisfies RpcResponse);
          return;
        case 'get_messages':
          this.transport.send({
            id,
            type: 'response',
            command: 'get_messages',
            success: true,
            data: this.session.getMessages(),
          } satisfies RpcResponse);
          return;
        case 'set_model':
          this.session.setModel(raw.model);
          this.transport.send(ok(id, 'set_model'));
          return;
        case 'set_system_prompt':
          this.session.setSystemPrompt(raw.prompt);
          this.transport.send(ok(id, 'set_system_prompt'));
          return;
        case 'reset':
          this.session.reset();
          this.transport.send(ok(id, 'reset'));
          return;
        case 'set_auth_token':
          this.session.setAuthToken?.(raw.token);
          this.transport.send(ok(id, 'set_auth_token'));
          return;
        case 'mount_vault':
          await (this.session.mountVault?.(raw.handle) ?? Promise.resolve());
          this.transport.send(ok(id, 'mount_vault'));
          return;
        case 'unmount_vault':
          await (this.session.unmountVault?.() ?? Promise.resolve());
          this.transport.send(ok(id, 'unmount_vault'));
          return;
        case 'set_mcp_tools':
          this.session.setMcpTools?.(raw.tools, (toolName, args) =>
            this.invokeUpcall(toolName, args)
          );
          this.transport.send(ok(id, 'set_mcp_tools'));
          return;
        case 'tool_call_response': {
          const pending = this.upcallPending.get(raw.callId);
          if (pending) {
            this.upcallPending.delete(raw.callId);
            if (raw.ok) pending.resolve(raw.result);
            else pending.reject(deserializeError(raw.error));
          }
          this.transport.send(ok(id, 'tool_call_response'));
          return;
        }
      }
    } catch (err) {
      this.transport.send({
        id,
        type: 'response',
        command: type,
        success: false,
        error: serializeError(err),
      } satisfies RpcResponse);
    }
  }

  private invokeUpcall(toolName: string, args: unknown): Promise<unknown> {
    const callId = `upcall-${++this.upcallCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      this.upcallPending.set(callId, { resolve, reject });
      const request: RpcToolCallRequest = {
        type: 'tool_call_request',
        callId,
        toolName,
        args,
      };
      this.transport.send(request);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
    for (const p of this.upcallPending.values()) {
      p.reject(new Error('RpcServer disposed'));
    }
    this.upcallPending.clear();
  }
}

function ok<C extends Exclude<RpcCommandType, 'get_state' | 'get_messages'>>(
  id: string,
  command: C
): RpcResponse {
  return { id, type: 'response', command, success: true } as RpcResponse;
}

function isRpcCommand(value: unknown): value is RpcCommand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.type === 'string' && isKnownCommandType(v.type);
}

const KNOWN_COMMANDS: Record<RpcCommandType, true> = {
  prompt: true,
  abort: true,
  get_state: true,
  get_messages: true,
  set_model: true,
  set_system_prompt: true,
  reset: true,
  set_auth_token: true,
  mount_vault: true,
  unmount_vault: true,
  set_mcp_tools: true,
  tool_call_response: true,
};

function isKnownCommandType(value: string): value is RpcCommandType {
  return Object.hasOwn(KNOWN_COMMANDS, value);
}
