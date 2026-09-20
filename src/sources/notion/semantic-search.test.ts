// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexDocuments } from '../../core/search/indexer.js';
import { useEmbeddingProvider } from '../../infra/embeddings/provider.js';
import { CONCEPTS, fakeEmbeddings } from '../../testing/embeddings.js';
import { resetDb } from '../../testing/helpers.js';
import { listPageDocuments } from './documents.js';
import { search } from './queries.js';
import { upsertPage } from './store.js';

const add = (id: string, title: string) =>
  upsertPage({
    id,
    title,
    url: `https://notion.so/${id}`,
    lastEditedTime: '2026-03-01T00:00:00.000Z',
    syncedAt: '2026-03-01T00:00:00Z',
  });

describe('notion semantic search', () => {
  beforeEach(resetDb);
  afterEach(() => useEmbeddingProvider(undefined));

  it('finds a page by meaning: "habits" surfaces "Morning routine checklist"', async () => {
    add('a', 'Morning routine checklist');
    add('b', 'Quarterly budget review');
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    await indexDocuments({ source: 'notion', documents: listPageDocuments(), provider });

    const result = await search({ query: 'habits' });

    expect(result.ranking).toBe('hybrid');
    expect(result.items.map((i) => i.title)).toEqual(['Morning routine checklist']);
  });

  it('stays lexical, unchanged, when no provider is configured', async () => {
    add('a', 'Morning routine checklist');
    useEmbeddingProvider(null);

    const result = await search({ query: 'routine' });

    expect(result.ranking).toBe('lexical');
    expect(result.items.map((i) => i.id)).toEqual(['a']);
    expect(result.note).toBeUndefined();
  });
});
