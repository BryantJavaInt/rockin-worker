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
import { hybridRank } from '../../core/search/hybrid.js';
import { getDb } from '../../infra/db/connection.js';

export const pageItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  lastEditedTime: z.string(),
});
export type PageItem = z.infer<typeof pageItemSchema>;

const COLUMNS = 'n.id, n.title, n.url, n.lastEditedTime';

// Candidates gathered per ranking before fusion; the answer is cut to MAX_RESULTS afterwards.
const CANDIDATES = 50;

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

function pageRowsByIds(ids: string[]): PageItem[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM notion_pages n WHERE n.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as PageItem[];
}

/** Ranked search: lexical (BM25) fused with semantic similarity when embeddings are configured. */
export async function search(args: { query: string }): Promise<QueryResult<PageItem>> {
  const lexical = lexicalPageRows(args.query, CANDIDATES);
  const ranked = await hybridRank({
    source: 'notion',
    query: args.query,
    lexicalIds: lexical.map((row) => row.id),
  });

  const byId = new Map(lexical.map((row) => [row.id, row]));
  const semanticOnly = ranked.ids.filter((id) => !byId.has(id));
  for (const row of semanticOnly.length > 0 ? pageRowsByIds(semanticOnly) : []) {
    byId.set(row.id, row);
  }

  const rows = ranked.ids
    .slice(0, MAX_RESULTS)
    .flatMap((id) => (byId.has(id) ? [byId.get(id) as PageItem] : []));
  return buildResult('notion', rows, ranked.ranking, ranked.warning);
}
