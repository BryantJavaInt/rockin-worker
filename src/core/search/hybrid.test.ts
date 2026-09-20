// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEmbeddingProvider } from '../../infra/embeddings/provider.js';
import { CONCEPTS, fakeEmbeddings } from '../../testing/embeddings.js';
import { resetDb } from '../../testing/helpers.js';
import { saveEmbeddings } from './embedding-store.js';
import { hybridRank, reciprocalRankFusion, semanticRank } from './hybrid.js';
import { normalize } from './vector.js';

describe('reciprocalRankFusion', () => {
  it('prefers an id ranked well by BOTH lists over one ranked first by only one', () => {
    expect(
      reciprocalRankFusion([
        ['a', 'b', 'c'],
        ['d', 'b', 'e'],
      ])[0],
    ).toBe('b');
  });

  it('keeps every id from every list, once', () => {
    expect(
      reciprocalRankFusion([
        ['a', 'b'],
        ['c', 'a'],
      ]).sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties in favour of the first list (lexical)', () => {
    expect(reciprocalRankFusion([['x'], ['y']])).toEqual(['x', 'y']);
  });

  it('handles empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], ['a']])).toEqual(['a']);
  });
});

const vec = (...xs: number[]) => normalize(xs);
const store = (id: string, vector: Float32Array, model = 'fake-model') =>
  saveEmbeddings('github', model, [{ id, textHash: 'h', vector }]);

describe('semanticRank', () => {
  beforeEach(resetDb);

  it('orders by cosine similarity and applies the score floor and limit', () => {
    store('near', vec(1, 0.1));
    store('mid', vec(1, 1));
    store('far', vec(0, 1));

    const q = vec(1, 0);
    expect(semanticRank('github', q, 'fake-model', { limit: 10, minScore: 0 })).toEqual([
      'near',
      'mid',
      'far',
    ]);
    expect(semanticRank('github', q, 'fake-model', { limit: 10, minScore: 0.5 })).toEqual([
      'near',
      'mid',
    ]);
    expect(semanticRank('github', q, 'fake-model', { limit: 1, minScore: 0 })).toEqual(['near']);
  });

  it('ignores vectors from a different model (their space is incomparable)', () => {
    store('other', vec(1, 0), 'another-model');

    expect(semanticRank('github', vec(1, 0), 'fake-model', { limit: 10, minScore: 0 })).toEqual([]);
  });
});

describe('hybridRank', () => {
  beforeEach(resetDb);
  afterEach(() => useEmbeddingProvider(undefined));

  const lexicalIds = ['1', '2'];

  it('is lexical when no provider is configured', async () => {
    useEmbeddingProvider(null);

    expect(await hybridRank({ source: 'github', query: 'q', lexicalIds })).toEqual({
      ids: lexicalIds,
      ranking: 'lexical',
    });
  });

  it('says so when a provider is configured but nothing is indexed yet', async () => {
    useEmbeddingProvider(fakeEmbeddings(CONCEPTS));

    const result = await hybridRank({ source: 'github', query: 'q', lexicalIds });

    expect(result).toMatchObject({ ids: lexicalIds, ranking: 'lexical' });
    expect(result.warning).toMatch(/not indexed/);
  });

  it('fuses lexical and semantic rankings, surfacing semantic-only matches', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    store('9', normalize((await provider.embed(['daily routine'], 'document'))[0] as number[]));

    const result = await hybridRank({ source: 'github', query: 'habits', lexicalIds });

    expect(result.ranking).toBe('hybrid');
    expect(result.ids).toContain('9'); // no lexical hit at all, found by meaning
    expect(provider.calls.at(-1)).toEqual({ texts: ['habits'], kind: 'query' });
  });

  it('degrades to lexical, with a warning, when the provider fails', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    store('9', vec(1, 0, 0, 0));
    provider.embed = async () => {
      throw new Error('Voyage is down');
    };

    const result = await hybridRank({ source: 'github', query: 'q', lexicalIds });

    expect(result).toMatchObject({ ids: lexicalIds, ranking: 'lexical' });
    expect(result.warning).toMatch(/unavailable \(Voyage is down\)/);
  });

  it('stays lexical when nothing clears the similarity floor', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    store('9', normalize((await provider.embed(['budget money'], 'document'))[0] as number[]));

    const result = await hybridRank({ source: 'github', query: 'habits', lexicalIds });

    expect(result).toEqual({ ids: lexicalIds, ranking: 'lexical' });
  });
});
