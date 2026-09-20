// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { saveSyncState } from '../../core/sync/state.js';
import { resetDb } from '../../testing/helpers.js';
import { getTopItems, search } from './queries.js';
import { upsertRepo } from './store.js';

const now = '2026-03-01T00:00:00Z';
const addRepo = (id: number, name: string, stars: number) =>
  upsertRepo({ id, name, stars, syncedAt: now });

describe('github queries', () => {
  beforeEach(resetDb);

  it('returns the honest empty case for a store that was never synced', () => {
    expect(getTopItems({})).toMatchObject({ source: 'github', lastSyncAt: null, count: 0 });
  });

  it('orders by stars (ties broken by name) and reports real freshness', () => {
    saveSyncState('github', { watermark: now, lastSuccessAt: '2026-03-01T12:00:00Z' });
    addRepo(1, 'b-low', 2);
    addRepo(2, 'a-tie', 50);
    addRepo(3, 'b-tie', 50);

    const result = getTopItems({});

    expect(result.items.map((i) => i.name)).toEqual(['a-tie', 'b-tie', 'b-low']);
    expect(result).toMatchObject({ count: 3, lastSyncAt: '2026-03-01T12:00:00Z' });
    expect(result.note).toBeUndefined();
  });

  it('clamps the limit to 20 and defaults to 10', () => {
    for (let i = 1; i <= 25; i++) addRepo(i, `repo-${i}`, i);

    expect(getTopItems({ limit: 100 }).items).toHaveLength(20);
    expect(getTopItems({}).items).toHaveLength(10);
    expect(getTopItems({ limit: 3 }).items).toHaveLength(3);
  });

  it('matches substrings case-insensitively', () => {
    addRepo(1, 'FinTrack', 5);
    addRepo(2, 'other', 9);

    expect(search({ query: 'fin' }).items.map((i) => i.name)).toEqual(['FinTrack']);
  });

  it('treats LIKE wildcards in the query literally (a model-supplied "%" must not match everything)', () => {
    addRepo(1, 'plain', 1);
    addRepo(2, '100%_done', 1);

    expect(search({ query: '%' }).items.map((i) => i.name)).toEqual(['100%_done']);
    expect(search({ query: '_' }).items.map((i) => i.name)).toEqual(['100%_done']);
    expect(search({ query: 'p_ain' }).items).toHaveLength(0);
  });
});
