import type { LlmProvider } from '../../agent/bodhi-provider';
import type { CommandsFs } from '../../agent/commands';
import { createZenfsCommandsFs } from '../../agent/commands';
import type { ExtensionRegistry, ExtensionsWriteFs } from '../../agent/extensions';
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

/**
 * Late-bound active-session pointer. Driver writes the current
 * `params.sessionId` here before each LLM call so the stream
 * function can route provider hooks (`before_provider_request` /
 * `after_provider_response`) at the right registry session.
 */
export interface ActiveSessionRef {
  current: string | null;
}

// Required fields are mandatory infrastructure; optional fields
// gate features (no `store` ⇒ no persistence; no `registry` ⇒ no
// vault tools; no `extensions` ⇒ extension subsystem disabled).
export interface AcpAdapterServices {
  inline: InlineAgent;
  bodhi: LlmProvider;
  mcpPool: McpConnectionPool;
  commandsFs: CommandsFs;
  store?: SessionStore;
  registry?: VolumeRegistry;
  extensions?: ExtensionRegistry;
  /**
   * Writable counterpart to the loader's `ExtensionsFs`. Required to
   * service `_bodhi/extensions/add`; absent when the host doesn't ship
   * an install path (CLI hosts, headless tests). Without it the
   * ext-method returns a `extensions:write-fs-missing` error.
   */
  extensionsWriteFs?: ExtensionsWriteFs;
  preferences?: PreferenceStore;
  streamOverrides?: StreamOverridesRef;
  activeSession?: ActiveSessionRef;
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
  extensions?: ExtensionRegistry;
  extensionsWriteFs?: ExtensionsWriteFs;
  preferences?: PreferenceStore;
  streamOverrides?: StreamOverridesRef;
  activeSession?: ActiveSessionRef;
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
    extensions: opts.extensions,
    extensionsWriteFs: opts.extensionsWriteFs,
    preferences: opts.preferences,
    streamOverrides: opts.streamOverrides,
    activeSession: opts.activeSession,
  };
}
