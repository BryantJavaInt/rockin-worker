// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { childrenOf, installTestTracing } from '../../testing/telemetry.js';
import type { SyncAdapter } from './adapter.js';
import { runSync } from './engine.js';

const tracing = installTestTracing();
afterAll(() => tracing.uninstall());
beforeEach(() => {
  resetDb();
  tracing.reset();
});

type Rec = { id: number; at: string };

function adapter(pages: Rec[][], failOnPage?: number): SyncAdapter<Rec> {
  return {
    source: 'fake',
    async fetchPage(cursor) {
      const index = cursor ? Number(cursor) : 0;
      if (failOnPage === index) throw new Error('page failed');
      return {
        records: pages[index] ?? [],
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
    },
    parse: (raw) => {
      const r = raw as Rec;
      return { modifiedAt: r.at, value: r };
    },
    upsert: () => 'inserted',
  };
}

const noLog = () => {};
const rec = (id: number, at: string): Rec => ({ id, at });

describe('sync telemetry', () => {
  it('emits one span per run with the summary as attributes, and one child per page fetched', async () => {
    await runSync(adapter([[rec(1, '2026-03-02T00:00:00Z')], [rec(2, '2026-03-01T00:00:00Z')]]), {
      logRun: noLog,
    });

    const [run] = tracing.named('sync fake');
    expect(run?.attributes).toMatchObject({
      'sync.source': 'fake',
      'sync.full': false,
      'sync.fetched': 2,
      'sync.inserted': 2,
      'sync.errors': 0,
      'sync.api_calls': 2,
      'sync.capped': false,
    });
    const pages = childrenOf(run as never, tracing.spans());
    expect(pages.map((p) => p.name)).toEqual(['sync.fetch_page', 'sync.fetch_page']);
    expect(pages.map((p) => p.attributes['sync.page'])).toEqual([1, 2]);
    expect(pages.map((p) => p.attributes['sync.records'])).toEqual([1, 1]);
  });

  it('marks the run and the failing page as errors when an upstream fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSync(adapter([[rec(1, '2026-03-02T00:00:00Z')], []], 1), { logRun: noLog });

    expect(tracing.named('sync fake')[0]?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'page failed',
    });
    expect(tracing.named('sync.fetch_page').map((s) => s.status.code)).toEqual([
      SpanStatusCode.UNSET,
      SpanStatusCode.ERROR,
    ]);
    warn.mockRestore();
  });

  it('records how a run was resumed or capped', async () => {
    const pages = [[rec(1, '2026-03-03T00:00:00Z')], [rec(2, '2026-03-02T00:00:00Z')]];
    await runSync(adapter(pages), { maxPages: 1, logRun: noLog });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runSync(adapter(pages), { maxPages: 1, logRun: noLog });

    const [first, second] = tracing.named('sync fake');
    expect(first?.attributes).toMatchObject({ 'sync.capped': true, 'sync.resumed': false });
    expect(second?.attributes).toMatchObject({ 'sync.resumed': true });
    warn.mockRestore();
  });
});
