// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from './migrations.js';

const userVersion = (db: DatabaseSync) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

describe('migrations', () => {
  it('brings a fresh database to the latest version and is idempotent', () => {
    const db = new DatabaseSync(':memory:');

    migrate(db);
    migrate(db);

    expect(userVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['repos', 'notion_pages', 'sync_state']),
    );
  });

  it('adopts a pre-versioning database without losing its data', () => {
    // The schema and rows exactly as written by the original, un-versioned worker.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY, name TEXT NOT NULL, stars INTEGER NOT NULL, syncedAt TEXT NOT NULL);
      CREATE TABLE sync_state (source TEXT PRIMARY KEY, lastSyncAt TEXT NOT NULL);
      INSERT INTO repos (id, name, stars, syncedAt) VALUES (1, 'legacy-repo', 7, '2026-01-01T00:00:00Z');
      INSERT INTO sync_state VALUES ('github', '2026-01-01T00:00:00Z');
    `);

    migrate(db);

    expect(db.prepare('SELECT name FROM repos WHERE id = 1').get()).toMatchObject({
      name: 'legacy-repo',
    });
    expect(db.prepare('SELECT watermark FROM sync_state').get()).toMatchObject({
      watermark: '2026-01-01T00:00:00Z',
    });
  });

  it('refuses to run against a schema newer than this build understands', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);

    expect(() => migrate(db)).toThrow(/newer schema/);
  });
});
