/**
 * Sqlite-backed implementations of the agent-package store interfaces.
 *
 * Mirrors `packages/web-acp/src/runtime/storage-dexie/*.ts` shape-for-
 * shape so the agent sees identical persistence semantics regardless
 * of host. The agent writes to these synchronously per ACP turn;
 * better-sqlite3 lets us keep the API async without paying for I/O
 * thread hops.
 *
 * Two stores are exposed:
 *
 *   - `SessionStore` — sessions + entries (notifications, turns,
 *     builtins). Owned by `@bodhiapp/web-acp-agent`.
 *   - `PreferenceStore` — generic per-session keyed values. The agent
 *     wraps known keys (`feature:bashEnabled`, `feature:forceToolCall`,
 *     `mcp:toggles`, …) with typed accessors internally; this layer
 *     just stores opaque JSON.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
	deriveTitle,
	type PreferenceStore,
	type SessionEntry,
	type SessionRow,
	type SessionStore,
	type SessionSummary,
} from "@bodhiapp/web-acp-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "./db";
import { entries, preferences, sessions } from "./schema";

type SessionEntryKind = SessionEntry["kind"];
type SessionEntryPayload = SessionEntry["payload"];
type BuiltinPayload = Extract<SessionEntry, { kind: "builtin" }>["payload"];

export function createSqliteSessionStore(db: AppDb): SessionStore {
	function nextSeq(sessionId: string): number {
		const row = db
			.select({ count: sql<number>`COUNT(*)` })
			.from(entries)
			.where(eq(entries.sessionId, sessionId))
			.get();
		return row?.count ?? 0;
	}

	function ensureSession(id: string, label: string): void {
		const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
		if (!row) throw new Error(`SessionStore.${label}: unknown session '${id}'`);
	}

	return {
		async createSession(id: string, at: number = Date.now()): Promise<void> {
			db.insert(sessions)
				.values({
					id,
					createdAt: at,
					updatedAt: at,
					title: null,
					turnCount: 0,
					lastModelId: null,
				})
				.onConflictDoNothing()
				.run();
		},

		async recordNotification(id: string, notification: SessionNotification, at: number = Date.now()): Promise<void> {
			const tx = db.$sqlite.transaction(() => {
				ensureSession(id, "recordNotification");
				const seq = nextSeq(id);
				db.insert(entries)
					.values({
						sessionId: id,
						seq,
						at,
						kind: "notification",
						payload: JSON.stringify(notification),
					})
					.run();
				db.update(sessions).set({ updatedAt: at }).where(eq(sessions.id, id)).run();
			});
			tx();
		},

		async recordTurn(
			id: string,
			userText: string,
			finalMessages: AgentMessage[],
			modelId: string,
			at: number = Date.now(),
		): Promise<void> {
			const tx = db.$sqlite.transaction(() => {
				const session = db.select().from(sessions).where(eq(sessions.id, id)).get();
				if (!session) throw new Error(`SessionStore.recordTurn: unknown session '${id}'`);
				const seq = nextSeq(id);
				const payload = { userText, finalMessages, modelId };
				db.insert(entries)
					.values({
						sessionId: id,
						seq,
						at,
						kind: "turn",
						payload: JSON.stringify(payload),
					})
					.run();
				const nextTitle = session.title ?? (session.turnCount === 0 ? deriveTitle(userText) : null);
				db.update(sessions)
					.set({
						updatedAt: at,
						turnCount: session.turnCount + 1,
						title: nextTitle,
						lastModelId: modelId,
					})
					.where(eq(sessions.id, id))
					.run();
			});
			tx();
		},

		async recordBuiltin(id: string, payload: BuiltinPayload, at: number = Date.now()): Promise<void> {
			const tx = db.$sqlite.transaction(() => {
				ensureSession(id, "recordBuiltin");
				const seq = nextSeq(id);
				db.insert(entries)
					.values({
						sessionId: id,
						seq,
						at,
						kind: "builtin",
						payload: JSON.stringify(payload),
					})
					.run();
				db.update(sessions).set({ updatedAt: at }).where(eq(sessions.id, id)).run();
			});
			tx();
		},

		async listSummaries(): Promise<SessionSummary[]> {
			const rows = db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
			return rows.map((row) => ({
				id: row.id,
				title: row.title,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				turnCount: row.turnCount,
				lastModelId: row.lastModelId,
			}));
		},

		async readEntries(id: string): Promise<SessionEntry[]> {
			const rows = db.select().from(entries).where(eq(entries.sessionId, id)).orderBy(asc(entries.seq)).all();
			return rows.map((row) => ({
				sessionId: row.sessionId,
				seq: row.seq,
				at: row.at,
				kind: row.kind as SessionEntryKind,
				payload: JSON.parse(row.payload) as SessionEntryPayload,
			}));
		},

		async getSession(id: string): Promise<SessionRow | undefined> {
			const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
			return row ?? undefined;
		},

		async setTitle(id: string, title: string): Promise<void> {
			const tx = db.$sqlite.transaction(() => {
				ensureSession(id, "setTitle");
				db.update(sessions).set({ title, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
			});
			tx();
		},

		async deleteSession(id: string): Promise<void> {
			const tx = db.$sqlite.transaction(() => {
				db.delete(entries).where(eq(entries.sessionId, id)).run();
				db.delete(preferences).where(eq(preferences.sessionId, id)).run();
				db.delete(sessions).where(eq(sessions.id, id)).run();
			});
			tx();
		},
	};
}

export function createSqlitePreferenceStore(db: AppDb): PreferenceStore {
	return {
		async get(sessionId: string, key: string): Promise<unknown> {
			const row = db
				.select()
				.from(preferences)
				.where(sql`${preferences.sessionId} = ${sessionId} AND ${preferences.key} = ${key}`)
				.get();
			if (!row) return undefined;
			try {
				return JSON.parse(row.value) as unknown;
			} catch {
				return undefined;
			}
		},

		async set(sessionId: string, key: string, value: unknown): Promise<void> {
			const at = Date.now();
			const json = JSON.stringify(value);
			db.insert(preferences)
				.values({ sessionId, key, value: json, updatedAt: at })
				.onConflictDoUpdate({
					target: [preferences.sessionId, preferences.key],
					set: { value: json, updatedAt: at },
				})
				.run();
		},

		async delete(sessionId: string, key: string): Promise<void> {
			db.delete(preferences)
				.where(sql`${preferences.sessionId} = ${sessionId} AND ${preferences.key} = ${key}`)
				.run();
		},

		async list(sessionId: string): Promise<Record<string, unknown>> {
			const rows = db.select().from(preferences).where(eq(preferences.sessionId, sessionId)).all();
			const out: Record<string, unknown> = {};
			for (const row of rows) {
				try {
					out[row.key] = JSON.parse(row.value) as unknown;
				} catch {
					// ignore malformed entries; treat as absent
				}
			}
			return out;
		},

		async clearSession(sessionId: string): Promise<void> {
			db.delete(preferences).where(eq(preferences.sessionId, sessionId)).run();
		},
	};
}
