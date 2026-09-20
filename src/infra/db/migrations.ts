// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered, append-only schema migrations. The applied version lives in
 * SQLite's built-in `PRAGMA user_version`, so there is no bookkeeping table.
 *
 * Rules: never edit a shipped migration — add a new one. Index `i` is version `i + 1`.
 * Migration 1 uses IF NOT EXISTS so databases created before versioning existed
 * (user_version = 0, tables already present) adopt the scheme without data loss.
 */
export const MIGRATIONS: readonly string[] = [
  // v1: base schema
  `
  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    stars INTEGER NOT NULL,
    syncedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notion_pages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    lastEditedTime TEXT NOT NULL,
    syncedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_state (
    source TEXT PRIMARY KEY,
    lastSyncAt TEXT NOT NULL
  );
  `,
  // v2: clearer sync_state semantics + freshness stamp + indexes for the Tool queries
  `
  ALTER TABLE sync_state RENAME COLUMN lastSyncAt TO watermark;
  ALTER TABLE sync_state ADD COLUMN lastSuccessAt TEXT;
  CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars DESC);
  CREATE INDEX IF NOT EXISTS idx_notion_pages_edited ON notion_pages(lastEditedTime DESC);
  `,
];

export function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema is v${current} but this build only knows v${MIGRATIONS.length}. ` +
        'Refusing to run against a newer schema — upgrade the application.',
    );
  }

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
