// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { getTopItems, search } from './queries.js';
import { pruneRepos, upsertRepo } from './store.js';

const now = '2026-03-01T00:00:00Z';
const add = (id: number, name: string, description: string | null, extra: object = {}) =>
  upsertRepo({ id, name, stars: 1, syncedAt: now, description, ...extra });

describe('github ranked search', () => {
  beforeEach(resetDb);

  it('ranks a name match above a description-only match', () => {
    add(1, 'notes', 'A tracker for reading progress');
    add(2, 'tracker', 'Something else entirely');

    expect(search({ query: 'tracker' }).items.map((i) => i.name)).toEqual(['tracker', 'notes']);
  });

  it('stems words, so "habits" finds a description that says "habit"', () => {
    add(1, 'app-a', 'Build a daily habit');
    add(2, 'app-b', 'Unrelated');

    expect(search({ query: 'habits' }).items.map((i) => i.name)).toEqual(['app-a']);
  });

  it('requires every word, in any order', () => {
    add(1, 'a', 'daily habits tracker');
    add(2, 'b', 'daily standup notes');

    expect(search({ query: 'habits daily' }).items.map((i) => i.name)).toEqual(['a']);
  });

  it('searches topics and returns the enriched fields', () => {
    add(1, 'crdt-lab', 'Experiments', {
      topics: ['crdt', 'sync'],
      language: 'Rust',
      url: 'https://github.com/x/crdt-lab',
    });

    const [item] = search({ query: 'crdt' }).items;

    expect(item).toMatchObject({
      name: 'crdt-lab',
      language: 'Rust',
      topics: ['crdt', 'sync'],
      url: 'https://github.com/x/crdt-lab',
    });
  });

  it('falls back to a substring match for text inside a word', () => {
    add(1, 'flagship-app', null);

    expect(search({ query: 'ship' }).items.map((i) => i.name)).toEqual(['flagship-app']);
  });

  it('marks searches as lexically ranked, and plain listings as unranked', () => {
    expect(search({ query: 'x' }).ranking).toBe('lexical');
    expect(getTopItems({}).ranking).toBeUndefined();
  });

  it('keeps the index in step with updates and deletions', () => {
    add(1, 'old-name', 'legacy tool');
    add(1, 'new-name', 'modern tool'); // upsert → UPDATE trigger

    expect(search({ query: 'legacy' }).items).toHaveLength(0);
    expect(search({ query: 'modern' }).items.map((i) => i.name)).toEqual(['new-name']);

    pruneRepos('9999-01-01T00:00:00Z'); // delete everything → DELETE trigger
    expect(search({ query: 'modern' }).items).toHaveLength(0);
  });

  it.each([
    '"unbalanced',
    'NEAR(a b)',
    'a OR',
    '*',
    '((',
    "'; DROP TABLE repos; --",
    'name:x',
    '-x',
  ])('survives the hostile query %j without throwing', (query) => {
    add(1, 'safe', 'safe repo');

    expect(() => search({ query })).not.toThrow();
    expect(getTopItems({}).count).toBe(1); // and the table is intact
  });
});
