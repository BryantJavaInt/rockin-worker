// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
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
  ranking?: 'lexical' | 'hybrid';
};

/** Zod schema of the envelope every query returns; `item` describes one element of `items`. */
export const queryResultSchema = <I extends z.ZodType>(item: I) =>
  z.object({
    source: z.string(),
    lastSyncAt: z.string().nullable(),
    count: z.number().int(),
    items: z.array(item),
    note: z.string().optional(),
    /** How a search was ranked; absent for plain listings. */
    ranking: z.enum(['lexical', 'hybrid']).optional(),
  });

export function buildResult<T>(
  source: string,
  items: T[],
  ranking?: QueryResult<T>['ranking'],
): QueryResult<T> {
  const { lastSuccessAt } = getSyncState(source);
  const result: QueryResult<T> = { source, lastSyncAt: lastSuccessAt, count: items.length, items };
  if (ranking) result.ranking = ranking;

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

/**
 * Turns free text into a safe FTS5 query: every word becomes a quoted prefix term, all of them
 * required ("q3 road" → "q3"* "road"*). Quoting means user/LLM input can never inject FTS
 * syntax (NEAR, OR, column filters, unbalanced quotes). Null when the text has no word at all.
 */
export function ftsMatchQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 ? words.map((word) => `"${word}"*`).join(' ') : null;
}
