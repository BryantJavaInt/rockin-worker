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
};

/** Same atomic-upsert pattern as the GitHub store, keyed on Notion's stable page UUID. */
export function upsertPage(page: NotionPage): UpsertOutcome {
  const db = getDb();
  const existedBefore = !!db.prepare('SELECT 1 FROM notion_pages WHERE id = ?').get(page.id);

  db.prepare(
    `INSERT INTO notion_pages (id, title, url, lastEditedTime, syncedAt) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, url = excluded.url,
       lastEditedTime = excluded.lastEditedTime, syncedAt = excluded.syncedAt`,
  ).run(page.id, page.title, page.url, page.lastEditedTime, page.syncedAt);

  return existedBefore ? 'updated' : 'inserted';
}
