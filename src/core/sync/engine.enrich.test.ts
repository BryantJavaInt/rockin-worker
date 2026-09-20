// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import type { SyncAdapter } from './adapter.js';
import { runSync } from './engine.js';
import { getSyncState, saveSyncState } from './state.js';

type Rec = { id: number; at: string };
const rec = (id: number, at: string): Rec => ({ id, at });
const noLog = () => {};

/** A single-page adapter with an `enrich` hook, so the engine's second phase is tested in isolation. */
function makeAdapter(records: unknown[], enrich?: SyncAdapter<Rec>['enrich']) {
  const store = new Map<number, Rec>();
  const adapter: SyncAdapter<Rec> = {
    source: 'fake',
    async fetchPage() {
      return { records, nextCursor: null };
    },
    parse(raw) {
      const r = raw as Partial<Rec> | null;
      return typeof r?.id === 'number' && typeof r.at === 'string'
        ? { modifiedAt: r.at, value: { id: r.id, at: r.at } }
        : null;
    },
    upsert(value) {
      const existed = store.has(value.id);
      store.set(value.id, value);
      return existed ? 'updated' : 'inserted';
    },
    ...(enrich ? { enrich } : {}),
  };
  return { adapter, store };
}

describe('runSync: enrichment', () => {
  beforeEach(resetDb);

  it('stores what the adapter returned from enrich, in order', async () => {
    const { adapter, store } = makeAdapter(
      [rec(1, '2026-03-03T00:00:00Z'), rec(2, '2026-03-02T00:00:00Z')],
      async (values) => values.map((value) => ({ ...value, at: `${value.at}#enriched` })),
    );

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary).toMatchObject({ fetched: 2, inserted: 2, errors: 0 });
    expect(store.get(1)?.at).toBe('2026-03-03T00:00:00Z#enriched');
    expect(store.get(2)?.at).toBe('2026-03-02T00:00:00Z#enriched');
  });

  it('enriches only the records that will be stored, never those older than the watermark', async () => {
    saveSyncState('fake', { watermark: '2026-01-10T00:00:00Z', lastSuccessAt: null });
    const enrich = vi.fn(async (values: Rec[]) => values);
    const { adapter } = makeAdapter(
      [rec(1, '2026-01-12T00:00:00Z'), rec(2, '2026-01-05T00:00:00Z')],
      enrich,
    );

    await runSync(adapter, { logRun: noLog });

    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0]?.[0]).toEqual([rec(1, '2026-01-12T00:00:00Z')]);
  });

  it('does not call enrich for a page with nothing to store', async () => {
    const enrich = vi.fn(async (values: Rec[]) => values);
    const { adapter } = makeAdapter([{ nope: true }], enrich);

    await runSync(adapter, { logRun: noLog });

    expect(enrich).not.toHaveBeenCalled();
  });

  it('writes nothing and keeps the run retryable when enrich fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, store } = makeAdapter([rec(1, '2026-03-03T00:00:00Z')], async () => {
      throw new Error('Notion is down');
    });

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toBe('Notion is down');
    expect(store.size).toBe(0);
    expect(getSyncState('fake').watermark).toBeNull();
    warn.mockRestore();
  });

  it('rejects an enrich that returns a different number of values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, store } = makeAdapter([rec(1, '2026-03-03T00:00:00Z')], async () => []);

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toMatch(/0 values for 1 records/);
    expect(store.size).toBe(0);
    warn.mockRestore();
  });
});
