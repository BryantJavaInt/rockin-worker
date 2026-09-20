// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { getSyncState } from './sync/state.js';

// Shared building blocks for the read-only queries every source exposes.

export type QueryResult<T> = {
  source: string;
  /** Wall-clock time of the last successful sync, or null if it has never run. */
  lastSyncAt: string | null;
  count: number;
  items: T[];
  /** Present when there are no items, to keep the model honest about *why*. */
  note?: string;
};

export function buildResult<T>(source: string, items: T[]): QueryResult<T> {
  const { lastSuccessAt } = getSyncState(source);
  const result: QueryResult<T> = { source, lastSyncAt: lastSuccessAt, count: items.length, items };

  if (items.length === 0) {
    result.note = lastSuccessAt
      ? 'No matching items in the local store.'
      : `The ${source} source has never been synced, so the local store is empty. Run a sync first.`;
  }
  return result;
}

const DEFAULT_LIMIT = 10;
export const MAX_RESULTS = 20;

/** Clamps instead of rejecting: a model asking for 50 should get 20, not an error. */
export function clampLimit(limit: number | undefined): number {
  return limit && limit > 0 ? Math.min(Math.floor(limit), MAX_RESULTS) : DEFAULT_LIMIT;
}

/** Escapes LIKE wildcards so user/LLM input is matched literally ("%" must not match everything). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}
