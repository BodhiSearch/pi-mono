import type { McpServerHttp } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { BodhiProvider } from "../../agent/bodhi-provider";
import type { InlineAgent } from "../../agent/inline-agent";
import type { McpConnectionPool } from "../../agent/mcp";
import type { VolumeRegistry } from "../../agent/volume-registry";
import type { FeatureSnapshot, FeatureStore } from "../../storage/feature-store";
import type { McpToggleSnapshot, McpToggleStore } from "../../storage/mcp-toggle-store";
import type { SessionStore } from "../../storage/session-store";
import type { BodhiMcpInstanceDescriptor } from "../../wire";

/**
 * Per-session state owned by the runtime.
 */
export interface SessionState {
	id: string;
	/** MCP server configs this session acquired on `session/new` or `session/load`. */
	mcpServers: McpServerHttp[];
	/**
	 * URLs the user has asked Bodhi to approve. Read off `_meta.bodhi`
	 * on `session/new` / `session/load` so the `/mcp` built-in can
	 * render Pending entries + give correct idempotency feedback. Empty
	 * when the main thread didn't push any (e.g. fresh login with no
	 * IDB list yet).
	 */
	requestedMcpUrls: string[];
	/**
	 * Bodhi-side metadata for the approved instances pushed in alongside
	 * `requestedMcpUrls`. Carries `name` so the slug-derivation
	 * heuristic in `/mcp` can fall back to the human label when slug
	 * matching fails. Empty when the main thread didn't push any.
	 */
	mcpInstances: BodhiMcpInstanceDescriptor[];
}

/**
 * Narrow facade the adapter exposes to ext-method handlers. Lets the
 * handler files live independently of `AcpAgentAdapter`'s class
 * surface.
 */
export interface ExtMethodHost {
	readonly bodhi: BodhiProvider;
	readonly store: SessionStore | undefined;
	readonly registry: VolumeRegistry | undefined;
	readonly features: FeatureStore | undefined;
	readonly mcpToggles: McpToggleStore | undefined;
	readonly mcpPool: McpConnectionPool;
	readonly inline: InlineAgent;
	readonly sessions: Map<string, SessionState>;
	readonly isDev: boolean;
	getModels(): Model<Api>[];
	setModels(models: Model<Api>[]): void;
	getActiveInlineSessionId(): string | null;
	setActiveInlineSessionId(id: string | null): void;
	readFeatures(sessionId: string): Promise<FeatureSnapshot>;
	readMcpToggles(sessionId: string): Promise<McpToggleSnapshot>;
}
