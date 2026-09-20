// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../infra/db/connection.js';
import { resetDb } from '../../testing/helpers.js';
import type { SyncAdapter } from './adapter.js';
import { runSync } from './engine.js';
import { getSyncState, saveSyncState } from './state.js';

type Rec = { id: number; at: string };

const rec = (id: number, at: string): Rec => ({ id, at });

/** An in-memory adapter serving pre-baked pages, so the engine is tested with no network or source code. */
function makeAdapter(pages: unknown[][], overrides: Partial<SyncAdapter<Rec>> = {}) {
  const store = new Map<number, Rec>();
  const cursors: Array<string | null> = [];

  const adapter: SyncAdapter<Rec> = {
    source: 'fake',
    async fetchPage(cursor) {
      cursors.push(cursor);
      const index = cursor ? Number(cursor) : 0;
      return {
        records: pages[index] ?? [],
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
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
    keyOf: (value) => value.id,
    prune(keep) {
      let removed = 0;
      for (const id of [...store.keys()]) {
        if (!keep.has(id)) {
          store.delete(id);
          removed++;
        }
      }
      return removed;
    },
    ...overrides,
  };

  return { adapter, store, cursors };
}

const noLog = () => {};

describe('runSync: deletions', () => {
  beforeEach(resetDb);

  const stale = (store: Map<number, Rec>) => store.set(99, rec(99, '2020-01-01T00:00:00Z'));

  it('prunes records that no longer exist upstream, on a complete full sync', async () => {
    const { adapter, store } = makeAdapter([[rec(1, '2026-03-03T00:00:00Z')]]);
    stale(store);

    const summary = await runSync(adapter, { full: true, logRun: noLog });

    expect(summary.deleted).toBe(1);
    expect([...store.keys()]).toEqual([1]);
  });

  it('never prunes on an incremental sync (it has not seen the whole upstream)', async () => {
    const { adapter, store } = makeAdapter([[rec(1, '2026-03-03T00:00:00Z')]]);
    stale(store);

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary.deleted).toBe(0);
    expect(store.has(99)).toBe(true);
  });

  it('never prunes when the page budget ran out (unseen records are not deleted records)', async () => {
    const { adapter, store } = makeAdapter([
      [rec(1, '2026-03-03T00:00:00Z')],
      [rec(2, '2026-03-02T00:00:00Z')],
    ]);
    stale(store);

    const summary = await runSync(adapter, { full: true, maxPages: 1, logRun: noLog });

    expect(summary.capped).toBe(true);
    expect(store.has(99)).toBe(true);
  });

  it('never prunes after an error', async () => {
    const { adapter, store } = makeAdapter([], {
      async fetchPage() {
        throw new Error('boom');
      },
    });
    stale(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSync(adapter, { full: true, logRun: noLog });

    expect(store.has(99)).toBe(true);
    warn.mockRestore();
  });

  it('refuses to wipe the store when upstream returns nothing', async () => {
    const { adapter, store } = makeAdapter([[]]);
    stale(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runSync(adapter, { full: true, logRun: noLog });

    expect(summary.deleted).toBe(0);
    expect(store.has(99)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing to prune'));
    warn.mockRestore();
  });

  it('reports a failing prune as an error and rolls it back', async () => {
    const { adapter } = makeAdapter([[rec(1, '2026-03-03T00:00:00Z')]], {
      prune() {
        throw new Error('locked');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runSync(adapter, { full: true, logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toBe('locked');
    expect(getSyncState('fake').lastSuccessAt).toBeNull();
    warn.mockRestore();
  });

  it('leaves deletions alone for adapters that do not opt in', async () => {
    const { adapter, store } = makeAdapter([[rec(1, '2026-03-03T00:00:00Z')]], {
      keyOf: undefined,
      prune: undefined,
    });
    stale(store);

    await runSync(adapter, { full: true, logRun: noLog });

    expect(store.has(99)).toBe(true);
  });
});

describe('runSync', () => {
  beforeEach(resetDb);

  it('follows cursors until the source is exhausted and stamps the run', async () => {
    const { adapter, store, cursors } = makeAdapter([
      [rec(1, '2026-03-03T00:00:00Z'), rec(2, '2026-03-02T00:00:00Z')],
      [rec(3, '2026-03-01T00:00:00Z')],
    ]);

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary).toMatchObject({ fetched: 3, inserted: 3, updated: 0, errors: 0, apiCalls: 2 });
    expect(summary.capped).toBe(false);
    expect(cursors).toEqual([null, '1']);
    expect(store.size).toBe(3);
    expect(getSyncState('fake')).toMatchObject({ watermark: '2026-03-03T00:00:00Z' });
    expect(getSyncState('fake').lastSuccessAt).not.toBeNull();
  });

  it('stops at the watermark without fetching further pages', async () => {
    saveSyncState('fake', { watermark: '2026-01-10T00:00:00Z', lastSuccessAt: null });
    const { adapter, store, cursors } = makeAdapter([
      [
        rec(1, '2026-01-12T00:00:00Z'),
        rec(2, '2026-01-10T00:00:00Z'),
        rec(3, '2026-01-05T00:00:00Z'),
      ],
      [rec(4, '2026-01-01T00:00:00Z')],
    ]);

    const summary = await runSync(adapter, { logRun: noLog });

    expect([...store.keys()].sort()).toEqual([1, 2]);
    expect(summary.fetched).toBe(2);
    expect(cursors).toEqual([null]); // page 2 was never requested
    expect(summary.watermarkAfter).toBe('2026-01-12T00:00:00Z');
  });

  it('re-processes records equal to the watermark (at-least-once, idempotent)', async () => {
    saveSyncState('fake', { watermark: '2026-01-10T00:00:00Z', lastSuccessAt: null });
    const { adapter, store } = makeAdapter([[rec(1, '2026-01-10T00:00:00Z')]]);
    store.set(1, rec(1, '2026-01-10T00:00:00Z'));

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary).toMatchObject({ fetched: 1, inserted: 0, updated: 1 });
  });

  it('ignores the watermark on a full sync', async () => {
    saveSyncState('fake', { watermark: '2026-06-01T00:00:00Z', lastSuccessAt: null });
    const { adapter, store } = makeAdapter([[rec(1, '2026-01-01T00:00:00Z')]]);

    const summary = await runSync(adapter, { full: true, logRun: noLog });

    expect(store.size).toBe(1);
    expect(summary.full).toBe(true);
  });

  it('does not advance the watermark when the page budget runs out (would skip older records forever)', async () => {
    const { adapter } = makeAdapter([
      [rec(1, '2026-03-03T00:00:00Z')],
      [rec(2, '2026-03-02T00:00:00Z')],
    ]);

    const summary = await runSync(adapter, { maxPages: 1, logRun: noLog });

    expect(summary.capped).toBe(true);
    expect(summary.fetched).toBe(1);
    expect(getSyncState('fake').watermark).toBeNull();
  });

  it('keeps earlier pages but leaves the watermark alone when a later page fails', async () => {
    let calls = 0;
    const { adapter, store } = makeAdapter([[rec(1, '2026-03-03T00:00:00Z')], []], {
      async fetchPage() {
        if (++calls === 2) throw new Error('upstream exploded');
        return { records: [rec(1, '2026-03-03T00:00:00Z')], nextCursor: '1' };
      },
    });

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toBe('upstream exploded');
    expect(store.size).toBe(1);
    expect(getSyncState('fake')).toEqual({ watermark: null, lastSuccessAt: null });
  });

  it('skips malformed records without failing the run', async () => {
    const { adapter, store } = makeAdapter([
      [{ id: 'nope' }, rec(2, '2026-03-02T00:00:00Z'), null],
    ]);

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary).toMatchObject({ skipped: 2, fetched: 1, errors: 0 });
    expect(store.size).toBe(1);
  });

  it('skips a record whose timestamp is unparsable', async () => {
    const { adapter } = makeAdapter([[rec(1, 'not-a-date')]]);

    expect((await runSync(adapter, { logRun: noLog })).skipped).toBe(1);
  });

  it('rolls back a whole page if any write in it fails, and does not count its rows', async () => {
    const { adapter } = makeAdapter(
      [[rec(1, '2026-03-03T00:00:00Z'), rec(2, '2026-03-02T00:00:00Z')]],
      {
        upsert(value) {
          getDb().exec(`INSERT INTO repos VALUES (${value.id}, 'r', 1, 'x')`);
          if (value.id === 2) throw new Error('disk full');
          return 'inserted';
        },
      },
    );

    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.fetched).toBe(0);
    expect(summary.inserted).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 0 });
    expect(getSyncState('fake').lastSuccessAt).toBeNull();
  });

  it('reports inserted vs updated across repeated runs', async () => {
    const pages = [[rec(1, '2026-03-03T00:00:00Z'), rec(2, '2026-03-02T00:00:00Z')]];
    const { adapter } = makeAdapter(pages);

    const first = await runSync(adapter, { logRun: noLog });
    const incremental = await runSync(adapter, { logRun: noLog });
    const full = await runSync(adapter, { full: true, logRun: noLog });

    expect(first).toMatchObject({ inserted: 2, updated: 0 });
    // The watermark is record 1's timestamp: only that overlap record is revisited.
    expect(incremental).toMatchObject({ inserted: 0, updated: 1 });
    expect(full).toMatchObject({ inserted: 0, updated: 2 });
  });

  it('writes a structured log entry, and survives a failing logger', async () => {
    const { adapter } = makeAdapter([[rec(1, '2026-03-03T00:00:00Z')]]);
    const logRun = vi.fn();

    await runSync(adapter, { logRun });

    expect(logRun).toHaveBeenCalledOnce();
    expect(logRun.mock.calls[0]?.[0]).toMatchObject({
      source: 'fake',
      ok: true,
      summary: { fetched: 1 },
    });

    const failing = vi.fn(() => {
      throw new Error('log disk full');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runSync(adapter, { logRun: failing })).resolves.toMatchObject({ errors: 0 });
    warn.mockRestore();
  });
});
