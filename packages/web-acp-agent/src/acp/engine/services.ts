import type { LlmProvider } from '../../agent/bodhi-provider';
import type { CommandsFs } from '../../agent/commands';
import { createZenfsCommandsFs } from '../../agent/commands';
import type { InlineAgent } from '../../agent/inline-agent';
import { McpConnectionPool } from '../../agent/mcp';
import type { StreamOptionOverrides } from '../../agent/stream-fn';
import type { VolumeRegistry } from '../../agent/volume-registry';
import type { PreferenceStore } from '../../storage/preference-store';
import type { SessionStore } from '../../storage/session-store';

// Per-turn override bag. Adapter sets before prompt; stream fn
// clears after the first LLM call.
export interface StreamOverridesRef {
  current: StreamOptionOverrides;
}

// Required fields are mandatory infrastructure; optional fields
// gate features (no `store` ⇒ no persistence; no `registry` ⇒ no
// vault tools).
export interface AcpAdapterServices {
  inline: InlineAgent;
  bodhi: LlmProvider;
  mcpPool: McpConnectionPool;
  commandsFs: CommandsFs;
  store?: SessionStore;
  registry?: VolumeRegistry;
  preferences?: PreferenceStore;
  streamOverrides?: StreamOverridesRef;
  /**
   * Cached return value of the last `LlmProvider.setAuthToken` call.
   * Surfaces in `AuthenticateResponse._meta.bodhi.providerInfo` and
   * is read by the `/info` builtin command. Mutated by
   * `handleAuthenticate`; opaque to the engine.
   */
  lastProviderInfo?: unknown;
}

export interface AssembleServicesOptions {
  inline: InlineAgent;
  bodhi: LlmProvider;
  store?: SessionStore;
  registry?: VolumeRegistry;
  preferences?: PreferenceStore;
  streamOverrides?: StreamOverridesRef;
  mcpPool?: McpConnectionPool;
  commandsFs?: CommandsFs;
}

export function assembleServices(opts: AssembleServicesOptions): AcpAdapterServices {
  return {
    inline: opts.inline,
    bodhi: opts.bodhi,
    mcpPool: opts.mcpPool ?? new McpConnectionPool(),
    commandsFs: opts.commandsFs ?? createZenfsCommandsFs(),
    store: opts.store,
    registry: opts.registry,
    preferences: opts.preferences,
    streamOverrides: opts.streamOverrides,
  };
}
