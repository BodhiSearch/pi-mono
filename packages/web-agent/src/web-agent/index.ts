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

// Vault filesystem tools
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
export { mountVault, unmountVault, isVaultMounted, VAULT_MOUNT } from './fs/zenfs-provider';
export { resolveVaultPath, VaultPathError } from './fs/path-utils';
export type {
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
} from './core/extensions/types';
