// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { seedFixtures } from '../evals/fixtures.js';
import { closeDb } from '../infra/db/connection.js';
import { defineTool } from '../tools/define.js';
import { TOOLS } from '../tools/registry.js';
import { createMcpServer } from './server.js';

// A real end-to-end check: spawn the actual CLI as a child process speaking MCP over
// stdio, seeded through a real on-disk SQLite file, and drive it with the official MCP
// client. This is what Claude Desktop / any MCP host does — if this passes, it works.
describe('MCP server over stdio', () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rockin-mcp-'));
    const dbPath = path.join(dir, 'test.db');

    // Seed the file from this process, then release it so the child owns it.
    const previous = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    seedFixtures();
    closeDb();
    process.env.DB_PATH = previous;

    client = new Client({ name: 'integration-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/main.ts', 'serve'],
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          DB_PATH: dbPath,
          // main.ts loads .env; dotenv never overrides variables that are already set,
          // so pin the secrets to blank to keep this child from reading real credentials.
          GITHUB_TOKEN: '',
          NOTION_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        },
        stderr: 'pipe',
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises exactly the registered tools, flagged read-only', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('serves real data from the store through a tool call', async () => {
    const result = await client.callTool({ name: 'github_getTopItems', arguments: { limit: 2 } });
    const [block] = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(block?.text ?? '{}');

    expect(result.isError).toBeFalsy();
    expect(payload.items.map((i: { name: string }) => i.name)).toEqual([
      'flagship-app',
      'side-project',
    ]);
    expect(payload.lastSyncAt).not.toBeNull();
  });

  it('matches search input literally', async () => {
    const result = await client.callTool({
      name: 'notion_searchByName',
      arguments: { query: 'roadmap' },
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}');

    expect(payload.items.map((i: { title: string }) => i.title)).toEqual(['Q3 Roadmap']);
  });

  it('reports invalid arguments as a tool error, not a crash', async () => {
    const result = await client.callTool({ name: 'github_searchByName', arguments: { query: '' } });

    expect(result.isError).toBe(true);
  });

  it('keeps serving after an error', async () => {
    const result = await client.callTool({ name: 'github_getTopItems', arguments: {} });

    expect(result.isError).toBeFalsy();
  });
});

describe('createMcpServer (in-process)', () => {
  async function connect(tools = TOOLS) {
    const server = createMcpServer(tools);
    const client = new Client({ name: 'in-process', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it('has no side effects and can be built repeatedly', () => {
    expect(createMcpServer()).not.toBe(createMcpServer());
  });

  it('turns an exception inside a tool into an isError result the client can read', async () => {
    const exploding = defineTool({
      name: 'explode',
      title: 'Explode',
      description: 'Always fails.',
      input: z.object({}),
      run: () => {
        throw new Error('kaboom');
      },
    });
    const client = await connect([exploding]);

    const result = await client.callTool({ name: 'explode', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/kaboom/);
  });

  it('serves the registered tools', async () => {
    const client = await connect();

    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
  });
});
