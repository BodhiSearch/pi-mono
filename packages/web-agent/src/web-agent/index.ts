/**
 * Public barrel for the web-agent package-to-be.
 *
 * When this directory graduates to its own package (Phase 6), this file
 * becomes the package entry point. For now it re-exports the Phase 1
 * scaffolding that the React app will consume.
 */

export { AgentSession } from './core/agent-session';
export type { AgentSessionOptions } from './core/agent-session';

export { RpcServer } from './rpc/rpc-server';
export type { AgentSessionHost } from './rpc/rpc-server';
export { RpcClient } from './rpc/rpc-client';
export { createInProcessTransportPair } from './rpc/transports/in-process';
export type { Transport } from './rpc/transport';
export type {
  RpcCommand,
  RpcCommandType,
  RpcEventEnvelope,
  RpcMessage,
  RpcResponse,
  RpcSessionState,
} from './rpc/rpc-types';

export { ExtensionRegistry } from './core/extensions/registry';
export type {
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
} from './core/extensions/types';
