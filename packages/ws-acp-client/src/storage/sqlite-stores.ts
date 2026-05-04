/**
 * Sqlite-backed implementations of the agent-package store interfaces.
 *
 * Mirrors `packages/cli-acp-client/src/storage/sqlite-stores.ts` and
 * the browser host's Dexie implementation (`packages/web-acp/src/
 * runtime/storage-dexie/*-store.ts`) shape-for-shape so the agent
 * sees identical persistence semantics regardless of host.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
	deriveTitle,
	EMPTY_MCP_TOGGLES,
	FEATURE_DEFAULTS,
	type FeatureSnapshot,
	type FeatureStore,
	isFeatureKey,
	type McpToggleSnapshot,
	type McpToggleStore,
	type SessionEntry,
	type SessionRow,
	type SessionStore,
	type SessionSummary,
} from "@bodhiapp/web-acp-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "./db";
import { entries, features, mcpToggles, sessions } from "./schema";

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
				db.delete(features).where(eq(features.sessionId, id)).run();
				db.delete(mcpToggles).where(eq(mcpToggles.sessionId, id)).run();
				db.delete(sessions).where(eq(sessions.id, id)).run();
			});
			tx();
		},
	};
}

export function createSqliteFeatureStore(db: AppDb): FeatureStore {
	function readFlags(sessionId: string): Record<string, boolean> {
		const row = db.select().from(features).where(eq(features.sessionId, sessionId)).get();
		if (!row) return {};
		try {
			return JSON.parse(row.flags) as Record<string, boolean>;
		} catch {
			return {};
		}
	}

	return {
		async get(sessionId: string): Promise<FeatureSnapshot> {
			return mergeFeatures(readFlags(sessionId));
		},

		async set(sessionId: string, key: string, value: boolean): Promise<FeatureSnapshot> {
			if (!isFeatureKey(key)) {
				throw new Error(`Unknown feature key '${key}'`);
			}
			const next = { ...readFlags(sessionId), [key]: value };
			const at = Date.now();
			db.insert(features)
				.values({ sessionId, flags: JSON.stringify(next), updatedAt: at })
				.onConflictDoUpdate({
					target: features.sessionId,
					set: { flags: JSON.stringify(next), updatedAt: at },
				})
				.run();
			return mergeFeatures(next);
		},

		async clear(sessionId: string): Promise<void> {
			db.delete(features).where(eq(features.sessionId, sessionId)).run();
		},
	};
}

export function createSqliteMcpToggleStore(db: AppDb): McpToggleStore {
	function readSnapshot(sessionId: string): McpToggleSnapshot {
		const row = db.select().from(mcpToggles).where(eq(mcpToggles.sessionId, sessionId)).get();
		if (!row) {
			return {
				servers: { ...EMPTY_MCP_TOGGLES.servers },
				tools: {},
			};
		}
		let parsedServers: Record<string, boolean> = {};
		let parsedTools: Record<string, Record<string, boolean>> = {};
		try {
			parsedServers = JSON.parse(row.servers) as Record<string, boolean>;
		} catch {
			parsedServers = {};
		}
		try {
			parsedTools = JSON.parse(row.tools) as Record<string, Record<string, boolean>>;
		} catch {
			parsedTools = {};
		}
		return { servers: parsedServers, tools: parsedTools };
	}

	function writeSnapshot(sessionId: string, snapshot: McpToggleSnapshot): McpToggleSnapshot {
		const at = Date.now();
		db.insert(mcpToggles)
			.values({
				sessionId,
				servers: JSON.stringify(snapshot.servers),
				tools: JSON.stringify(snapshot.tools),
				updatedAt: at,
			})
			.onConflictDoUpdate({
				target: mcpToggles.sessionId,
				set: {
					servers: JSON.stringify(snapshot.servers),
					tools: JSON.stringify(snapshot.tools),
					updatedAt: at,
				},
			})
			.run();
		return cloneSnapshot(snapshot);
	}

	return {
		async get(sessionId: string): Promise<McpToggleSnapshot> {
			return cloneSnapshot(readSnapshot(sessionId));
		},

		async setServer(sessionId: string, serverSlug: string, value: boolean): Promise<McpToggleSnapshot> {
			const current = readSnapshot(sessionId);
			const next: McpToggleSnapshot = {
				servers: { ...current.servers, [serverSlug]: value },
				tools: cloneToolMap(current.tools),
			};
			return writeSnapshot(sessionId, next);
		},

		async setTool(
			sessionId: string,
			serverSlug: string,
			toolName: string,
			value: boolean,
		): Promise<McpToggleSnapshot> {
			const current = readSnapshot(sessionId);
			const serverTools = { ...(current.tools[serverSlug] ?? {}), [toolName]: value };
			const nextTools = { ...cloneToolMap(current.tools), [serverSlug]: serverTools };
			const next: McpToggleSnapshot = {
				servers: { ...current.servers },
				tools: nextTools,
			};
			return writeSnapshot(sessionId, next);
		},

		async clear(sessionId: string): Promise<void> {
			db.delete(mcpToggles).where(eq(mcpToggles.sessionId, sessionId)).run();
		},
	};
}

function mergeFeatures(flags: Record<string, boolean>): FeatureSnapshot {
	return { ...FEATURE_DEFAULTS, ...flags };
}

function cloneToolMap(tools: Record<string, Record<string, boolean>>): Record<string, Record<string, boolean>> {
	return Object.fromEntries(Object.entries(tools).map(([slug, m]) => [slug, { ...m }]));
}

function cloneSnapshot(snapshot: McpToggleSnapshot): McpToggleSnapshot {
	return {
		servers: { ...snapshot.servers },
		tools: cloneToolMap(snapshot.tools),
	};
}
