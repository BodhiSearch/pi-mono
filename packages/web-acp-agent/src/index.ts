// Public barrel for `@bodhiapp/web-acp-agent`.
//
// Two layers of consumer:
//   - host runtimes (browser worker, Node CLI) call `startAcpAgent`
//     with a transport + services bag and never touch the internals;
//   - tests / advanced hosts may import `AcpAgentAdapter`,
//     `assembleServices`, the wire constants, or the `*Provider` /
//     `*Store` interfaces directly.

export { AcpAgentAdapter, type AcpAgentAdapterOptions } from "./acp/agent-adapter";
export {
	type AcpAdapterServices,
	type AssembleServicesOptions,
	assembleServices,
	type StreamOverridesRef,
} from "./acp/engine/services";
export { AcpSessionRuntime } from "./acp/engine/session-runtime";
export type { ExtMethodHost, SessionState } from "./acp/engine/types";
export { requestPermissionStub } from "./acp/permissions";
export {
	extractAssistantText,
	extractMessageId,
	extractSessionMeta,
	filterHttpServers,
	makeBuiltinAssistantMessage,
	makeBuiltinUserMessage,
	toAvailableCommand,
	toolTitle,
	toToolCallContent,
	toWireMcpToggles,
} from "./acp/wire-utils";
export {
	apiFormatOfModel,
	BODHI_PROVIDER_TAG,
	BodhiProvider,
	type LlmAuthCredential,
	type LlmProvider,
} from "./agent/bodhi-provider";
export {
	COMMANDS_DIR_RELPATH,
	type CommandDef,
	type CommandSource,
	type CommandsFs,
	type CommandsFsEntry,
	type CommandsLoaderInput,
	canonicalCommandName,
	createZenfsCommandsFs,
	type ExpansionResult,
	expandCommand,
	type FrontMatter,
	loadCommandsFromVolumes,
	loadPromptsFromVolumes,
	type ParseResult,
	PROMPTS_DIR_RELPATH,
	parseFrontMatter,
} from "./agent/commands";
export {
	type BuiltinAction,
	type BuiltinCommand,
	type BuiltinHandlerCtx,
	type BuiltinMcpInstance,
	type BuiltinResult,
	builtinAvailableCommands,
	findBuiltin,
	isBuiltinName,
} from "./agent/commands/builtins";
export {
	createInlineAgent,
	type InlineAgent,
	type InlineAgentSetModelOptions,
} from "./agent/inline-agent";
export {
	type CreateMcpClientResult,
	createMcpAgentTool,
	createMcpClient,
	MCP_TOOL_NAME_SEPARATOR,
	type McpAcquireResult,
	McpConnectionPool,
	type McpPoolEvent,
	type McpPoolEventType,
	type McpPoolListener,
	type McpToolAdapterDeps,
	type McpToolDescriptor,
	type McpToolDetails,
	mcpToolName,
} from "./agent/mcp";
export {
	createStreamFn,
	type StreamOptionOverrides,
	type StreamOverrideProvider,
} from "./agent/stream-fn";
export { composeSystemPrompt } from "./agent/system-prompt";

export {
	BASH_OUTPUT_BYTE_LIMIT,
	type BashToolDeps,
	type BashToolDetails,
	type BashToolInput,
	createBashTool,
} from "./agent/tools/bash-tool";
export { VolumeFileSystem } from "./agent/tools/volume-filesystem";
export {
	type VolumeInit,
	type VolumeRegistry,
	type VolumeRegistryListener,
	type VolumeSnapshot,
	ZenfsVolumeRegistry,
} from "./agent/volume-registry";
export { type AcpTransport, type StartAcpAgentOptions, startAcpAgent } from "./bootstrap";
export { canonicalizeMcpUrl, deriveSlugFromUrl } from "./mcp/url-canonical";
export {
	FEATURE_DEFAULTS,
	type FeatureDefaults,
	type FeatureKey,
	type FeatureSnapshot,
	type FeatureStore,
	isFeatureKey,
} from "./storage/feature-store";
export {
	EMPTY_MCP_TOGGLES,
	isServerEnabled,
	isToolEnabled,
	type McpToggleSnapshot,
	type McpToggleStore,
} from "./storage/mcp-toggle-store";
export {
	type BuiltinPayload,
	deriveTitle,
	type FeatureRow,
	type McpTogglesRow,
	type SessionEntry,
	type SessionEntryKind,
	type SessionRow,
	type SessionStore,
	type SessionSummary,
	type TurnPayload,
} from "./storage/session-store";

export * from "./wire";
