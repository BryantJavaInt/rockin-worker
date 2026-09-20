// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { search } from './queries.js';
import { upsertPage } from './store.js';

const add = (id: string, title: string, content?: string, edited = '2026-01-01T00:00:00.000Z') =>
  upsertPage({
    id,
    title,
    content,
    url: `https://notion.so/${id}`,
    lastEditedTime: edited,
    syncedAt: '2026-03-01T00:00:00Z',
  });

describe('notion body search', () => {
  beforeEach(resetDb);

  it('finds a page by words that appear only in its body, with a marked snippet', async () => {
    add('a', 'Meeting Notes', 'We agreed to migrate the billing service to PostgreSQL.');
    add('b', 'Groceries', 'Milk and eggs');

    const { items } = await search({ query: 'postgresql' });

    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(items[0]?.snippet).toContain('«PostgreSQL»');
  });

  it('ranks a title match above a body match', async () => {
    add('body', 'Weekly sync', 'Discussed the roadmap at length.');
    add('title', 'Roadmap', 'Nothing else.');

    expect((await search({ query: 'roadmap' })).items.map((i) => i.id)).toEqual(['title', 'body']);
  });

  it('gives no snippet when only the title matched', async () => {
    add('a', 'Roadmap', 'Some unrelated body text.');

    expect((await search({ query: 'roadmap' })).items[0]).not.toHaveProperty('snippet');
  });

  it('the substring fallback also looks inside bodies and builds a snippet', async () => {
    add('a', 'Notes', 'Kubernetes rollout: the reroutingtable was rebuilt on Friday.');

    const [item] = (await search({ query: 'routingtable' })).items;

    expect(item?.id).toBe('a');
    expect(item?.snippet).toContain('«routingtable»');
  });

  it('keeps the stored body when a sync ran without content (undefined)', async () => {
    add('a', 'Notes', 'Precious body text');
    add('a', 'Notes (renamed)', undefined, '2026-02-01T00:00:00.000Z');

    expect((await search({ query: 'precious' })).items.map((i) => i.id)).toEqual(['a']);
  });

  it('replaces the body when a sync provides a new one, including an empty one', async () => {
    add('a', 'Notes', 'Old body about zebras');
    add('a', 'Notes', '');

    expect((await search({ query: 'zebras' })).items).toHaveLength(0);
  });
});
