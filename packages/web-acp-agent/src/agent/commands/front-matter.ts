/**
 * Minimal YAML-ish front-matter parser for vault command files.
 *
 * Recognises a leading `---\n…\n---\n` block at the start of a markdown
 * file and reads `key: value` pairs as string scalars. Quoted values
 * (single or double quotes) are unquoted; everything else is taken
 * verbatim with surrounding whitespace trimmed. Unsupported shapes
 * (lists, nested maps, multi-line strings) are rejected — the loader
 * will skip those files with a warning rather than fail the whole
 * scan.
 *
 * No external dependency. Pi convention is intentionally narrow here
 * (see `web-agent`'s `core/commands/frontmatter.ts`); richer fields
 * land with M5.
 */

export interface FrontMatter {
	[key: string]: string;
}

export interface ParseResult {
	frontMatter: FrontMatter;
	body: string;
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function parseFrontMatter(raw: string): ParseResult {
	// Strip a leading BOM so files saved with one don't fail the `---` test.
	const text = raw.replace(/^\uFEFF/, "");
	if (!text.startsWith("---")) {
		return { frontMatter: {}, body: text };
	}
	// The opening fence must be `---` followed immediately by a newline
	// (LF or CRLF). Anything else (e.g. `----`, `--- foo`) is treated
	// as ordinary body content per the YAML spec.
	const afterOpenIdx = consumeFenceLine(text, 0);
	if (afterOpenIdx === -1) {
		return { frontMatter: {}, body: text };
	}
	const closeIdx = findClosingFence(text, afterOpenIdx);
	if (closeIdx === -1) {
		// Unterminated front-matter: the whole file is body. The loader
		// surfaces a warning so the author can fix the file.
		return { frontMatter: {}, body: text };
	}
	const block = text.slice(afterOpenIdx, closeIdx);
	const afterCloseIdx = consumeFenceLine(text, closeIdx);
	if (afterCloseIdx === -1) {
		return { frontMatter: {}, body: text };
	}
	const frontMatter = parseBlock(block);
	return { frontMatter, body: text.slice(afterCloseIdx) };
}

/**
 * Returns the index of the character immediately after the `---`
 * fence line that starts at `from`. Returns -1 if `from` does not
 * point at a valid fence line.
 */
function consumeFenceLine(text: string, from: number): number {
	if (text.slice(from, from + 3) !== "---") return -1;
	let i = from + 3;
	// Tolerate trailing whitespace on the fence line itself (`---   \n`)
	// — common in editors that strip-on-save inconsistently.
	while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
	if (i === text.length) return i;
	if (text[i] === "\n") return i + 1;
	if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
	return -1;
}

function findClosingFence(text: string, from: number): number {
	let cursor = from;
	while (cursor < text.length) {
		const lineEnd = nextLineEnd(text, cursor);
		const lineEndExclusive = lineEnd === -1 ? text.length : lineEnd;
		const line = text.slice(cursor, lineEndExclusive);
		if (line === "---" || /^---[ \t]*$/.test(line)) {
			return cursor;
		}
		if (lineEnd === -1) return -1;
		cursor = advancePastNewline(text, lineEnd);
	}
	return -1;
}

function nextLineEnd(text: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\n" || text[i] === "\r") return i;
	}
	return -1;
}

function advancePastNewline(text: string, idx: number): number {
	if (text[idx] === "\r" && text[idx + 1] === "\n") return idx + 2;
	return idx + 1;
}

function parseBlock(block: string): FrontMatter {
	const out: FrontMatter = {};
	const lines = block.split(/\r\n|\r|\n/);
	for (const rawLine of lines) {
		const line = rawLine.replace(/[ \t]+$/, "");
		if (line.length === 0) continue;
		if (line.startsWith("#")) continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) {
			throw new FrontMatterError(`expected 'key: value', got '${rawLine}'`);
		}
		const key = line.slice(0, colonIdx).trim();
		if (!KEY_PATTERN.test(key)) {
			throw new FrontMatterError(`invalid front-matter key: '${key}'`);
		}
		const valueRaw = line.slice(colonIdx + 1).trim();
		if (valueRaw.length === 0) {
			throw new FrontMatterError(`empty value for key '${key}'`);
		}
		if (looksLikeStructured(valueRaw)) {
			throw new FrontMatterError(`unsupported front-matter value for '${key}' (lists/maps not allowed)`);
		}
		out[key] = unquote(valueRaw);
	}
	return out;
}

function looksLikeStructured(value: string): boolean {
	if (value.startsWith("[") || value.startsWith("{")) return true;
	if (value === "|" || value === ">") return true;
	return false;
}

function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

export class FrontMatterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrontMatterError";
	}
}
