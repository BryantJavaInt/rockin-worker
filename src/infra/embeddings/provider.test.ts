// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../testing/helpers.js';
import { HttpError } from '../http/client.js';
import { createVoyageProvider, getEmbeddingProvider, useEmbeddingProvider } from './provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  useEmbeddingProvider(undefined);
});

const reply = (count: number, dim = 3) =>
  jsonResponse({
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: dim }, () => index),
    })),
  });

describe('Voyage embedding provider', () => {
  it('sends an authenticated request with the model and the input type', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply(2));
    vi.stubGlobal('fetch', fetchMock);

    await createVoyageProvider('key-123', 'voyage-x').embed(['a', 'b'], 'query');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer key-123');
    expect(JSON.parse(init.body)).toEqual({
      input: ['a', 'b'],
      model: 'voyage-x',
      input_type: 'query',
    });
  });

  it('splits large inputs into batches of at most 128 and keeps the order', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url, init) => reply(JSON.parse(init.body).input.length));
    vi.stubGlobal('fetch', fetchMock);

    const vectors = await createVoyageProvider('k', 'm').embed(
      Array.from({ length: 300 }, (_, i) => `t${i}`),
      'document',
    );

    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).input.length)).toEqual([
      128, 128, 44,
    ]);
    expect(vectors).toHaveLength(300);
  });

  it('orders vectors by the index the API returns, not by response order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
        }),
      ),
    );

    expect(await createVoyageProvider('k', 'm').embed(['first', 'second'], 'document')).toEqual([
      [1],
      [2],
    ]);
  });

  it('rejects a response with the wrong number of embeddings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(1)));

    await expect(createVoyageProvider('k', 'm').embed(['a', 'b'], 'document')).rejects.toThrow(
      /1 embeddings for 2 inputs/,
    );
  });

  it('rejects a malformed response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nope: true })));

    await expect(createVoyageProvider('k', 'm').embed(['a'], 'document')).rejects.toThrow();
  });

  it('surfaces API errors as a typed HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));

    await expect(createVoyageProvider('k', 'm').embed(['a'], 'document')).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

describe('getEmbeddingProvider', () => {
  it('is null without an API key, and built from configuration with one', () => {
    vi.stubEnv('VOYAGE_API_KEY', '');
    expect(getEmbeddingProvider()).toBeNull();

    vi.stubEnv('VOYAGE_API_KEY', 'secret');
    expect(getEmbeddingProvider()?.model).toBe('voyage-3.5-lite');

    vi.stubEnv('EMBEDDING_MODEL', 'voyage-3-large');
    expect(getEmbeddingProvider()?.model).toBe('voyage-3-large');
  });

  it('an explicit override wins over configuration, including "no provider"', () => {
    vi.stubEnv('VOYAGE_API_KEY', 'secret');

    useEmbeddingProvider(null);
    expect(getEmbeddingProvider()).toBeNull();

    const custom = { model: 'custom', embed: async () => [] };
    useEmbeddingProvider(custom);
    expect(getEmbeddingProvider()).toBe(custom);
  });
});
