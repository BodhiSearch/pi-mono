import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import type { McpToolDescriptor } from "./connection-pool";
import { createMcpAgentTool, MCP_TOOL_NAME_SEPARATOR, mcpToolName } from "./tool-adapter";

function toolDescriptor(name: string, description: string): McpToolDescriptor {
	return {
		name,
		description,
		inputSchema: {
			type: "object",
			properties: {
				message: { type: "string" },
			},
			required: ["message"],
		},
	};
}

function fakeClient(
	impl: (params: { name: string; arguments: Record<string, unknown> }) => {
		content: Array<{ type: string; [key: string]: unknown }>;
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
	},
): Client {
	const callTool = vi.fn(async (params: unknown) =>
		impl(params as { name: string; arguments: Record<string, unknown> }),
	);
	return { callTool } as unknown as Client;
}

describe("tool-adapter", () => {
	it("namespaces names with the double-underscore separator", () => {
		expect(MCP_TOOL_NAME_SEPARATOR).toBe("__");
		expect(mcpToolName("everything", "echo")).toBe("everything__echo");
	});

	it("returns text content and rich details on success", async () => {
		const client = fakeClient(({ name, arguments: args }) => {
			expect(name).toBe("echo");
			expect(args).toEqual({ message: "hi" });
			return { content: [{ type: "text", text: "echoed hi" }] };
		});

		const tool = createMcpAgentTool({
			client,
			serverName: "everything",
			tool: toolDescriptor("echo", "Echo the message"),
		});
		expect(tool.name).toBe("everything__echo");
		expect(tool.description).toBe("Echo the message");

		const result = await tool.execute("call-1", { message: "hi" });
		expect(result.content).toEqual([{ type: "text", text: "echoed hi" }]);
		expect(result.details.isError).toBe(false);
		expect(result.details.serverName).toBe("everything");
		expect(result.details.toolName).toBe("echo");
	});

	it("translates isError envelopes into a thrown Error", async () => {
		const client = fakeClient(() => ({
			content: [{ type: "text", text: "boom" }],
			isError: true,
		}));
		const tool = createMcpAgentTool({
			client,
			serverName: "everything",
			tool: toolDescriptor("echo", ""),
		});
		await expect(tool.execute("call-1", { message: "x" })).rejects.toThrow(/boom/);
	});

	it("falls back to a generic error message when no text content is available", async () => {
		const client = fakeClient(() => ({ content: [], isError: true }));
		const tool = createMcpAgentTool({
			client,
			serverName: "everything",
			tool: toolDescriptor("echo", ""),
		});
		await expect(tool.execute("call-1", { message: "x" })).rejects.toThrow(/reported an error/);
	});

	it("forwards the abort signal into client.callTool", async () => {
		const controller = new AbortController();
		let observedSignal: AbortSignal | undefined;
		const callTool = vi.fn(async (_params, _schema, opts?: { signal?: AbortSignal }) => {
			observedSignal = opts?.signal;
			return { content: [{ type: "text", text: "ok" }] };
		});
		const client = { callTool } as unknown as Client;
		const tool = createMcpAgentTool({
			client,
			serverName: "everything",
			tool: toolDescriptor("echo", ""),
		});
		await tool.execute("call-1", { message: "x" }, controller.signal);
		expect(observedSignal).toBe(controller.signal);
	});
});
