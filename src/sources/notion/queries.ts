// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import {
  buildResult,
  clampLimit,
  escapeLike,
  ftsMatchQuery,
  MAX_RESULTS,
  type QueryResult,
} from '../../core/query.js';
import { getDb } from '../../infra/db/connection.js';

export const pageItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  lastEditedTime: z.string(),
});
export type PageItem = z.infer<typeof pageItemSchema>;

const COLUMNS = 'n.id, n.title, n.url, n.lastEditedTime';

// Same read-only contract as the GitHub queries: local store only.

export function getRecentItems(args: { limit?: number }): QueryResult<PageItem> {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM notion_pages n ORDER BY n.lastEditedTime DESC LIMIT ?`)
    .all(clampLimit(args.limit)) as PageItem[];

  return buildResult('notion', rows);
}

/** Ranked lexical search over page titles (stemmed BM25, prefix matching), then a substring fallback. */
export function lexicalPageRows(query: string, limit: number): PageItem[] {
  const db = getDb();
  const match = ftsMatchQuery(query);

  if (match) {
    const ranked = db
      .prepare(
        `SELECT ${COLUMNS} FROM notion_fts f JOIN notion_pages n ON n.seq = f.rowid
         WHERE notion_fts MATCH ?
         ORDER BY bm25(notion_fts), n.lastEditedTime DESC LIMIT ?`,
      )
      .all(match, limit) as PageItem[];
    if (ranked.length > 0) return ranked;
  }

  return db
    .prepare(
      `SELECT ${COLUMNS} FROM notion_pages n
       WHERE n.title LIKE ? ESCAPE '\\' ORDER BY n.lastEditedTime DESC LIMIT ?`,
    )
    .all(`%${escapeLike(query)}%`, limit) as PageItem[];
}

export function search(args: { query: string }): QueryResult<PageItem> {
  return buildResult('notion', lexicalPageRows(args.query, MAX_RESULTS), 'lexical');
}
