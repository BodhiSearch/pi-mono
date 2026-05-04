/**
 * Drizzle schema for the WS host's persistent state at
 * `<cwd>/.ws-acp-client/state.db`. Tables mirror the agent-package
 * row shapes (`SessionRow`, `PreferenceStore` keys).
 *
 * Single-tenant model: one db per cwd, shared across all WebSocket
 * connections served by the same `ws-acp-client` process.
 *
 * Schema notes:
 *   - `sessions` / `entries` mirror the Dexie schema in
 *     `packages/web-acp/src/runtime/storage-dexie/db.ts`.
 *   - `preferences` is the unified per-session/per-key store that
 *     replaces the legacy `features` and `mcp_toggles` tables.
 *     Values are JSON-encoded text; callers own the schema for each
 *     well-known key (`feature:bashEnabled`, `mcp:toggles`, …).
 */

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
	title: text("title"),
	turnCount: integer("turn_count").notNull().default(0),
	lastModelId: text("last_model_id"),
});

export const entries = sqliteTable(
	"entries",
	{
		sessionId: text("session_id").notNull(),
		seq: integer("seq").notNull(),
		at: integer("at").notNull(),
		kind: text("kind").notNull(),
		payload: text("payload").notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.sessionId, table.seq] }),
	}),
);

export const preferences = sqliteTable(
	"preferences",
	{
		sessionId: text("session_id").notNull(),
		key: text("key").notNull(),
		value: text("value").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.sessionId, table.key] }),
	}),
);
