// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import {
  buildResult,
  clampLimit,
  escapeLike,
  MAX_RESULTS,
  type QueryResult,
} from '../../core/query.js';
import { getDb } from '../../infra/db/connection.js';

export type PageItem = { id: string; title: string; url: string; lastEditedTime: string };

// Same read-only contract as the GitHub queries: local store only.

export function getRecentItems(args: { limit?: number }): QueryResult<PageItem> {
  const rows = getDb()
    .prepare(
      'SELECT id, title, url, lastEditedTime FROM notion_pages ORDER BY lastEditedTime DESC LIMIT ?',
    )
    .all(clampLimit(args.limit)) as PageItem[];

  return buildResult('notion', rows);
}

export function searchByName(args: { query: string }): QueryResult<PageItem> {
  const rows = getDb()
    .prepare(
      `SELECT id, title, url, lastEditedTime FROM notion_pages
       WHERE title LIKE ? ESCAPE '\\'
       ORDER BY lastEditedTime DESC LIMIT ?`,
    )
    .all(`%${escapeLike(args.query)}%`, MAX_RESULTS) as PageItem[];

  return buildResult('notion', rows);
}
