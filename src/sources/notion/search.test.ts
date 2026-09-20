// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { search } from './queries.js';
import { prunePages, upsertPage } from './store.js';

const add = (id: string, title: string, lastEditedTime: string) =>
  upsertPage({
    id,
    title,
    url: `https://notion.so/${id}`,
    lastEditedTime,
    syncedAt: '2026-03-01T00:00:00Z',
  });

describe('notion ranked search', () => {
  beforeEach(resetDb);

  it('stems and matches every word in any order', () => {
    add('a', 'Q3 Planning notes', '2026-01-01T00:00:00.000Z');
    add('b', 'Q4 Budget', '2026-01-02T00:00:00.000Z');

    expect(search({ query: 'plans q3' }).items.map((i) => i.id)).toEqual(['a']);
  });

  it('ranks the tighter title first', () => {
    add('long', 'Roadmap review meeting notes for the whole quarter', '2026-01-01T00:00:00.000Z');
    add('short', 'Roadmap', '2026-01-01T00:00:00.000Z');

    expect(search({ query: 'roadmap' }).items[0]?.id).toBe('short');
  });

  it('falls back to a substring for text inside a word', () => {
    add('a', 'Roadmapping session', '2026-01-01T00:00:00.000Z');

    expect(search({ query: 'mapping' }).items.map((i) => i.id)).toEqual(['a']);
  });

  it('keeps the index in step with updates and deletions', () => {
    add('a', 'Old title', '2026-01-01T00:00:00.000Z');
    add('a', 'Fresh heading', '2026-01-02T00:00:00.000Z'); // upsert → UPDATE trigger

    expect(search({ query: 'old' }).items).toHaveLength(0);
    expect(search({ query: 'fresh' }).items.map((i) => i.id)).toEqual(['a']);

    prunePages('9999-01-01T00:00:00Z');
    expect(search({ query: 'fresh' }).items).toHaveLength(0);
  });

  it.each(['"unbalanced', 'NEAR(a b)', 'a OR', '*', '(('])(
    'survives the hostile query %j',
    (query) => {
      add('a', 'Safe', '2026-01-01T00:00:00.000Z');

      expect(() => search({ query })).not.toThrow();
    },
  );
});
