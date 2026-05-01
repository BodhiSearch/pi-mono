/**
 * Adapt an MCP tool descriptor into a pi-agent-core `AgentTool`.
 *
 * Each MCP tool becomes an `AgentTool` whose `name` is the namespaced
 * `<serverName>__<toolName>` form. `execute` proxies to
 * `client.callTool(...)`, forwards the per-turn `AbortSignal`, and
 * translates the MCP `isError` envelope into a thrown error so the
 * adapter's existing `tool_execution_end isError` path runs without
 * special-casing.
 *
 * Tools are schema-less from TypeBox's perspective: MCP ships raw JSON
 * Schema, and we wrap it via `Type.Unsafe<any>(...)` so the runtime
 * surface behaves like any other `AgentTool<TSchema>`.
 */
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type TSchema, Type } from "@sinclair/typebox";
import type { McpToolDescriptor } from "./connection-pool";

export const MCP_TOOL_NAME_SEPARATOR = "__";

export interface McpToolAdapterDeps {
	/** Connected MCP client owned by the pool; caller guarantees it stays open. */
	client: Client;
	/** Server name from the originating `McpServerHttp.name` (slug). */
	serverName: string;
	/** Tool descriptor from `tools/list`. */
	tool: McpToolDescriptor;
}

export interface McpToolDetails {
	serverName: string;
	toolName: string;
	isError: boolean;
	structuredContent?: Record<string, unknown>;
	content: Array<{ type: string; [key: string]: unknown }>;
}

/**
 * Compose the namespaced AgentTool.name exposed to pi-agent-core /
 * the model. Double-underscore separator keeps things readable and
 * avoids collisions with typical MCP tool names.
 */
export function mcpToolName(serverName: string, toolName: string): string {
	return `${serverName}${MCP_TOOL_NAME_SEPARATOR}${toolName}`;
}

export function createMcpAgentTool(deps: McpToolAdapterDeps): AgentTool<TSchema, McpToolDetails> {
	const { client, serverName, tool } = deps;
	const fullName = mcpToolName(serverName, tool.name);
	const schema = Type.Unsafe<Record<string, unknown>>(tool.inputSchema) as TSchema;
	return {
		name: fullName,
		label: fullName,
		description: tool.description || fullName,
		parameters: schema,
		async execute(
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
		): Promise<AgentToolResult<McpToolDetails>> {
			const args = (params ?? {}) as Record<string, unknown>;
			const response = await client.callTool(
				{ name: tool.name, arguments: args },
				undefined,
				signal ? { signal } : undefined,
			);
			const content = extractContent(response.content);
			const details: McpToolDetails = {
				serverName,
				toolName: tool.name,
				isError: Boolean(response.isError),
				content,
				...(response.structuredContent && typeof response.structuredContent === "object"
					? { structuredContent: response.structuredContent as Record<string, unknown> }
					: {}),
			};
			if (details.isError) {
				const message = summariseErrorContent(content) || `${fullName} reported an error`;
				const err = new Error(message);
				(err as unknown as { details: McpToolDetails }).details = details;
				throw err;
			}
			return {
				content: content
					.filter((block) => block.type === "text" && typeof block.text === "string")
					.map((block) => ({ type: "text" as const, text: block.text as string })),
				details,
			};
		},
	};
}

function extractContent(raw: unknown): Array<{ type: string; [key: string]: unknown }> {
	if (!Array.isArray(raw)) return [];
	const out: Array<{ type: string; [key: string]: unknown }> = [];
	for (const block of raw) {
		if (block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string") {
			out.push(block as { type: string });
		}
	}
	return out;
}

function summariseErrorContent(content: Array<{ type: string; [key: string]: unknown }>): string {
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			return block.text;
		}
	}
	return "";
}
