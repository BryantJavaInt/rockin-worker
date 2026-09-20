// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from './migrations.js';

const ftsCount = (db: DatabaseSync, word: string) =>
  db.prepare('SELECT rowid FROM notion_fts WHERE notion_fts MATCH ?').all(word).length;

describe('migration v6 (Notion page bodies)', () => {
  it('keeps existing pages, adds an empty body and makes bodies searchable', () => {
    const db = new DatabaseSync(':memory:');
    // Bring a database to schema v5, exactly as a user's data.db is before upgrading.
    MIGRATIONS.slice(0, 5).forEach((statement, index) => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
    db.exec(
      "INSERT INTO notion_pages (id, title, url, lastEditedTime, syncedAt) VALUES ('p1', 'Roadmap', 'https://n/1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z')",
    );

    migrate(db);

    expect(db.prepare('SELECT title, content FROM notion_pages').get()).toEqual({
      title: 'Roadmap',
      content: '',
    });
    expect(ftsCount(db, 'roadmap')).toBe(1);

    db.exec("UPDATE notion_pages SET content = 'Migrate billing to PostgreSQL' WHERE id = 'p1'");
    expect(ftsCount(db, 'postgresql')).toBe(1);

    // The old body must leave the index when it changes.
    db.exec("UPDATE notion_pages SET content = 'Nothing here' WHERE id = 'p1'");
    expect(ftsCount(db, 'postgresql')).toBe(0);

    db.exec("DELETE FROM notion_pages WHERE id = 'p1'");
    expect(ftsCount(db, 'roadmap')).toBe(0);
  });
});
