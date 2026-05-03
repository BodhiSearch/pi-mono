import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AnyBodhiBuiltinAction } from "../wire";

/**
 * Worker-owned persistence interface for ACP sessions.
 *
 * The agent package owns only the **shape** types and store interfaces;
 * the host runtime supplies a concrete implementation (the browser
 * uses Dexie/IndexedDB, future backends could use SQLite, Postgres,
 * etc.). The object of record is whatever `session/new` returned plus
 * the transcript of `session/update` events.
 */

// Adding a new kind here is on-disk compatible: the `entries` table
// stores `payload` as a polymorphic blob keyed only by `[sessionId+seq]`,
// so introducing `'builtin'` (M4 phase B) does not require a Dexie
// version bump. Old DBs that never wrote a 'builtin' row read back
// the same shape as before.
export type SessionEntryKind = "notification" | "turn" | "builtin";

export interface TurnPayload {
	userText: string;
	finalMessages: AgentMessage[];
	modelId: string;
}

/**
 * Persisted record of a built-in slash-command exchange (M4 phase B).
 * Built-ins bypass the LLM — the worker recognises `/help` etc. in
 * `prompt()`, runs a handler, and writes one of these instead of a
 * `'turn'` entry. Because they are not `'turn'` entries, they are
 * naturally invisible to `inline.restoreMessages()` on reload, which
 * keeps the LLM blind to built-in exchanges on subsequent prompts.
 *
 * `action` is an optional client-action descriptor (e.g.
 * `{ kind: 'copy' }`); the client builds the actual payload at
 * dispatch time. `kind` is open-ended for future commands like
 * `/share`, `/export-html`, `/feedback`.
 */
export interface BuiltinPayload {
	command: string;
	userText: string;
	replyText: string;
	action?: AnyBodhiBuiltinAction;
}

export interface SessionEntry {
	sessionId: string;
	seq: number;
	at: number;
	kind: SessionEntryKind;
	payload: SessionNotification | TurnPayload | BuiltinPayload;
}

export interface SessionRow {
	id: string;
	createdAt: number;
	updatedAt: number;
	title: string | null;
	turnCount: number;
	lastModelId: string | null;
}

export interface SessionSummary {
	id: string;
	title: string | null;
	createdAt: number;
	updatedAt: number;
	turnCount: number;
	lastModelId: string | null;
}

const MAX_TITLE_LENGTH = 60;

/**
 * Derive a one-line title from the first user prompt. Keeps the picker
 * readable without needing an LLM call.
 */
export function deriveTitle(userText: string): string {
	const single = userText.replace(/\s+/g, " ").trim();
	if (single.length <= MAX_TITLE_LENGTH) return single;
	return `${single.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Per-session feature toggle row stored alongside sessions. Added in
 * M2 phase B; see `feature-store.ts` for the wrapper contract and
 * `features.md` for the public wire shape.
 */
export interface FeatureRow {
	sessionId: string;
	flags: Record<string, boolean>;
	updatedAt: number;
}

/**
 * Per-session MCP toggle row — one entry per ACP session storing the
 * user's per-server on/off flags and, nested under each server slug,
 * per-tool on/off flags. Added in M3 phase B; see
 * `mcp-toggle-store.ts` for the wrapper contract and
 * `specs/web-acp-agent/mcp.md` for the public wire shape returned by
 * `bodhi/getSession` + mutated via `_bodhi/mcp/toggles/set`.
 *
 * Semantics:
 * - **Absent keys mean "default on".** We never materialise a
 *   `true` entry just to mirror the default — that way the ACP wire
 *   shape stays compact and newly-discovered servers/tools opt in
 *   automatically.
 * - `servers[slug] === false` → skip server in the composed
 *   `McpServerHttp[]` passed to `session/load`.
 * - `tools[slug][toolName] === false` → server stays registered but
 *   that specific tool is filtered from the adapter's `setModel`
 *   registration.
 */
export interface McpTogglesRow {
	sessionId: string;
	servers: Record<string, boolean>;
	tools: Record<string, Record<string, boolean>>;
	updatedAt: number;
}

export interface SessionStore {
	createSession(id: string, at?: number): Promise<void>;
	recordNotification(id: string, notification: SessionNotification, at?: number): Promise<void>;
	recordTurn(id: string, userText: string, finalMessages: AgentMessage[], modelId: string, at?: number): Promise<void>;
	recordBuiltin(id: string, payload: BuiltinPayload, at?: number): Promise<void>;
	listSummaries(): Promise<SessionSummary[]>;
	readEntries(id: string): Promise<SessionEntry[]>;
	getSession(id: string): Promise<SessionRow | undefined>;
	setTitle(id: string, title: string): Promise<void>;
	deleteSession(id: string): Promise<void>;
}
