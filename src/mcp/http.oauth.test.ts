// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFixtures } from '../evals/fixtures.js';
import { startAuthServer } from '../testing/authserver.js';
import { resetDb } from '../testing/helpers.js';
import { installTestMetrics } from '../testing/telemetry.js';
import { TOOLS } from '../tools/registry.js';
import { revoke, unrevoke } from './auth/revocations.js';
import { createMcpHttpServer } from './http.js';

const AUDIENCE = 'https://mcp.example.com/mcp';

let idp: Awaited<ReturnType<typeof startAuthServer>>;
let app: ReturnType<typeof createMcpHttpServer>;
let base: string;

async function start(rateLimitPerMinute = 0) {
  app = createMcpHttpServer({
    oauth: { issuer: idp.issuer, audience: AUDIENCE, scope: 'mcp:read' },
    port: 0,
    rateLimitPerMinute,
  });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  resetDb();
  seedFixtures();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  idp = await startAuthServer({ audience: AUDIENCE });
  await start();
});

afterEach(async () => {
  await app.close();
  await idp.stop();
  vi.restoreAllMocks();
});

const rpc = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
});

const call = (token?: string) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    body: rpc,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

describe('remote MCP with OAuth 2.1', () => {
  it('sends a client without a token to the protected-resource metadata (RFC 9728)', async () => {
    const response = await call();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('publishes that metadata without authentication, at both well-known paths', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await fetch(`${base}${path}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: AUDIENCE,
        authorization_servers: [idp.issuer],
        scopes_supported: ['mcp:read'],
      });
    }
  });

  it('serves the tools to a real MCP client that presents a valid access token', async () => {
    const token = await idp.sign();
    const client = new Client({ name: 'oauth-test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'github_getTopItems', arguments: { limit: 1 } });
    await client.close();

    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(result.isError).toBeFalsy();
  });

  it('says why an invalid token was refused, in the WWW-Authenticate header', async () => {
    const response = await call(await idp.sign({}, { expiresIn: -3600 }));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
    expect(response.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('answers 403 with the scope to request when the token lacks it', async () => {
    const response = await call(await idp.sign({ scope: 'profile' }));

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toMatch(
      /error="insufficient_scope", .*scope="mcp:read"/,
    );
  });

  it('refuses a token for another resource, even if everything else is valid', async () => {
    const response = await call(await idp.sign({ aud: 'https://other.example.com/mcp' }));

    expect(response.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    const response = await call(await idp.sign({}, { key: await idp.strangerKey() }));

    expect(response.status).toBe(401);
  });

  it('answers 503 with Retry-After while the authorization server is down', async () => {
    idp.state.metadataStatus = 500;

    const response = await call(await idp.sign());

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('does not accept a shared token in OAuth mode', async () => {
    expect((await call('a-long-random-test-token-0123456789')).status).toBe(401);
  });

  describe('revocation', () => {
    it.each([
      ['client', 'client-a'],
      ['subject', 'user-1'],
      ['token', 'tok-1'],
    ] as const)(
      'takes effect on the next request when a %s is revoked, and can be lifted',
      async (kind, value) => {
        const token = await idp.sign({ jti: 'tok-1' });
        expect((await call(token)).status).toBe(200);

        revoke(kind, value, 'test');
        const refused = await call(token);
        expect(refused.status).toBe(401);
        expect(refused.headers.get('www-authenticate')).toMatch(/revoked/);

        unrevoke(kind, value);
        expect((await call(token)).status).toBe(200);
      },
    );

    it('leaves other clients working', async () => {
      revoke('client', 'client-a');

      expect((await call(await idp.sign())).status).toBe(401);
      expect((await call(await idp.sign({ client_id: 'client-b' }))).status).toBe(200);
    });
  });

  describe('rate limiting', () => {
    beforeEach(async () => {
      await app.close();
      await start(3);
    });

    it('limits each client separately and says so in the RateLimit headers', async () => {
      const a = await idp.sign({ client_id: 'client-a' });
      const b = await idp.sign({ client_id: 'client-b' });

      const first = await call(a);
      expect(first.status).toBe(200);
      expect(first.headers.get('ratelimit-limit')).toBe('3');
      expect(first.headers.get('ratelimit-remaining')).toBe('2');

      await call(a);
      await call(a);
      const refused = await call(a);

      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(refused.headers.get('ratelimit-remaining')).toBe('0');
      expect((await call(b)).status).toBe(200); // another client is not affected
    });

    it('does not spend the limit on requests that fail authentication', async () => {
      for (let i = 0; i < 6; i++) expect((await call('not-a-token')).status).toBe(401);

      expect((await call(await idp.sign())).status).toBe(200);
    });
  });

  describe('metrics', () => {
    it('counts every request by outcome, never by client', async () => {
      const metrics = installTestMetrics();
      try {
        await call(); // unauthenticated
        await call(await idp.sign({ scope: 'x' })); // insufficient scope
        await call(await idp.sign()); // ok

        const points = await metrics.collect('rockin.mcp.requests');
        const byOutcome = Object.fromEntries(
          points.map((p) => [String(p.attributes.outcome), p.value]),
        );

        expect(byOutcome).toEqual({ unauthenticated: 1, insufficient_scope: 1, ok: 1 });
        expect(JSON.stringify(points)).not.toMatch(/client-a|user-1/);
      } finally {
        await metrics.uninstall();
      }
    });
  });
});

describe('server configuration', () => {
  it('refuses to start with both a shared token and OAuth, or with neither', () => {
    expect(() =>
      createMcpHttpServer({
        token: 'a-long-random-test-token-0123456789',
        oauth: { issuer: 'https://a', audience: 'https://b', scope: 's' },
      }),
    ).toThrow(/not both/);
    expect(() => createMcpHttpServer({})).toThrow(/needs a shared token or an OAuth/);
  });
});
