// Public barrel for `@bodhiapp/web-acp-agent`.
//
// Hosts call `startAgent({ transport, provider, ... })` and (for
// in-process embeds) `createInMemoryDuplex()`. Everything else
// here is host-implementable surface (storage interfaces, providers,
// volume registry) or wire constants for the `_bodhi/*` extensions.
//
// SDK types come from `@agentclientprotocol/sdk` directly; advanced
// surface (AcpAgentAdapter, assembleServices, InlineAgent) lives
// at `@bodhiapp/web-acp-agent/test-utils`.

export { startAgent, createInMemoryDuplex } from './api';
export type { AcpTransport, InMemoryDuplex, StartAgentHandle, StartAgentOptions } from './api';

export {
  apiFormatOfModel,
  BODHI_PROVIDER_TAG,
  BodhiProvider,
  type LlmAuthCredential,
  type LlmProvider,
} from './agent/bodhi-provider';

export {
  type VolumeInit,
  type VolumeRegistry,
  type VolumeRegistryListener,
  type VolumeSnapshot,
  ZenfsVolumeRegistry,
} from './agent/volume-registry';
export { WELL_KNOWN_VOLUME_TAGS, type WellKnownVolumeTag } from './agent/well-known-volume-tags';

export {
  createZenfsExtensionsFs,
  createZenfsExtensionsWriteFs,
  DEFAULT_NPM_REGISTRY,
  type Disposable as ExtensionDisposable,
  EXTENSIONS_DIR_RELPATH,
  type ExtensionAPI,
  type ExtensionCapabilities,
  type ExtensionEvent,
  type ExtensionEventHandler,
  type ExtensionFactory,
  type ExtensionInfo,
  ExtensionRegistry,
  type ExtensionsFs,
  type ExtensionsFsEntry,
  type ExtensionsWriteFs,
  installExtensionFromNpm,
  type InstallExtensionInput,
  type InstalledExtension,
  localExtensionDirName,
  type NpmPackageSpec,
  parseNpmPackageSpec,
} from './agent/extensions';

export {
  EXTENSIONS_DISABLED_KEY,
  EXTENSIONS_DISABLED_SCOPE,
  readDisabledExtensions,
  writeDisabledExtensions,
} from './agent/internal/extensions-prefs';

export {
  COMMANDS_DIR_RELPATH,
  type CommandDef,
  type CommandSource,
  canonicalCommandName,
  type FrontMatter,
  PROMPTS_DIR_RELPATH,
} from './agent/commands';

// Slash-command discovery surface for host UIs (e.g. CLI help screens).
export { builtinAvailableCommands, isBuiltinName } from './agent/commands/builtins';

// Storage interfaces — host implements when it wants persistence.
export type { PreferenceStore } from './storage/preference-store';
export {
  FEATURE_DEFAULTS,
  type FeatureDefaults,
  type FeatureKey,
  type FeatureSnapshot,
  isFeatureKey,
} from './storage/feature-defaults';
export {
  EMPTY_MCP_TOGGLES,
  isServerEnabled,
  isToolEnabled,
  type McpToggleSnapshot,
} from './storage/mcp-toggle-shape';
export {
  type BuiltinPayload,
  deriveTitle,
  type ExtensionPayload,
  type SessionEntry,
  type SessionEntryKind,
  type SessionRow,
  type SessionStore,
  type SessionSummary,
  type TurnPayload,
} from './storage/session-store';

export { canonicalizeMcpUrl, deriveSlugFromUrl } from './mcp/url-canonical';

// `_bodhi/*` wire constants + request/response types.
export {
  BODHI_AUTH_METHOD_ID,
  BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
  BODHI_EXTENSIONS_ADD_METHOD,
  BODHI_EXTENSIONS_LIST_METHOD,
  BODHI_EXTENSIONS_RELOAD_METHOD,
  BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD,
  BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
  BODHI_FEATURE_CONFIG_CATEGORY,
  BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
  BODHI_MCP_STATE_NOTIFICATION_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
} from './wire';
export type {
  AnyBodhiBuiltinAction,
  BodhiAuthenticateMeta,
  BodhiAuthenticateResponseMeta,
  BodhiBuiltinAction,
  BodhiBuiltinActionNotificationParams,
  BodhiBuiltinCopyAction,
  BodhiBuiltinMcpAddAction,
  BodhiBuiltinMcpRemoveAction,
  BodhiBuiltinTag,
  BodhiExtensionCapabilities,
  BodhiExtensionDescriptor,
  BodhiExtensionsAddRequest,
  BodhiExtensionsAddResponse,
  BodhiExtensionsListResponse,
  BodhiExtensionsReloadRequest,
  BodhiExtensionsReloadResponse,
  BodhiExtensionsStateNotificationParams,
  BodhiLoadSessionMeta,
  BodhiMcpInstanceDescriptor,
  BodhiMcpStateNotificationParams,
  BodhiMcpToggleSnapshot,
  BodhiMcpTogglesSetRequest,
  BodhiMcpTogglesSetResponse,
  BodhiMcpUrlParams,
  BodhiServerInfoResponse,
  BodhiSessionInfoMeta,
  BodhiSessionMeta,
  BodhiSessionsDeleteRequest,
  BodhiSessionsDeleteResponse,
  BodhiVolumeDescriptor,
  BodhiVolumesListResponse,
} from './wire';
