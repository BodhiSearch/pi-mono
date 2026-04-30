import type { BodhiProvider } from '@/agent/bodhi-provider';
import type { CommandsFs } from '@/agent/commands';
import { createZenfsCommandsFs } from '@/agent/commands';
import type { InlineAgent } from '@/agent/inline-agent';
import { McpConnectionPool } from '@/agent/mcp';
import type { SessionStore } from '@/agent/session-store';
import type { StreamOptionOverrides } from '@/agent/stream-fn';
import type { VolumeRegistry } from '@/agent/volume-mount';
import type { FeatureStore } from '@/features/feature-store';
import type { McpToggleStore } from '@/mcp/toggle-store';

/**
 * Per-turn override holder threaded between the adapter and the
 * stream function. The adapter pushes `toolChoice` into this bag
 * before each `prompt` turn (DEV-only forceToolCall feature) and
 * the stream function clears it after the first LLM call.
 */
export interface StreamOverridesRef {
  current: StreamOptionOverrides;
}

/**
 * Infrastructure bag the adapter consumes. Built once per worker
 * boot via `assembleServices()`. Mirrors coding-agent's
 * `AgentSessionServices` (see `core/agent-session-services.ts`).
 *
 * Required fields are infrastructure the adapter cannot run without
 * (`inline`, `bodhi`, `mcpPool`, `commandsFs`); optional fields are
 * stores that gate features (no `store` ⇒ no persistence; no
 * `registry` ⇒ no vault tools; etc.).
 */
export interface AcpAdapterServices {
  inline: InlineAgent;
  bodhi: BodhiProvider;
  mcpPool: McpConnectionPool;
  commandsFs: CommandsFs;
  store?: SessionStore;
  registry?: VolumeRegistry;
  features?: FeatureStore;
  mcpToggles?: McpToggleStore;
  streamOverrides?: StreamOverridesRef;
}

export interface AssembleServicesOptions {
  inline: InlineAgent;
  bodhi: BodhiProvider;
  store?: SessionStore;
  registry?: VolumeRegistry;
  features?: FeatureStore;
  mcpToggles?: McpToggleStore;
  streamOverrides?: StreamOverridesRef;
  mcpPool?: McpConnectionPool;
  commandsFs?: CommandsFs;
}

/**
 * Assemble the services bag the adapter constructor consumes.
 * Defaults `mcpPool` to a fresh pool and `commandsFs` to the ZenFS
 * implementation — these always have a sensible default and the
 * caller doesn't gain anything from constructing them explicitly.
 */
export function assembleServices(opts: AssembleServicesOptions): AcpAdapterServices {
  return {
    inline: opts.inline,
    bodhi: opts.bodhi,
    mcpPool: opts.mcpPool ?? new McpConnectionPool(),
    commandsFs: opts.commandsFs ?? createZenfsCommandsFs(),
    store: opts.store,
    registry: opts.registry,
    features: opts.features,
    mcpToggles: opts.mcpToggles,
    streamOverrides: opts.streamOverrides,
  };
}
