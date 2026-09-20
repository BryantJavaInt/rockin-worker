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
   * Optional second phase for data that needs extra requests per record (a Notion page body, for
   * instance). Called once per page with only the records that will actually be stored — after
   * validation and the watermark cutoff — and outside the database transaction, because it does
   * I/O. Must return exactly one value per input, in the same order.
   *
   * Throw on a transient failure (rate limit, outage): the page is then not written and is
   * retried by the next run. Handle a permanent per-record failure (e.g. 403) inside, by
   * returning that record without the extra data, so one unreadable record cannot block a sync.
   */
  enrich?(values: T[]): Promise<T[]>;

  /**
   * Deletes local records that were NOT touched since `passStartedAt` (ISO time), returning
   * how many were removed. Every upsert stamps the record with its sync time, so after a
   * complete full pass "not touched" means "deleted upstream" — even when the pass was spread
   * over several runs. Omit to keep deletions local.
   */
  prune?(passStartedAt: string): number;
}
