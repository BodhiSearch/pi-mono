import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AnyBodhiBuiltinAction } from "../../../wire";

/**
 * Re-export of the wire-level action union (see `wire/index.ts`).
 * Handlers return `BuiltinResult.action` of this shape; the worker
 * stamps it onto `_meta.bodhi.builtin.action`; the client's
 * dispatcher narrows by `kind`.
 *
 * New built-ins that need a client-side action either reuse a kind
 * here or extend the union in `wire/index.ts`.
 */
export type BuiltinAction = AnyBodhiBuiltinAction;

/**
 * Lightweight projection of a connected MCP server, fed to built-in
 * handlers so `/info` and `/mcp` can render the live catalog
 * without re-walking the worker's MCP pool.
 */
export interface BuiltinMcpInstance {
	slug: string;
	/** Human-readable name from `bodhiClient.mcps.list()`. */
	name: string;
	/** Bodhi-internal proxy path, e.g. `/bodhi/v1/apps/mcps/{id}/mcp`. */
	path: string;
}

/**
 * Worker-side context fed to every built-in handler. Built from
 * `AcpAgentAdapter` state at the moment a `/cmd` invocation arrives.
 * Handlers must treat the snapshot as immutable.
 */
export interface BuiltinHandlerCtx {
	sessionId: string;
	modelId: string | null;
	serverUrl: string | null;
	sessionStats: { turnCount: number; messageCount: number };
	mcpServersConnected: string[];
	/**
	 * Full descriptors of MCP instances currently registered with the
	 * session (i.e. approved by Bodhi). Used by `/mcp` to render
	 * Connected entries with the slug and Bodhi-proxy URL.
	 */
	mcpInstances: BuiltinMcpInstance[];
	/**
	 * URLs the user has asked Bodhi to grant access for, sourced from the
	 * main-thread IDB store and pushed in via `_meta.bodhi.requestedMcpUrls`
	 * on `session/new` / `session/load`. Canonical-form (single
	 * canonicalisation pass on the main thread before the wire).
	 */
	requestedMcpUrls: string[];
	/** Built-ins + vault commands, the same list advertised to the client. */
	advertisedCommands: AvailableCommand[];
	/** LLM-visible message history. Built-ins are absent by construction. */
	inlineMessages: AgentMessage[];
	/** Build-time string supplied via the bootstrap services bag. */
	buildVersion: string;
	/** Build-time string supplied via the bootstrap services bag. */
	acpSdkVersion: string;
}

export interface BuiltinResult {
	replyText: string;
	action?: BuiltinAction;
}

export interface BuiltinCommand {
	name: string;
	description: string;
	inputHint?: string;
	handler: (args: string, ctx: BuiltinHandlerCtx) => BuiltinResult | Promise<BuiltinResult>;
}
