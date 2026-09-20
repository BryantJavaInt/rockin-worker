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
  /** Where the query matched inside the page body, with matches marked «like this». Search only. */
  snippet: z.string().optional(),
});
export type PageItem = z.infer<typeof pageItemSchema>;

const COLUMNS = 'n.id, n.title, n.url, n.lastEditedTime';

// Candidates gathered per ranking before fusion; the answer is cut to MAX_RESULTS afterwards.
const CANDIDATES = 50;

// FTS5 snippet() over the body column (index 1). The markers cannot be confused with page text,
// and a row whose body did not match contains none — so it yields no snippet at all.
const MARK_OPEN = '«';
const MARK_CLOSE = '»';
const SNIPPET = `snippet(notion_fts, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16)`;
const LIKE_SNIPPET_CHARS = 160;

type SnippetRow = PageItem & { snippet?: string | null };

function withSnippet(row: SnippetRow): PageItem {
  const { snippet, ...item } = row;
  return snippet?.includes(MARK_OPEN) ? { ...item, snippet } : item;
}

/** An excerpt of `content` around the first occurrence of `query`, for the substring fallback. */
function likeSnippet(content: string, query: string): string | undefined {
  const at = content.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return undefined;

  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, start + LIKE_SNIPPET_CHARS);
  const hitEnd = at + query.length;
  const excerpt =
    content.slice(start, at) +
    MARK_OPEN +
    content.slice(at, hitEnd) +
    MARK_CLOSE +
    content.slice(hitEnd, end);

  return `${start > 0 ? '…' : ''}${excerpt.replace(/\s+/g, ' ')}${end < content.length ? '…' : ''}`;
}

// Same read-only contract as the GitHub queries: local store only.

export function getRecentItems(args: { limit?: number }): QueryResult<PageItem> {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM notion_pages n ORDER BY n.lastEditedTime DESC LIMIT ?`)
    .all(clampLimit(args.limit)) as PageItem[];

  return buildResult('notion', rows);
}

/**
 * Ranked lexical search over page titles and bodies (stemmed BM25, prefix matching; a title hit
 * weighs ten times a body hit), then a substring fallback.
 */
export function lexicalPageRows(query: string, limit: number): PageItem[] {
  const db = getDb();
  const match = ftsMatchQuery(query);

  if (match) {
    const ranked = db
      .prepare(
        `SELECT ${COLUMNS}, ${SNIPPET} AS snippet
         FROM notion_fts f JOIN notion_pages n ON n.seq = f.rowid
         WHERE notion_fts MATCH ?
         ORDER BY bm25(notion_fts, 10.0, 1.0), n.lastEditedTime DESC LIMIT ?`,
      )
      .all(match, limit) as SnippetRow[];
    if (ranked.length > 0) return ranked.map(withSnippet);
  }

  const rows = db
    .prepare(
      `SELECT ${COLUMNS}, n.content AS content FROM notion_pages n
       WHERE n.title LIKE ?1 ESCAPE '\\' OR n.content LIKE ?1 ESCAPE '\\'
       ORDER BY n.lastEditedTime DESC LIMIT ?2`,
    )
    .all(`%${escapeLike(query)}%`, limit) as Array<PageItem & { content: string }>;

  return rows.map(({ content, ...item }) => {
    const snippet = likeSnippet(content, query);
    return snippet ? { ...item, snippet } : item;
  });
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
