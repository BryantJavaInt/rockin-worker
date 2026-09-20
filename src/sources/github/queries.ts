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

export type RepoItem = { id: number; name: string; stars: number };

// Read-only: these functions only ever query the local store, never GitHub.
// They stay fast and keep working when the upstream API is down.

export function getTopItems(args: { limit?: number }): QueryResult<RepoItem> {
  const rows = getDb()
    .prepare('SELECT id, name, stars FROM repos ORDER BY stars DESC, name ASC LIMIT ?')
    .all(clampLimit(args.limit)) as RepoItem[];

  return buildResult('github', rows);
}

export function searchByName(args: { query: string }): QueryResult<RepoItem> {
  const rows = getDb()
    .prepare(
      `SELECT id, name, stars FROM repos
       WHERE name LIKE ? ESCAPE '\\'
       ORDER BY stars DESC, name ASC LIMIT ?`,
    )
    .all(`%${escapeLike(args.query)}%`, MAX_RESULTS) as RepoItem[];

  return buildResult('github', rows);
}
