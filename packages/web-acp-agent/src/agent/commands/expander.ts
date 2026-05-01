/**
 * Agent-side slash-command expansion.
 *
 * The client sends a literal `/<name> <args>` text block in
 * `session/prompt`; the agent replaces it with the matching command's
 * template (front-matter stripped) before the LLM call. Argument
 * parsing follows bash conventions (single + double quotes, backslash
 * escapes); substitution supports `$1`..`$9`, `$@`, and `$ARGUMENTS`
 * (the latter aliases `$@` for Claude Code parity).
 *
 * Unmatched positional placeholders are left literal so authors can
 * see immediately when a template references an argument the user did
 * not supply.
 */

import type { CommandDef } from "./types";

export interface ExpansionResult {
	matched: boolean;
	expanded?: string;
	commandName?: string;
}

const COMMAND_PATTERN = /^\/(\S+)(?:[ \t]+([\s\S]*))?$/;

export function expandCommand(text: string, commands: readonly CommandDef[]): ExpansionResult {
	const match = COMMAND_PATTERN.exec(text);
	if (!match) return { matched: false };
	const name = match[1];
	const cmd = commands.find((c) => c.name === name);
	if (!cmd) return { matched: false };
	const argsRaw = match[2] ?? "";
	const argv = tokenizeBash(argsRaw);
	const expanded = substitute(cmd.template, argsRaw.trim(), argv);
	return { matched: true, expanded, commandName: cmd.name };
}

/**
 * Bash-style tokenizer. Handles single quotes (verbatim), double
 * quotes (allow `\\` and `\"` escapes; everything else literal), and
 * backslash escapes outside of quotes. Whitespace separates tokens.
 *
 * Variable interpolation (`$VAR`) is intentionally NOT performed —
 * tokens are passed through to `$1..$9`/`$@` substitution unchanged
 * so a template can refer to literals like `$HOME` without surprise.
 */
export function tokenizeBash(input: string): string[] {
	const out: string[] = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let started = false;

	const flush = () => {
		if (started) {
			out.push(buf);
			buf = "";
			started = false;
		}
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			buf += ch;
			started = true;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				const next = input[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					buf += next;
					i++;
				} else {
					buf += ch;
				}
				started = true;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			buf += ch;
			started = true;
			continue;
		}
		if (ch === "\\") {
			const next = input[i + 1];
			if (next !== undefined) {
				buf += next;
				i++;
				started = true;
			}
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			started = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			started = true;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			flush();
			continue;
		}
		buf += ch;
		started = true;
	}
	flush();
	return out;
}

function substitute(template: string, argsRaw: string, argv: string[]): string {
	// Replace named tokens first so a stray `$ARGUMENTS` later in the
	// template doesn't get partially eaten by the `$1..$9` pass.
	let out = template.replace(/\$ARGUMENTS\b/g, argsRaw);
	out = out.replace(/\$@/g, argsRaw);
	out = out.replace(/\$([1-9])/g, (whole, digit: string) => {
		const idx = Number(digit) - 1;
		return idx < argv.length ? argv[idx] : whole;
	});
	return out;
}
