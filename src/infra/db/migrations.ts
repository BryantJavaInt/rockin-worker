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
  // v3: resumable backfill — the state of a sync pass that did not finish in one run
  `
  ALTER TABLE sync_state ADD COLUMN passCursor TEXT;
  ALTER TABLE sync_state ADD COLUMN passStartedAt TEXT;
  ALTER TABLE sync_state ADD COLUMN passNewest TEXT;
  ALTER TABLE sync_state ADD COLUMN passFull INTEGER;
  ALTER TABLE sync_state ADD COLUMN passFetched INTEGER;
  `,
  // v4: richer GitHub metadata, a stable integer key for Notion pages, and ranked full-text
  // search. External-content FTS5 indexes reference rows by an integer rowid that must never
  // change, so notion_pages (TEXT primary key) first gets an AUTOINCREMENT surrogate key.
  // Triggers keep each index in step, and a final 'rebuild' indexes rows that already exist.
  `
  ALTER TABLE repos ADD COLUMN description TEXT;
  ALTER TABLE repos ADD COLUMN language TEXT;
  ALTER TABLE repos ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE repos ADD COLUMN url TEXT;

  CREATE TABLE notion_pages_v4 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    lastEditedTime TEXT NOT NULL,
    syncedAt TEXT NOT NULL
  );
  INSERT INTO notion_pages_v4 (id, title, url, lastEditedTime, syncedAt)
    SELECT id, title, url, lastEditedTime, syncedAt FROM notion_pages;
  DROP TABLE notion_pages;
  ALTER TABLE notion_pages_v4 RENAME TO notion_pages;
  CREATE INDEX IF NOT EXISTS idx_notion_pages_edited ON notion_pages(lastEditedTime DESC);

  CREATE VIRTUAL TABLE repos_fts USING fts5(
    name, description, topics,
    content='repos', content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER repos_fts_ai AFTER INSERT ON repos BEGIN
    INSERT INTO repos_fts(rowid, name, description, topics)
    VALUES (new.id, new.name, new.description, new.topics);
  END;
  CREATE TRIGGER repos_fts_ad AFTER DELETE ON repos BEGIN
    INSERT INTO repos_fts(repos_fts, rowid, name, description, topics)
    VALUES ('delete', old.id, old.name, old.description, old.topics);
  END;
  CREATE TRIGGER repos_fts_au AFTER UPDATE ON repos BEGIN
    INSERT INTO repos_fts(repos_fts, rowid, name, description, topics)
    VALUES ('delete', old.id, old.name, old.description, old.topics);
    INSERT INTO repos_fts(rowid, name, description, topics)
    VALUES (new.id, new.name, new.description, new.topics);
  END;

  CREATE VIRTUAL TABLE notion_fts USING fts5(
    title,
    content='notion_pages', content_rowid='seq',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER notion_fts_ai AFTER INSERT ON notion_pages BEGIN
    INSERT INTO notion_fts(rowid, title) VALUES (new.seq, new.title);
  END;
  CREATE TRIGGER notion_fts_ad AFTER DELETE ON notion_pages BEGIN
    INSERT INTO notion_fts(notion_fts, rowid, title) VALUES ('delete', old.seq, old.title);
  END;
  CREATE TRIGGER notion_fts_au AFTER UPDATE ON notion_pages BEGIN
    INSERT INTO notion_fts(notion_fts, rowid, title) VALUES ('delete', old.seq, old.title);
    INSERT INTO notion_fts(rowid, title) VALUES (new.seq, new.title);
  END;

  INSERT INTO repos_fts(repos_fts) VALUES ('rebuild');
  INSERT INTO notion_fts(notion_fts) VALUES ('rebuild');
  `,
  // v5: semantic search vectors. One row per indexed document; textHash lets the indexer skip
  // documents whose text has not changed, and model keeps vectors of different models apart.
  `
  CREATE TABLE embeddings (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    model TEXT NOT NULL,
    textHash TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (source, id)
  );
  `,
  // v6: Notion page bodies. The FTS table is rebuilt to index title + content (FTS5 columns
  // cannot be added in place), weighted so a title hit outranks a body hit.
  `
  ALTER TABLE notion_pages ADD COLUMN content TEXT NOT NULL DEFAULT '';

  DROP TRIGGER notion_fts_ai;
  DROP TRIGGER notion_fts_ad;
  DROP TRIGGER notion_fts_au;
  DROP TABLE notion_fts;

  CREATE VIRTUAL TABLE notion_fts USING fts5(
    title, content,
    content='notion_pages', content_rowid='seq',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER notion_fts_ai AFTER INSERT ON notion_pages BEGIN
    INSERT INTO notion_fts(rowid, title, content) VALUES (new.seq, new.title, new.content);
  END;
  CREATE TRIGGER notion_fts_ad AFTER DELETE ON notion_pages BEGIN
    INSERT INTO notion_fts(notion_fts, rowid, title, content)
    VALUES ('delete', old.seq, old.title, old.content);
  END;
  CREATE TRIGGER notion_fts_au AFTER UPDATE ON notion_pages BEGIN
    INSERT INTO notion_fts(notion_fts, rowid, title, content)
    VALUES ('delete', old.seq, old.title, old.content);
    INSERT INTO notion_fts(rowid, title, content) VALUES (new.seq, new.title, new.content);
  END;
  INSERT INTO notion_fts(notion_fts) VALUES ('rebuild');
  `,
  // v7: credentials the remote MCP server must refuse even though they are cryptographically
  // valid — an OAuth client, a user (subject) or one token (jti).
  `
  CREATE TABLE revocations (
    kind TEXT NOT NULL CHECK (kind IN ('client', 'subject', 'token')),
    value TEXT NOT NULL,
    revokedAt TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (kind, value)
  );
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
