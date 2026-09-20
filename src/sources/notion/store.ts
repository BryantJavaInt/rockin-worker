// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { UpsertOutcome } from '../../core/sync/adapter.js';
import { getDb } from '../../infra/db/connection.js';

export type NotionPage = {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
  syncedAt: string;
  /**
   * Plain text of the page body. Empty when the page is unreadable; undefined when content sync
   * is off, in which case an already-stored body is kept rather than erased.
   */
  content?: string;
};

/** Same atomic-upsert pattern as the GitHub store, keyed on Notion's stable page UUID. */
export function upsertPage(page: NotionPage): UpsertOutcome {
  const db = getDb();
  const existedBefore = !!db.prepare('SELECT 1 FROM notion_pages WHERE id = ?').get(page.id);

  db.prepare(
    `INSERT INTO notion_pages (id, title, url, lastEditedTime, syncedAt, content)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, url = excluded.url,
       lastEditedTime = excluded.lastEditedTime, syncedAt = excluded.syncedAt,
       content = CASE WHEN ? IS NULL THEN notion_pages.content ELSE excluded.content END`,
  ).run(
    page.id,
    page.title,
    page.url,
    page.lastEditedTime,
    page.syncedAt,
    page.content ?? '',
    page.content ?? null,
  );

  return existedBefore ? 'updated' : 'inserted';
}

/** Removes pages not touched by the full pass that started at `passStartedAt`. */
export function prunePages(passStartedAt: string): number {
  const { changes } = getDb()
    .prepare('DELETE FROM notion_pages WHERE syncedAt < ?')
    .run(passStartedAt);
  return Number(changes);
}
