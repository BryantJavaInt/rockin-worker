// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { getDb } from '../../infra/db/connection.js';

/**
 * A sync pass that did not finish inside its page budget, saved so the next run can resume
 * from where it stopped instead of starting over (and never getting further than the budget).
 */
export type PassState = {
  /** Cursor of the next page to fetch. */
  cursor: string;
  /** When the pass began. Records not touched since then are the ones deleted upstream. */
  startedAt: string;
  /** Newest upstream modification time seen so far; becomes the watermark when the pass ends. */
  newest: string | null;
  /** A pass only resumes in the mode it started in (full vs incremental). */
  full: boolean;
  /** Records fetched by the earlier runs of this pass. */
  fetched: number;
};

/**
 * Per-source sync bookkeeping.
 * - `watermark`: newest upstream modification time fully synced. The next run
 *   only needs records at or after it (incremental sync).
 * - `lastSuccessAt`: wall-clock time of the last error-free run. This is the
 *   honest "how fresh is my data" answer surfaced to the agent.
 * - `pass`: an unfinished backfill, if any (see PassState).
 */
export type SyncState = {
  watermark: string | null;
  lastSuccessAt: string | null;
  pass: PassState | null;
};

type Row = {
  watermark: string;
  lastSuccessAt: string | null;
  passCursor: string | null;
  passStartedAt: string | null;
  passNewest: string | null;
  passFull: number | null;
  passFetched: number | null;
};

export function getSyncState(source: string): SyncState {
  const row = getDb()
    .prepare(
      `SELECT watermark, lastSuccessAt, passCursor, passStartedAt, passNewest, passFull, passFetched
       FROM sync_state WHERE source = ?`,
    )
    .get(source) as Row | undefined;

  const pass: PassState | null =
    row?.passCursor && row.passStartedAt
      ? {
          cursor: row.passCursor,
          startedAt: row.passStartedAt,
          newest: row.passNewest,
          full: row.passFull === 1,
          fetched: row.passFetched ?? 0,
        }
      : null;

  // The watermark column is NOT NULL (inherited from schema v1), so "none" is stored as ''.
  return { watermark: row?.watermark || null, lastSuccessAt: row?.lastSuccessAt ?? null, pass };
}

export function saveSyncState(
  source: string,
  state: Pick<SyncState, 'watermark' | 'lastSuccessAt'> & { pass?: PassState | null },
): void {
  const pass = state.pass ?? null;

  getDb()
    .prepare(
      `INSERT INTO sync_state
         (source, watermark, lastSuccessAt, passCursor, passStartedAt, passNewest, passFull, passFetched)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         watermark = excluded.watermark,
         lastSuccessAt = excluded.lastSuccessAt,
         passCursor = excluded.passCursor,
         passStartedAt = excluded.passStartedAt,
         passNewest = excluded.passNewest,
         passFull = excluded.passFull,
         passFetched = excluded.passFetched`,
    )
    .run(
      source,
      state.watermark ?? '',
      state.lastSuccessAt,
      pass?.cursor ?? null,
      pass?.startedAt ?? null,
      pass?.newest ?? null,
      pass ? (pass.full ? 1 : 0) : null,
      pass?.fetched ?? null,
    );
}
