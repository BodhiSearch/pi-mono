import type { BuiltinCommand } from "./types";

export const infoCommand: BuiltinCommand = {
	name: "info",
	description: "Show stats for the current session.",
	handler: (_args, ctx) => {
		const lines = [
			"**Session**",
			"",
			`- Id: \`${ctx.sessionId}\``,
			`- Turns: ${ctx.sessionStats.turnCount}`,
			`- Messages (LLM-visible): ${ctx.sessionStats.messageCount}`,
			`- Model: \`${ctx.modelId ?? "(none selected)"}\``,
		];
		if (ctx.mcpServersConnected.length === 0) {
			lines.push("- MCP servers: _none connected_");
		} else {
			lines.push(`- MCP servers (${ctx.mcpServersConnected.length}):`);
			for (const name of ctx.mcpServersConnected) {
				lines.push(`  - \`${name}\``);
			}
		}
		return { replyText: lines.join("\n") };
	},
};
