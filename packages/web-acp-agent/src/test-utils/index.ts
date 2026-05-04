// Test-only surface. Not part of the production embed API — host test
// suites import these to drive the engine layer directly without going
// through the `startAgent` boot helper.
export type { SeedSpec } from './seed-volume';
export { buildSeedInit } from './seed-volume';

export { AcpAgentAdapter, type AcpAgentAdapterOptions } from '../acp/agent-adapter';
export {
  type AcpAdapterServices,
  type AssembleServicesOptions,
  assembleServices,
} from '../acp/engine/services';
export { createInlineAgent, type InlineAgent } from '../agent/inline-agent';
export { createStreamFn } from '../agent/stream-fn';
export { McpConnectionPool } from '../agent/mcp';
export { type CommandsFs, type CommandsFsEntry, createZenfsCommandsFs } from '../agent/commands';
export { mcpToggleStoreOverPreferences } from '../storage/in-memory/preference-adapters';
export { createInMemoryPreferenceStore } from '../storage/in-memory/preference-store';
