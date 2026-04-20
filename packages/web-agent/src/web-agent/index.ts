/**
 * Public barrel for the web-agent package-to-be.
 *
 * When this directory graduates to its own package (Phase 6), this file
 * becomes the package entry point. For now it re-exports the pieces the
 * React app and tests consume.
 */

export { AgentSession } from './core/agent-session';
export type { AgentSessionOptions } from './core/agent-session';

export { RpcServer } from './rpc/rpc-server';
export type { AgentSessionHost, ToolUpcallInvoker } from './rpc/rpc-server';
export { RpcClient } from './rpc/rpc-client';
export type { ToolCallHandler } from './rpc/rpc-client';
export { createInProcessTransportPair } from './rpc/transports/in-process';
export { createWorkerTransportPair } from './rpc/transports/worker';
export type {
  CreateWorkerTransportPairOptions,
  WorkerTransportPair,
} from './rpc/transports/worker';
export type { Transport } from './rpc/transport';
export type {
  McpToolDescriptor,
  RpcAgentEventEnvelope,
  RpcCommand,
  RpcCommandType,
  RpcEventEnvelope,
  RpcMessage,
  RpcResponse,
  RpcSessionState,
  RpcToolCallRequest,
} from './rpc/rpc-types';
export type { SerializedError } from './rpc/error';
export { serializeError, deserializeError } from './rpc/error';

// Worker boot — main-thread side.
export { disposeAgentWorker, getAgentWorker, _resetAgentWorkerForTests } from './worker/boot';
export type { AgentWorkerBoot } from './worker/boot';
export type { AgentWorkerInit, InMemoryVaultSeed } from './worker/init-protocol';
export { AGENT_WORKER_INIT_TYPE, isAgentWorkerInit } from './worker/init-protocol';
export { WorkerAgentHost } from './worker/worker-host';

export { ExtensionRegistry } from './core/extensions/registry';

// Vault filesystem tools — exported for the Worker to instantiate
// against its local ZenFS, and for tests.
export { createVaultTools } from './core/tools';
export type { CreateVaultToolsOptions } from './core/tools';
export { createZenfsVaultOperations } from './fs/zenfs-operations';
export type {
  EditOperations,
  GlobOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  VaultOperations,
  WriteOperations,
} from './fs/zenfs-operations';
export { fs, isVaultMounted, mountVaultPort, unmountVault, VAULT_MOUNT } from './fs/zenfs-provider';
export { resolveVaultPath, VaultPathError } from './fs/path-utils';
export type {
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
} from './core/extensions/types';
