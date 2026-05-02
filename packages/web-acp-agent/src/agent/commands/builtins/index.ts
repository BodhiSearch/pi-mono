import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { copyCommand } from "./copy";
import { helpCommand } from "./help";
import { infoCommand } from "./info";
import { mcpCommand } from "./mcp";
import type { BuiltinCommand } from "./types";
import { versionCommand } from "./version";

export type {
	BuiltinAction,
	BuiltinCommand,
	BuiltinHandlerCtx,
	BuiltinMcpInstance,
	BuiltinResult,
} from "./types";

/**
 * Worker-side registry of agent-handled built-in slash commands.
 * Order is the surfaced order in `/help` (sort happens there); the
 * adapter merges these into `available_commands_update` alongside
 * vault commands.
 */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
	helpCommand,
	versionCommand,
	infoCommand,
	copyCommand,
	mcpCommand,
];

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

/**
 * Recognise a built-in invocation in raw user-typed text. The match is
 * a strict prefix on `/<name>` followed by either end-of-string or
 * whitespace, so vault commands sharing a longer prefix can never be
 * misclassified. Returns the canonical command + remaining args
 * (whitespace-trimmed); `null` if nothing matches.
 */
export function findBuiltin(text: string): { cmd: BuiltinCommand; args: string } | null {
	if (!text.startsWith("/")) return null;
	const rest = text.slice(1);
	const wsMatch = rest.match(/\s/);
	const name = wsMatch ? rest.slice(0, wsMatch.index) : rest;
	if (!BUILTIN_NAMES.has(name)) return null;
	const cmd = BUILTIN_COMMANDS.find((c) => c.name === name);
	if (!cmd) return null;
	const args = wsMatch ? rest.slice((wsMatch.index ?? 0) + 1).trim() : "";
	return { cmd, args };
}

export function isBuiltinName(name: string): boolean {
	return BUILTIN_NAMES.has(name);
}

export function builtinAvailableCommands(): AvailableCommand[] {
	return BUILTIN_COMMANDS.map(toAvailableCommand);
}

function toAvailableCommand(cmd: BuiltinCommand): AvailableCommand {
	const out: AvailableCommand = {
		name: cmd.name,
		description: cmd.description,
	};
	if (cmd.inputHint) out.input = { hint: cmd.inputHint };
	return out;
}
