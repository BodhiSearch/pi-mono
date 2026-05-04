/**
 * Sqlite database opener for the WS host's persistent state. Single
 * `state.db` per `cwd`, opened with WAL mode so the host stays read-
 * fast under reentrant agent writes.
 *
 * Migrations are applied inline at open time via `runMigrations` —
 * the schema is small enough that the cost stays negligible and we
 * avoid bundling `drizzle-kit` at runtime. New schema versions append
 * a `case` arm in `runMigrations`.
 */

import { mkdirSync } from "node:fs";
import * as path from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DB_DIR = ".ws-acp-client";
const DB_FILE = "state.db";

export type AppDb = BetterSQLite3Database<typeof schema> & { $sqlite: DatabaseType };

export interface OpenDbOptions {
	/** Override the on-disk file. Tests pass `:memory:` for a private
	 * in-process database. */
	filename?: string;
	/** Skip mkdir + WAL pragma when running against an in-memory db. */
	inMemory?: boolean;
}

export function openAppDb(cwd: string, options: OpenDbOptions = {}): AppDb {
	const inMemory = options.inMemory ?? options.filename === ":memory:";
	let filename: string;
	if (options.filename) {
		filename = options.filename;
	} else {
		const dir = path.join(cwd, DB_DIR);
		mkdirSync(dir, { recursive: true });
		filename = path.join(dir, DB_FILE);
	}

	const sqlite = new Database(filename);
	sqlite.pragma("foreign_keys = ON");
	if (!inMemory) {
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("synchronous = NORMAL");
	}
	runMigrations(sqlite);

	const base = drizzle(sqlite, { schema });
	Object.defineProperty(base, "$sqlite", { value: sqlite, enumerable: false });
	return base as unknown as AppDb;
}

function runMigrations(sqlite: DatabaseType): void {
	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

	const applied = new Set<number>();
	for (const row of sqlite.prepare(`SELECT version FROM __migrations`).all() as Array<{
		version: number;
	}>) {
		applied.add(row.version);
	}

	const migrations: Array<{ version: number; sql: string }> = [
		{
			version: 1,
			sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          title TEXT,
          turn_count INTEGER NOT NULL DEFAULT 0,
          last_model_id TEXT
        );
        CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions (updated_at DESC);

        CREATE TABLE IF NOT EXISTS entries (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id);

        CREATE TABLE IF NOT EXISTS features (
          session_id TEXT PRIMARY KEY,
          flags TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mcp_toggles (
          session_id TEXT PRIMARY KEY,
          servers TEXT NOT NULL DEFAULT '{}',
          tools TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL
        );
      `,
		},
	];

	const insertMigration = sqlite.prepare(`INSERT INTO __migrations (version, applied_at) VALUES (?, ?)`);
	const tx = sqlite.transaction((pending: typeof migrations) => {
		for (const m of pending) {
			sqlite.exec(m.sql);
			insertMigration.run(m.version, Date.now());
		}
	});

	const pending = migrations.filter((m) => !applied.has(m.version));
	if (pending.length > 0) tx(pending);
}
