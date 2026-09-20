// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexDocuments } from '../core/search/indexer.js';
import { seedFixtures } from '../evals/fixtures.js';
import { useEmbeddingProvider } from '../infra/embeddings/provider.js';
import { listRepoDocuments } from '../sources/github/documents.js';
import { CONCEPTS, fakeEmbeddings } from '../testing/embeddings.js';
import { resetDb } from '../testing/helpers.js';
import { createMcpServer } from './server.js';

async function connect() {
  const server = createMcpServer();
  const client = new Client({ name: 'search-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe('MCP search tools (asynchronous)', () => {
  beforeEach(() => {
    resetDb();
    seedFixtures();
  });
  afterEach(() => useEmbeddingProvider(undefined));

  it('returns lexically ranked, typed structuredContent by default', async () => {
    useEmbeddingProvider(null);
    const client = await connect();

    const result = await client.callTool({ name: 'github_search', arguments: { query: 'habits' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ source: 'github', ranking: 'lexical' });
    const items = (result.structuredContent as { items: Array<{ name: string }> }).items;
    expect(items.map((i) => i.name)).toEqual(['habit-tracker']); // stemming: habits → habit
  });

  it('returns hybrid results, found by meaning, once the index exists', async () => {
    const provider = fakeEmbeddings(CONCEPTS);
    useEmbeddingProvider(provider);
    await indexDocuments({ source: 'github', documents: listRepoDocuments(), provider });
    const client = await connect();

    const result = await client.callTool({
      name: 'github_search',
      arguments: { query: 'routine' },
    });

    expect(result.structuredContent).toMatchObject({ ranking: 'hybrid' });
    const items = (result.structuredContent as { items: Array<{ name: string }> }).items;
    expect(items.map((i) => i.name)).toContain('habit-tracker');
  });
});
