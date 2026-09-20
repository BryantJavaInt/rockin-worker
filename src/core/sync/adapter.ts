// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

// The port every data source implements. It lives on its own, with no imports, so
// sources depend on this contract rather than on the engine that drives it.

export type UpsertOutcome = 'inserted' | 'updated';

export type Page = {
  records: unknown[];
  /** Opaque cursor for the next page, or null when upstream has no more data. */
  nextCursor: string | null;
};

/**
 * Everything a data source has to provide. The engine owns the loop —
 * pagination, watermark cutoff, transactions, summary, logging — so adding a
 * source means writing this small adapter, not another copy of the loop.
 */
export interface SyncAdapter<T> {
  readonly source: string;

  /**
   * Fetches one page. Throw on any upstream failure (HTTP error, unexpected
   * envelope). Records MUST come back newest-modified-first: the engine relies
   * on that ordering to stop at the watermark.
   */
  fetchPage(cursor: string | null): Promise<Page>;

  /** Validates one raw record. Return null for a malformed record (it is skipped, not fatal). */
  parse(raw: unknown): { modifiedAt: string; value: T } | null;

  upsert(value: T): UpsertOutcome;

  /**
   * Stable identity of a parsed record. Together with `prune`, this lets a full
   * sync notice records that were deleted upstream. Omit both to keep deletions local.
   */
  keyOf?(value: T): string | number;

  /** Deletes every local record whose key is not in `keep`; returns how many were removed. */
  prune?(keep: ReadonlySet<string | number>): number;
}
