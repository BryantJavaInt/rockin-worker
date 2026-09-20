// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { UpsertOutcome } from '../../core/sync/adapter.js';
import { getDb } from '../../infra/db/connection.js';

export type Repo = {
  id: number;
  name: string;
  stars: number;
  syncedAt: string;
};

/**
 * The write is one atomic `INSERT ... ON CONFLICT DO UPDATE`, correct even with
 * concurrent writers. The SELECT beforehand only feeds the inserted/updated
 * counters — it never decides what gets written. (SQLite does not report
 * whether an upsert inserted or updated: `changes` is 1 either way.)
 */
export function upsertRepo(repo: Repo): UpsertOutcome {
  const db = getDb();
  const existedBefore = !!db.prepare('SELECT 1 FROM repos WHERE id = ?').get(repo.id);

  db.prepare(
    `INSERT INTO repos (id, name, stars, syncedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, stars = excluded.stars, syncedAt = excluded.syncedAt`,
  ).run(repo.id, repo.name, repo.stars, repo.syncedAt);

  return existedBefore ? 'updated' : 'inserted';
}

/** Removes repositories not touched by the full pass that started at `passStartedAt`. */
export function pruneRepos(passStartedAt: string): number {
  const { changes } = getDb().prepare('DELETE FROM repos WHERE syncedAt < ?').run(passStartedAt);
  return Number(changes);
}
