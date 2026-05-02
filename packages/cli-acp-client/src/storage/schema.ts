/**
 * Drizzle schema for the CLI's persistent state at
 * `<cwd>/.cli-acp-client/state.db`. Tables mirror the agent-package
 * row shapes (`SessionRow`, `FeatureRow`, `McpTogglesRow`) plus a
 * `kv` blob table for host-only state (requested MCP URLs, last
 * model id, persisted volumes).
 *
 * Polymorphic blobs (`payload` on `entries`, `flags` on `features`,
 * `servers` / `tools` on `mcp_toggles`, `value` on `kv`) are stored
 * as JSON strings; the wrappers in `sqlite-stores.ts` handle the
 * (de)serialisation. This keeps the SQL layer narrow and lets the
 * agent's own type system stay the source of truth.
 */

import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  title: text('title'),
  turnCount: integer('turn_count').notNull().default(0),
  lastModelId: text('last_model_id'),
});

export const entries = sqliteTable(
  'entries',
  {
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.sessionId, table.seq] }),
  })
);

export const features = sqliteTable('features', {
  sessionId: text('session_id').primaryKey(),
  flags: text('flags')
    .notNull()
    .default(sql`'{}'`),
  updatedAt: integer('updated_at').notNull(),
});

export const mcpToggles = sqliteTable('mcp_toggles', {
  sessionId: text('session_id').primaryKey(),
  servers: text('servers')
    .notNull()
    .default(sql`'{}'`),
  tools: text('tools')
    .notNull()
    .default(sql`'{}'`),
  updatedAt: integer('updated_at').notNull(),
});

export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type SessionsRow = typeof sessions.$inferSelect;
export type EntriesRow = typeof entries.$inferSelect;
export type FeaturesRow = typeof features.$inferSelect;
export type McpTogglesDbRow = typeof mcpToggles.$inferSelect;
export type KvRow = typeof kv.$inferSelect;
