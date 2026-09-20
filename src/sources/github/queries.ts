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

export const repoItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  stars: z.number(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  topics: z.array(z.string()),
  url: z.string().nullable(),
});
export type RepoItem = z.infer<typeof repoItemSchema>;

export type RepoRow = Omit<RepoItem, 'topics'> & { topics: string };

const COLUMNS = 'r.id, r.name, r.stars, r.description, r.language, r.topics, r.url';

// Candidates gathered per ranking before fusion; the answer is cut to MAX_RESULTS afterwards.
const CANDIDATES = 50;

export function toRepoItem(row: RepoRow): RepoItem {
  let topics: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.topics);
    if (Array.isArray(parsed)) topics = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // A malformed topics column must not break a query; treat it as "no topics".
  }
  return { ...row, topics };
}

// Read-only: these functions only ever query the local store, never GitHub.
// They stay fast and keep working when the upstream API is down.

export function getTopItems(args: { limit?: number }): QueryResult<RepoItem> {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM repos r ORDER BY r.stars DESC, r.name ASC LIMIT ?`)
    .all(clampLimit(args.limit)) as RepoRow[];

  return buildResult('github', rows.map(toRepoItem));
}

/**
 * Ranked lexical search over name, description and topics: stemmed, prefix-matching BM25
 * (the name counts most), best match first. Falls back to a substring match because a word
 * index cannot see inside words ("ship" in "flagship-app").
 */
export function lexicalRepoRows(query: string, limit: number): RepoRow[] {
  const db = getDb();
  const match = ftsMatchQuery(query);

  if (match) {
    const ranked = db
      .prepare(
        `SELECT ${COLUMNS} FROM repos_fts f JOIN repos r ON r.id = f.rowid
         WHERE repos_fts MATCH ?
         ORDER BY bm25(repos_fts, 10.0, 3.0, 2.0), r.stars DESC LIMIT ?`,
      )
      .all(match, limit) as RepoRow[];
    if (ranked.length > 0) return ranked;
  }

  const pattern = `%${escapeLike(query)}%`;
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM repos r
       WHERE r.name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\'
       ORDER BY r.stars DESC, r.name ASC LIMIT ?`,
    )
    .all(pattern, pattern, limit) as RepoRow[];
}

function repoRowsByIds(ids: string[]): RepoRow[] {
  return getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM repos r WHERE CAST(r.id AS TEXT) IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as RepoRow[];
}

/**
 * Ranked search: lexical (BM25) fused with semantic similarity when embeddings are configured
 * and indexed, lexical only otherwise. Async because embedding the query is a network call.
 */
export async function search(args: { query: string }): Promise<QueryResult<RepoItem>> {
  const lexical = lexicalRepoRows(args.query, CANDIDATES);
  const ranked = await hybridRank({
    source: 'github',
    query: args.query,
    lexicalIds: lexical.map((row) => String(row.id)),
  });

  const byId = new Map(lexical.map((row) => [String(row.id), row]));
  const semanticOnly = ranked.ids.filter((id) => !byId.has(id));
  for (const row of semanticOnly.length > 0 ? repoRowsByIds(semanticOnly) : []) {
    byId.set(String(row.id), row);
  }

  const rows = ranked.ids
    .slice(0, MAX_RESULTS)
    .flatMap((id) => (byId.has(id) ? [byId.get(id) as RepoRow] : []));
  return buildResult('github', rows.map(toRepoItem), ranked.ranking, ranked.warning);
}
