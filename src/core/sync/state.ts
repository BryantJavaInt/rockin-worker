// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { getDb } from '../../infra/db/connection.js';

/**
 * Per-source sync bookkeeping.
 * - `watermark`: newest upstream modification time fully synced. The next run
 *   only needs records at or after it (incremental sync).
 * - `lastSuccessAt`: wall-clock time of the last error-free run. This is the
 *   honest "how fresh is my data" answer surfaced to the agent.
 */
export type SyncState = {
  watermark: string | null;
  lastSuccessAt: string | null;
};

export function getSyncState(source: string): SyncState {
  const row = getDb()
    .prepare('SELECT watermark, lastSuccessAt FROM sync_state WHERE source = ?')
    .get(source) as SyncState | undefined;

  // The column is NOT NULL (inherited from schema v1), so "no watermark" is stored as ''.
  return { watermark: row?.watermark || null, lastSuccessAt: row?.lastSuccessAt ?? null };
}

export function saveSyncState(source: string, state: SyncState): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (source, watermark, lastSuccessAt) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         watermark = excluded.watermark,
         lastSuccessAt = excluded.lastSuccessAt`,
    )
    .run(source, state.watermark ?? '', state.lastSuccessAt);
}
