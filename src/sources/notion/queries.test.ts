// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { saveSyncState } from '../../core/sync/state.js';
import { resetDb } from '../../testing/helpers.js';
import { getRecentItems, search } from './queries.js';
import { upsertPage } from './store.js';

const now = '2026-03-01T00:00:00Z';
const addPage = (id: string, title: string, lastEditedTime: string) =>
  upsertPage({ id, title, url: `https://notion.so/${id}`, lastEditedTime, syncedAt: now });

describe('notion queries', () => {
  beforeEach(resetDb);

  it('orders by last edit, most recent first', async () => {
    saveSyncState('notion', { watermark: now, lastSuccessAt: '2026-03-01T12:00:00Z' });
    addPage('a', 'Old', '2026-01-01T00:00:00.000Z');
    addPage('b', 'New', '2026-06-01T00:00:00.000Z');

    expect(getRecentItems({}).items.map((i) => i.title)).toEqual(['New', 'Old']);
  });

  it('returns the honest empty case', async () => {
    expect(getRecentItems({})).toMatchObject({ source: 'notion', count: 0, lastSyncAt: null });
  });

  it('clamps the limit like every other query', async () => {
    for (let i = 1; i <= 25; i++)
      addPage(`p${i}`, `Page ${i}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`);

    expect(getRecentItems({ limit: 100 }).items).toHaveLength(20);
  });

  it('searches titles literally and case-insensitively', async () => {
    addPage('a', 'Q3 Roadmap', '2026-01-01T00:00:00.000Z');
    addPage('b', 'Notes', '2026-01-01T00:00:00.000Z');

    expect((await search({ query: 'roadmap' })).items.map((i) => i.id)).toEqual(['a']);
    expect((await search({ query: '%' })).items).toHaveLength(0);
  });
});
