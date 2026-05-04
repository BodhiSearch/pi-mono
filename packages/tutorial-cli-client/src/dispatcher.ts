import { builtinAvailableCommands } from "@bodhiapp/web-acp-agent";
import type { EmbeddedAgent } from "./agent/embed";
import { readTokens } from "./auth/token-store";
import type { Emitter } from "./emitter";

export interface DispatchContext {
	emitter: Emitter;
	cwd: string;
	agent: EmbeddedAgent;
}

export interface DispatchResult {
	exit: boolean;
}

interface CommandEntry {
	name: string;
	description: string;
}

const CLIENT_COMMANDS: CommandEntry[] = [
	{ name: "/help", description: "Show this help" },
	{ name: "/quit", description: "Exit the CLI" },
	{ name: "/token", description: "Print the stored access token" },
	{ name: "/bodhiapp:status", description: "Check BodhiApp connectivity via the agent" },
];

export async function dispatch(line: string, ctx: DispatchContext): Promise<DispatchResult> {
	if (line === "/quit") {
		ctx.emitter.emit({ text: "application exited" });
		return { exit: true };
	}
	if (line === "/help") {
		emitHelp(ctx);
		return { exit: false };
	}
	if (line === "/token") {
		await emitToken(ctx);
		return { exit: false };
	}
	if (line === "/bodhiapp:status") {
		await emitStatus(ctx);
		return { exit: false };
	}
	if (line === "") {
		return { exit: false };
	}
	ctx.emitter.emit({ text: `unknown command: ${line}` });
	return { exit: false };
}

async function emitToken(ctx: DispatchContext): Promise<void> {
	const tokens = await readTokens(ctx.cwd);
	if (!tokens) {
		ctx.emitter.emit({ text: "no token stored — run login first" });
		return;
	}
	ctx.emitter.emit({
		text: tokens.accessToken,
		tokens: {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			tokenType: tokens.tokenType,
			expiresAt: tokens.expiresAt,
			scope: tokens.scope,
		},
	});
}

function emitHelp(ctx: DispatchContext): void {
	const serverCommands: CommandEntry[] = builtinAvailableCommands().map((c) => ({
		name: `/${c.name}`,
		description: c.description,
	}));
	const width = Math.max(...[...CLIENT_COMMANDS, ...serverCommands].map((c) => c.name.length));
	const format = (entries: CommandEntry[]) =>
		entries.map((c) => `    ${c.name.padEnd(width)}  ${c.description}`).join("\n");
	const text = [
		"Available commands:",
		"",
		"  Client (handled here):",
		format(CLIENT_COMMANDS),
		"",
		"  Agent (server-side, invoked inside session prompts):",
		format(serverCommands),
	].join("\n");
	ctx.emitter.emit({
		text,
		client_commands: CLIENT_COMMANDS,
		server_commands: serverCommands,
	});
}

async function emitStatus(ctx: DispatchContext): Promise<void> {
	const info = await ctx.agent.serverInfo();
	ctx.emitter.emit({
		text: `BodhiApp ${info.status} at ${info.url} (version ${info.version})`,
		...info,
	});
}
