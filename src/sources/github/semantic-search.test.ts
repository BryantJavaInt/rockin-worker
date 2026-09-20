// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexDocuments } from '../../core/search/indexer.js';
import { useEmbeddingProvider } from '../../infra/embeddings/provider.js';
import { CONCEPTS, fakeEmbeddings } from '../../testing/embeddings.js';
import { resetDb } from '../../testing/helpers.js';
import { listRepoDocuments } from './documents.js';
import { search } from './queries.js';
import { upsertRepo } from './store.js';

const add = (id: number, name: string, description: string, extra: object = {}) =>
  upsertRepo({ id, name, stars: 1, syncedAt: '2026-03-01T00:00:00Z', description, ...extra });

async function index(provider = fakeEmbeddings(CONCEPTS)) {
  useEmbeddingProvider(provider);
  await indexDocuments({ source: 'github', documents: listRepoDocuments(), provider });
  return provider;
}

describe('github semantic search', () => {
  beforeEach(resetDb);
  afterEach(() => useEmbeddingProvider(undefined));

  it('finds a repository by meaning when not one of its words matches the query', async () => {
    add(1, 'habit-tracker', 'Track daily habits and streaks');
    add(2, 'ledger', 'Budget and money management');
    await index();

    const result = await search({ query: 'routine' }); // shares no word with either repo

    expect(result.ranking).toBe('hybrid');
    expect(result.items.map((i) => i.name)).toEqual(['habit-tracker']);
  });

  it('puts the lexical match first and adds semantic neighbours after it', async () => {
    add(1, 'habit-tracker', 'Track daily habits and streaks');
    add(2, 'planner', 'A daily routine planner');
    add(3, 'ledger', 'Budget and money management');
    await index();

    const names = (await search({ query: 'habit' })).items.map((i) => i.name);

    expect(names[0]).toBe('habit-tracker');
    expect(names).toContain('planner');
    expect(names).not.toContain('ledger');
  });

  it('degrades to the lexical result, with a note, when the provider fails', async () => {
    add(1, 'habit-tracker', 'Track daily habits');
    const provider = await index();
    provider.embed = async () => {
      throw new Error('provider timed out');
    };

    const result = await search({ query: 'habit' });

    expect(result.ranking).toBe('lexical');
    expect(result.items.map((i) => i.name)).toEqual(['habit-tracker']);
    expect(result.note).toMatch(/unavailable \(provider timed out\)/);
  });

  it('says the index is missing when a provider is configured but embed has not run', async () => {
    add(1, 'habit-tracker', 'Track daily habits');
    useEmbeddingProvider(fakeEmbeddings(CONCEPTS));

    const result = await search({ query: 'habit' });

    expect(result.ranking).toBe('lexical');
    expect(result.note).toMatch(/not indexed/);
  });

  it('describes a repository to the embedder with everything a person would search by', () => {
    add(1, 'crdt-lab', 'Offline-first experiments', {
      language: 'Rust',
      topics: ['crdt', 'sync'],
    });

    expect(listRepoDocuments()).toEqual([
      {
        id: '1',
        text: 'crdt-lab. Offline-first experiments. Language: Rust. Topics: crdt, sync',
      },
    ]);
  });
});
