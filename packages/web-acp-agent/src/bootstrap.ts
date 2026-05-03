import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter, type AcpAgentAdapterOptions } from './acp/agent-adapter';
import type { AcpAdapterServices } from './acp/engine/services';

export interface AcpTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface StartAcpAgentOptions extends AcpAgentAdapterOptions {
  /** Optional callback invoked with the adapter so the host can dispose it on teardown. */
  onAdapter?: (adapter: AcpAgentAdapter) => void;
}

/**
 * Bootstrap a single ACP agent on a transport.
 *
 * The host is responsible for assembling the `services` bag (inline
 * runtime, BodhiProvider, persistence stores, volume registry, etc.)
 * and providing a transport (browser worker `MessagePort` adapter,
 * Node stdio adapter, HTTP/SSE adapter, …). The agent package owns
 * everything beyond the transport boundary.
 *
 * Returns the live `AgentSideConnection`. The `AcpAgentAdapter`
 * instance is forwarded via `options.onAdapter` so callers can call
 * `dispose()` on teardown without a second factory step.
 */
export function startAcpAgent(
  transport: AcpTransport,
  services: AcpAdapterServices,
  options: StartAcpAgentOptions
): AgentSideConnection {
  const stream = ndJsonStream(transport.writable, transport.readable);
  return new AgentSideConnection(conn => {
    const adapter = new AcpAgentAdapter(conn, services, {
      isDev: options.isDev,
      buildVersion: options.buildVersion,
      acpSdkVersion: options.acpSdkVersion,
    });
    options.onAdapter?.(adapter);
    return adapter;
  }, stream);
}
