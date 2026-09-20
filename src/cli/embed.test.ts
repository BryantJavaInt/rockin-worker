// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFixtures } from '../evals/fixtures.js';
import { useEmbeddingProvider } from '../infra/embeddings/provider.js';
import { CONCEPTS, fakeEmbeddings } from '../testing/embeddings.js';
import { jsonResponse, resetDb } from '../testing/helpers.js';
import { run } from './index.js';

let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
const stdout = () => out.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
const stderr = () => err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

beforeEach(() => {
  resetDb();
  out = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const name of ['GITHUB_TOKEN', 'NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  useEmbeddingProvider(undefined);
});

describe('cli: embed', () => {
  it('needs an embeddings provider, and says how to configure one', async () => {
    expect(await run(['embed'])).toBe(1);
    expect(stderr()).toMatch(/VOYAGE_API_KEY is not set/);
  });

  it('rejects an unknown source', async () => {
    useEmbeddingProvider(fakeEmbeddings(CONCEPTS));

    expect(await run(['embed', 'gitlab'])).toBe(2);
  });

  it('indexes every source and reports what it did', async () => {
    seedFixtures();
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);

    expect(await run(['embed'])).toBe(0);

    const summaries = [...stdout().matchAll(/"source": "(\w+)"[\s\S]*?"embedded": (\d+)/g)].map(
      (m) => [m[1], Number(m[2])],
    );
    expect(summaries).toEqual([
      ['github', 4],
      ['notion', 4],
    ]);
  });

  it('is incremental: a second run embeds nothing', async () => {
    seedFixtures();
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    await run(['embed']);
    provider.calls.length = 0;

    await run(['embed']);

    expect(provider.calls).toHaveLength(0);
  });

  it('works through the real Voyage provider when only the API key is configured', async () => {
    seedFixtures();
    vi.stubEnv('VOYAGE_API_KEY', 'voyage-test');
    const fetchMock = vi.fn().mockImplementation(async (_url, init) =>
      jsonResponse({
        data: JSON.parse(init.body).input.map((_: string, index: number) => ({
          index,
          embedding: [1, 0, 0],
        })),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await run(['embed', 'github'])).toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('sync --embed refreshes the index after a successful sync', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    useEmbeddingProvider(fakeEmbeddings(CONCEPTS));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse([
          {
            id: 1,
            name: 'habit-tracker',
            stargazers_count: 3,
            updated_at: '2026-03-01T00:00:00Z',
            description: 'Track daily habits',
          },
        ]),
      ),
    );

    expect(await run(['sync', 'github', '--embed'])).toBe(0);
    expect(stdout()).toMatch(/"embedded": 1/);
  });

  it('sync --embed does not embed when the sync itself failed', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    expect(await run(['sync', 'github', '--embed'])).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });
});
