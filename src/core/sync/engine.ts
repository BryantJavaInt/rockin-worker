// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { loadConfig } from '../../config/index.js';
import { withTransaction } from '../../infra/db/connection.js';
import { describeError } from '../../infra/errors.js';
import { logSyncRun, type RunLogEntry } from '../../infra/logging/run-log.js';
import { markError, traced } from '../../infra/telemetry/tracing.js';
import type { Page, SyncAdapter } from './adapter.js';
import { getSyncState, saveSyncState } from './state.js';

export type SyncSummary = {
  source: string;
  fetched: number;
  inserted: number;
  updated: number;
  /** Local records removed because they no longer exist upstream (complete full passes only). */
  deleted: number;
  /** Malformed upstream records that failed validation. */
  skipped: number;
  errors: number;
  lastError: string | null;
  apiCalls: number;
  durationMs: number;
  /** True when the page budget ran out with data still upstream; the next run resumes from a saved cursor. */
  capped: boolean;
  /** True when this run continued an unfinished pass instead of starting a new one. */
  resumed: boolean;
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

const toNewest = (iso: string | null): Newest | null =>
  iso !== null && !Number.isNaN(Date.parse(iso)) ? { ms: Date.parse(iso), iso } : null;

async function runSyncImpl<T>(
  adapter: SyncAdapter<T>,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const startedAt = new Date();
  const full = options.full ?? false;
  const maxPages = options.maxPages ?? loadConfig().SYNC_MAX_PAGES;
  const previous = getSyncState(adapter.source);
  const watermarkBefore = full ? null : previous.watermark;
  const watermarkMs = watermarkBefore ? Date.parse(watermarkBefore) : null;

  // An unfinished pass resumes only in the mode it started in: a full pass must not be
  // continued by an incremental run (or vice versa), because their stop rules differ.
  const resumable = previous.pass !== null && previous.pass.full === full ? previous.pass : null;
  const passStartedAt = resumable?.startedAt ?? startedAt.toISOString();
  const fetchedBefore = resumable?.fetched ?? 0;

  const summary: SyncSummary = {
    source: adapter.source,
    fetched: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
    apiCalls: 0,
    durationMs: 0,
    capped: false,
    resumed: resumable !== null,
    full,
    watermarkBefore: previous.watermark,
    watermarkAfter: previous.watermark,
  };

  let cursor: string | null = resumable?.cursor ?? null;
  let pagesFetched = 0;
  let reachedWatermark = false;
  let exhausted = false;
  let newest: Newest | null = toNewest(resumable?.newest ?? null);

  while (pagesFetched < maxPages) {
    let page: Page;
    summary.apiCalls++;
    try {
      page = await traced(
        'sync.fetch_page',
        { 'sync.source': adapter.source, 'sync.page': pagesFetched + 1 },
        async (span) => {
          const fetched = await adapter.fetchPage(cursor);
          span.setAttribute('sync.records', fetched.records.length);
          return fetched;
        },
      );
    } catch (err) {
      summary.errors++;
      summary.lastError = describeError(err);
      console.warn(`[${adapter.source}] fetch failed: ${summary.lastError}`);
      break;
    }
    pagesFetched++;

    // A page is handled in three phases so that slow, fallible network work never happens
    // inside a database transaction:
    //   1. validate every record and find where the watermark cuts the page (pure, no I/O);
    //   2. let the adapter enrich what will actually be stored (e.g. fetch a Notion page body);
    //   3. write the whole page in one transaction.
    // Counters are merged only after COMMIT, so a rolled-back page can never leave the summary
    // claiming rows that were not written.
    const accepted: Array<{ value: T; modifiedMs: number; iso: string }> = [];
    let skippedInPage = 0;
    let hitWatermark = false;

    for (const raw of page.records) {
      const parsed = adapter.parse(raw);
      const modifiedMs = parsed ? Date.parse(parsed.modifiedAt) : Number.NaN;

      if (!parsed || Number.isNaN(modifiedMs)) {
        skippedInPage++;
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

      accepted.push({ value: parsed.value, modifiedMs, iso: parsed.modifiedAt });
    }

    let values = accepted.map((record) => record.value);
    const enrich = adapter.enrich?.bind(adapter);
    if (enrich && values.length > 0) {
      try {
        const toEnrich = values;
        values = await traced(
          'sync.enrich_page',
          { 'sync.source': adapter.source, 'sync.records': toEnrich.length },
          () => enrich(toEnrich),
        );
        if (values.length !== accepted.length) {
          throw new Error(
            `enrich returned ${values.length} values for ${accepted.length} records.`,
          );
        }
      } catch (err) {
        // A transient failure (rate limit, outage) must not store half-enriched records:
        // the page is not written, no state is saved, and the next run retries it.
        summary.errors++;
        summary.lastError = describeError(err);
        console.warn(`[${adapter.source}] enrich failed: ${summary.lastError}`);
        break;
      }
    }

    const local: PageStats = {
      fetched: 0,
      inserted: 0,
      updated: 0,
      skipped: skippedInPage,
      newest,
    };

    try {
      withTransaction(() => {
        accepted.forEach((record, index) => {
          local.fetched++;
          if (!local.newest || record.modifiedMs > local.newest.ms) {
            local.newest = { ms: record.modifiedMs, iso: record.iso };
          }
          local[adapter.upsert(values[index] as T)]++;
        });
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

  // The pass finished only if we reached the watermark or the end of the data. Running out of
  // page budget is not a failure: the pass is saved and resumed by the next run.
  const complete = summary.errors === 0 && (reachedWatermark || exhausted);
  summary.capped = summary.errors === 0 && !complete;
  const passFetched = fetchedBefore + summary.fetched;

  // Deletions: only a *complete* full pass has touched every upstream record, so only then is
  // "not touched since the pass began" equivalent to "deleted upstream". A pass that touched
  // nothing is refused outright — far more likely a token-scope or outage problem than an
  // account with nothing in it.
  const prune = adapter.prune?.bind(adapter);
  if (complete && full && prune) {
    if (passFetched === 0) {
      console.warn(
        `[${adapter.source}] full sync saw no records; refusing to prune the local store.`,
      );
    } else {
      try {
        summary.deleted = withTransaction(() => prune(passStartedAt));
      } catch (err) {
        summary.errors++;
        summary.lastError = describeError(err);
        console.warn(`[${adapter.source}] prune rolled back: ${summary.lastError}`);
      }
    }
  }

  if (summary.errors === 0) {
    const lastSuccessAt = new Date().toISOString();

    if (complete) {
      // The watermark only moves once the whole pass is done: records not yet reached are
      // OLDER than the newest one seen, so advancing it earlier would skip them for good.
      const watermark = newest?.iso ?? previous.watermark;
      saveSyncState(adapter.source, { watermark, lastSuccessAt, pass: null });
      summary.watermarkAfter = watermark;
    } else if (cursor !== null) {
      saveSyncState(adapter.source, {
        watermark: previous.watermark,
        lastSuccessAt,
        pass: {
          cursor,
          startedAt: passStartedAt,
          newest: newest?.iso ?? null,
          full,
          fetched: passFetched,
        },
      });
    }
  }
  // On error nothing is saved: the previous state (watermark and any saved cursor) stays, so
  // the next run retries from the last known-good point. Committed pages are idempotent.

  if (summary.capped) {
    console.warn(
      `[${adapter.source}] page budget (${maxPages}) reached with more data upstream; ` +
        'progress saved — the next run resumes from where this one stopped.',
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

/**
 * Runs one sync pass for a source and records it as a trace: one span for the run (with the
 * summary as attributes) and one child span per page fetched, under which the HTTP spans nest.
 */
export function runSync<T>(
  adapter: SyncAdapter<T>,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  return traced(
    `sync ${adapter.source}`,
    { 'sync.source': adapter.source, 'sync.full': options.full ?? false },
    async (span) => {
      const summary = await runSyncImpl(adapter, options);

      span.setAttributes({
        'sync.fetched': summary.fetched,
        'sync.inserted': summary.inserted,
        'sync.updated': summary.updated,
        'sync.deleted': summary.deleted,
        'sync.skipped': summary.skipped,
        'sync.errors': summary.errors,
        'sync.api_calls': summary.apiCalls,
        'sync.capped': summary.capped,
        'sync.resumed': summary.resumed,
      });
      // An error the engine handled (and reported in the summary) is still a failed run.
      if (summary.errors > 0) markError(span, summary.lastError ?? 'sync finished with errors');
      return summary;
    },
  );
}
