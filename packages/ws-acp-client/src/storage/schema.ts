/**
 * Drizzle schema for the WS host's persistent state at
 * `<cwd>/.ws-acp-client/state.db`. Tables mirror the agent-package
 * row shapes (`SessionRow`, `FeatureRow`, `McpTogglesRow`).
 *
 * Single-tenant model: one db per cwd, shared across all WebSocket
 * connections served by the same `ws-acp-client` process.
 */

import { sql } from "drizzle-orm";
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

export const features = sqliteTable("features", {
	sessionId: text("session_id").primaryKey(),
	flags: text("flags").notNull().default(sql`'{}'`),
	updatedAt: integer("updated_at").notNull(),
});

export const mcpToggles = sqliteTable("mcp_toggles", {
	sessionId: text("session_id").primaryKey(),
	servers: text("servers").notNull().default(sql`'{}'`),
	tools: text("tools").notNull().default(sql`'{}'`),
	updatedAt: integer("updated_at").notNull(),
});
