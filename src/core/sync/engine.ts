// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { loadConfig } from '../../config/index.js';
import { withTransaction } from '../../infra/db/connection.js';
import { logSyncRun, type RunLogEntry } from '../../infra/logging/run-log.js';
import { describeError } from '../errors.js';
import type { Page, SyncAdapter } from './adapter.js';
import { getSyncState, saveSyncState } from './state.js';

export type SyncSummary = {
  source: string;
  fetched: number;
  inserted: number;
  updated: number;
  /** Malformed upstream records that failed validation. */
  skipped: number;
  errors: number;
  lastError: string | null;
  apiCalls: number;
  durationMs: number;
  /** True when the page budget ran out before reaching the watermark or the end of the data. */
  capped: boolean;
  full: boolean;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
};

type Newest = { ms: number; iso: string };
type PageStats = {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  newest: Newest | null;
};

export type SyncOptions = {
  /** Ignore the watermark and re-sync everything (still refreshes the watermark afterwards). */
  full?: boolean;
  maxPages?: number;
  logRun?: (entry: RunLogEntry) => void;
};

export async function runSync<T>(
  adapter: SyncAdapter<T>,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const startedAt = new Date();
  const maxPages = options.maxPages ?? loadConfig().SYNC_MAX_PAGES;
  const previous = getSyncState(adapter.source);
  const watermarkBefore = options.full ? null : previous.watermark;
  const watermarkMs = watermarkBefore ? Date.parse(watermarkBefore) : null;

  const summary: SyncSummary = {
    source: adapter.source,
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
    apiCalls: 0,
    durationMs: 0,
    capped: false,
    full: options.full ?? false,
    watermarkBefore: previous.watermark,
    watermarkAfter: previous.watermark,
  };

  let cursor: string | null = null;
  let pagesFetched = 0;
  let reachedWatermark = false;
  let exhausted = false;
  let newest: Newest | null = null;

  while (pagesFetched < maxPages) {
    let page: Page;
    summary.apiCalls++;
    try {
      page = await adapter.fetchPage(cursor);
    } catch (err) {
      summary.errors++;
      summary.lastError = describeError(err);
      console.warn(`[${adapter.source}] fetch failed: ${summary.lastError}`);
      break;
    }
    pagesFetched++;

    // Page-local counters are merged only after COMMIT, so a rolled-back page
    // can never leave the summary claiming rows that were not written.
    const local: PageStats = { fetched: 0, inserted: 0, updated: 0, skipped: 0, newest };
    let hitWatermark = false;

    try {
      withTransaction(() => {
        for (const raw of page.records) {
          const parsed = adapter.parse(raw);
          const modifiedMs = parsed ? Date.parse(parsed.modifiedAt) : Number.NaN;

          if (!parsed || Number.isNaN(modifiedMs)) {
            local.skipped++;
            continue;
          }

          // Strictly older than the watermark → everything after is already synced.
          // Records *equal* to it are re-processed on purpose: sources timestamp at
          // second/minute granularity (Notion: minute), so an edit landing in the same
          // tick as the last sync would otherwise be lost. Upserts are idempotent, so
          // the overlap costs a few redundant writes and buys at-least-once delivery.
          if (watermarkMs !== null && modifiedMs < watermarkMs) {
            hitWatermark = true;
            break;
          }

          local.fetched++;
          if (!local.newest || modifiedMs > local.newest.ms) {
            local.newest = { ms: modifiedMs, iso: parsed.modifiedAt };
          }
          local[adapter.upsert(parsed.value)]++;
        }
      });
    } catch (err) {
      summary.errors++;
      summary.lastError = describeError(err);
      console.warn(`[${adapter.source}] page rolled back: ${summary.lastError}`);
      break;
    }

    summary.fetched += local.fetched;
    summary.inserted += local.inserted;
    summary.updated += local.updated;
    summary.skipped += local.skipped;
    newest = local.newest;

    if (hitWatermark) {
      reachedWatermark = true;
      break;
    }
    if (page.nextCursor === null) {
      exhausted = true;
      break;
    }
    cursor = page.nextCursor;
  }

  summary.capped = summary.errors === 0 && !reachedWatermark && !exhausted;

  // Advance the watermark only on a complete, error-free run. If the page budget
  // ran out (capped), the records we did not reach are OLDER than the newest one
  // we saw — moving the watermark forward would skip them permanently.
  if (summary.errors === 0) {
    const watermark = !summary.capped && newest ? newest.iso : previous.watermark;
    saveSyncState(adapter.source, {
      watermark,
      lastSuccessAt: new Date().toISOString(),
    });
    summary.watermarkAfter = watermark;
  }

  if (summary.capped) {
    console.warn(
      `[${adapter.source}] stopped after ${maxPages} pages with more data upstream; ` +
        'watermark not advanced. Raise SYNC_MAX_PAGES to backfill.',
    );
  }

  summary.durationMs = Date.now() - startedAt.getTime();

  const entry: RunLogEntry = {
    source: adapter.source,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ok: summary.errors === 0,
    summary: { ...summary },
  };
  try {
    (options.logRun ?? logSyncRun)(entry);
  } catch (err) {
    // A logging failure must never fail (or hide the result of) a sync that worked.
    console.warn(`[${adapter.source}] could not write run log: ${describeError(err)}`);
  }

  return summary;
}
