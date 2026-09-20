// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrations.js';

describe('migration v4 (full-text search)', () => {
  it('indexes rows that already existed and preserves Notion page ids', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY, name TEXT NOT NULL, stars INTEGER NOT NULL, syncedAt TEXT NOT NULL);
      CREATE TABLE notion_pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, lastEditedTime TEXT NOT NULL, syncedAt TEXT NOT NULL);
      CREATE TABLE sync_state (source TEXT PRIMARY KEY, lastSyncAt TEXT NOT NULL);
      INSERT INTO repos VALUES (1, 'legacy-tracker', 7, '2026-01-01T00:00:00Z');
      INSERT INTO notion_pages VALUES ('page-uuid-1', 'Legacy Roadmap', 'https://n/1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z');
    `);

    migrate(db);

    expect(
      db.prepare("SELECT rowid FROM repos_fts WHERE repos_fts MATCH 'legacy'").all(),
    ).toHaveLength(1);
    expect(
      db.prepare("SELECT rowid FROM notion_fts WHERE notion_fts MATCH 'roadmap'").all(),
    ).toHaveLength(1);
    expect(db.prepare('SELECT id, title FROM notion_pages').all()).toEqual([
      { id: 'page-uuid-1', title: 'Legacy Roadmap' },
    ]);
    expect(db.prepare('SELECT description, topics FROM repos').get()).toEqual({
      description: null,
      topics: '[]',
    });
  });
});
