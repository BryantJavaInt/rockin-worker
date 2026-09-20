// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { CONCEPTS, fakeEmbeddings } from '../../testing/embeddings.js';
import { resetDb } from '../../testing/helpers.js';
import { listEmbeddings } from './embedding-store.js';
import { indexDocuments } from './indexer.js';

const docs = (...texts: string[]) => texts.map((text, i) => ({ id: String(i + 1), text }));
const embeddedTexts = (provider: ReturnType<typeof fakeEmbeddings>) =>
  provider.calls.filter((c) => c.kind === 'document').flatMap((c) => c.texts);

describe('indexDocuments', () => {
  beforeEach(resetDb);

  it('embeds new documents as documents (not queries) and stores them', async () => {
    const provider = fakeEmbeddings(CONCEPTS);

    const summary = await indexDocuments({
      source: 'github',
      documents: docs('daily habits', 'money budget'),
      provider,
    });

    expect(summary).toEqual({
      source: 'github',
      model: 'fake-model',
      embedded: 2,
      unchanged: 0,
      removed: 0,
    });
    expect(provider.calls.every((c) => c.kind === 'document')).toBe(true);
    expect(listEmbeddings('github')).toHaveLength(2);
  });

  it('skips unchanged documents, so a re-run costs nothing', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    await indexDocuments({ source: 'github', documents: docs('a b', 'c d'), provider });
    provider.calls.length = 0;

    const summary = await indexDocuments({
      source: 'github',
      documents: docs('a b', 'c d'),
      provider,
    });

    expect(summary).toMatchObject({ embedded: 0, unchanged: 2 });
    expect(provider.calls).toHaveLength(0);
  });

  it('re-embeds only the documents whose text changed', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    await indexDocuments({ source: 'github', documents: docs('one', 'two'), provider });
    provider.calls.length = 0;

    const summary = await indexDocuments({
      source: 'github',
      documents: docs('one', 'two EDITED'),
      provider,
    });

    expect(summary).toMatchObject({ embedded: 1, unchanged: 1 });
    expect(embeddedTexts(provider)).toEqual(['two EDITED']);
  });

  it('removes vectors of documents that no longer exist', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    await indexDocuments({ source: 'github', documents: docs('one', 'two'), provider });

    const summary = await indexDocuments({ source: 'github', documents: docs('one'), provider });

    expect(summary.removed).toBe(1);
    expect(listEmbeddings('github').map((e) => e.id)).toEqual(['1']);
  });

  it('re-embeds everything when the model changes (vectors of different models are incomparable)', async () => {
    await indexDocuments({
      source: 'github',
      documents: docs('one', 'two'),
      provider: fakeEmbeddings(CONCEPTS, 'model-a'),
    });

    const summary = await indexDocuments({
      source: 'github',
      documents: docs('one', 'two'),
      provider: fakeEmbeddings(CONCEPTS, 'model-b'),
    });

    expect(summary).toMatchObject({ embedded: 2, model: 'model-b' });
    expect(new Set(listEmbeddings('github').map((e) => e.model))).toEqual(new Set(['model-b']));
  });

  it('sends documents in batches', async () => {
    const provider = fakeEmbeddings(CONCEPTS);

    await indexDocuments({
      source: 'github',
      documents: docs('a', 'b', 'c', 'd', 'e'),
      provider,
      batchSize: 2,
    });

    expect(provider.calls.map((c) => c.texts.length)).toEqual([2, 2, 1]);
  });

  it('skips empty text, which providers reject', async () => {
    const provider = fakeEmbeddings(CONCEPTS);

    const summary = await indexDocuments({
      source: 'github',
      documents: docs('real text', '   ', ''),
      provider,
    });

    expect(summary.embedded).toBe(1);
  });

  it('keeps the batches that succeeded when a later one fails, and resumes from there', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    const embed = provider.embed.bind(provider);
    let batches = 0;
    provider.embed = async (texts, kind) => {
      if (++batches === 2) throw new Error('rate limited');
      return embed(texts, kind);
    };

    await expect(
      indexDocuments({
        source: 'github',
        documents: docs('a', 'b', 'c', 'd'),
        provider,
        batchSize: 2,
      }),
    ).rejects.toThrow('rate limited');
    expect(listEmbeddings('github')).toHaveLength(2); // first batch survived

    provider.calls.length = 0;
    const summary = await indexDocuments({
      source: 'github',
      documents: docs('a', 'b', 'c', 'd'),
      provider,
      batchSize: 2,
    });

    expect(summary).toMatchObject({ embedded: 2, unchanged: 2 });
  });
});
