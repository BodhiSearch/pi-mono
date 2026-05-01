/**
 * Shapes for vault-sourced slash commands.
 *
 * `CommandDef` is the worker-internal record used by the expander; the
 * public ACP `AvailableCommand` is derived from it and emitted via
 * `available_commands_update`. Every loaded command's name is fully
 * mount-prefixed (`<mount>:<subdir>:<name>`) so the wire stays
 * conflict-free across mounts — see `path.ts` for the canonicalisation.
 */

export interface CommandSource {
	mountName: string;
	/** Path relative to the mount root, e.g. `.pi/commands/review/api.md`. */
	relPath: string;
}

export interface CommandDef {
	/** Canonical, fully-qualified name advertised to the client. */
	name: string;
	/** One-line description; falls back to a body snippet when missing. */
	description: string;
	/** Optional argument-hint string, surfaced via ACP `input.hint`. */
	argumentHint?: string;
	/** Markdown body after front-matter stripping; the expansion target. */
	template: string;
	source: CommandSource;
}
