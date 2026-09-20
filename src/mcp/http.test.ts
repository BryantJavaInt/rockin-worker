// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedFixtures } from '../evals/fixtures.js';
import { resetDb } from '../testing/helpers.js';
import { TOOLS } from '../tools/registry.js';
import { createMcpHttpServer, isLoopback, tokensMatch } from './http.js';

const TOKEN = 'a-long-random-test-token-0123456789';
const ORIGIN = 'https://app.example';

let app: ReturnType<typeof createMcpHttpServer>;
let base: string;

beforeEach(async () => {
  resetDb();
  seedFixtures();
  app = createMcpHttpServer({
    token: TOKEN,
    port: 0,
    allowedOrigins: [ORIGIN],
    maxBodyBytes: 2_000,
  });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => app.close());

const rpc = (method: string, params: object = {}, id = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

const post = (body: string, headers: Record<string, string> = {}, path = '/mcp') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
  });

const authed = { Authorization: `Bearer ${TOKEN}` };
const initialize = () =>
  rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });

describe('authentication', () => {
  it('rejects a request with no token, telling the client how to authenticate', async () => {
    const response = await post(initialize());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it.each([
    ['a wrong token', 'Bearer not-the-token'],
    ['the right token with the wrong scheme', `Basic ${TOKEN}`],
    ['an empty bearer', 'Bearer '],
    ['a token that is only a prefix of the real one', `Bearer ${TOKEN.slice(0, 10)}`],
  ])('rejects %s', async (_label, authorization) => {
    expect((await post(initialize(), { Authorization: authorization })).status).toBe(401);
  });

  it('accepts the right token', async () => {
    const response = await post(initialize(), authed);

    expect(response.status).toBe(200);
    expect((await response.json()).result.serverInfo.name).toBe('rockin-worker');
  });

  it('checks the token before reading the body: an unauthenticated flood is not buffered', async () => {
    const huge = 'x'.repeat(50_000);

    expect((await post(huge)).status).toBe(401); // not 413: it never got as far as the body
  });
});

describe('tokensMatch', () => {
  it('compares in constant time and handles every shape of input', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch('nope', TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
  });
});

describe('DNS-rebinding protection', () => {
  it('rejects a browser origin that is not allow-listed, even with a valid token', async () => {
    const response = await post(initialize(), { ...authed, Origin: 'https://evil.example' });

    expect(response.status).toBe(403);
  });

  it('accepts an allow-listed origin', async () => {
    expect((await post(initialize(), { ...authed, Origin: ORIGIN })).status).toBe(200);
  });

  it('rejects an unexpected Host header on a loopback binding', async () => {
    const { port } = app.server.address() as { port: number };

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: { Host: 'evil.example', ...authed, 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(initialize());
    });

    expect(status).toBe(403);
  });

  it('classifies loopback hosts', () => {
    expect(['127.0.0.1', 'localhost', '::1'].every(isLoopback)).toBe(true);
    expect(['0.0.0.0', '192.168.1.5', 'example.com'].some(isLoopback)).toBe(false);
  });
});

describe('request hygiene', () => {
  it('answers /healthz without authentication', async () => {
    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', name: 'rockin-worker' });
  });

  it('serves only /mcp and /healthz', async () => {
    expect((await post('{}', authed, '/other')).status).toBe(404);
  });

  it.each(['GET', 'DELETE', 'PUT'])('refuses %s on /mcp (POST only, stateless)', async (method) => {
    const response = await fetch(`${base}/mcp`, { method, headers: authed });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('rejects a body that is not JSON', async () => {
    expect((await post('{not json', authed)).status).toBe(400);
  });

  it('rejects a body over the size limit', async () => {
    const response = await post(JSON.stringify({ padding: 'x'.repeat(5_000) }), authed);

    expect(response.status).toBe(413);
  });
});

describe('MCP over HTTP with the official client', () => {
  const connect = async (token = TOKEN) => {
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  it('lists the same tools as the stdio server', async () => {
    const client = await connect();

    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      TOOLS.map((t) => t.name).sort(),
    );
    await client.close();
  });

  it('calls a tool and returns typed structured content, including async search tools', async () => {
    const client = await connect();

    const top = await client.callTool({ name: 'github_getTopItems', arguments: { limit: 1 } });
    const found = await client.callTool({ name: 'notion_search', arguments: { query: 'roadmap' } });

    expect((top.structuredContent as { items: Array<{ name: string }> }).items[0]?.name).toBe(
      'flagship-app',
    );
    expect((found.structuredContent as { items: Array<{ title: string }> }).items[0]?.title).toBe(
      'Q3 Roadmap',
    );
    await client.close();
  });

  it('is stateless: independent clients need no shared session', async () => {
    const [a, b] = await Promise.all([connect(), connect()]);

    expect((await a.listTools()).tools.length).toBeGreaterThan(0);
    expect((await b.listTools()).tools.length).toBeGreaterThan(0);
    await Promise.all([a.close(), b.close()]);
  });

  it('cannot connect with a wrong token', async () => {
    await expect(connect('wrong-token')).rejects.toThrow();
  });
});

describe('lifecycle', () => {
  it('stops accepting connections after close()', async () => {
    await app.close();

    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    app = createMcpHttpServer({ token: TOKEN, port: 0 }); // so afterEach has something to close
    await app.listen();
  });
});
