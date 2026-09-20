// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpServer } from './http.js';

const TOKEN = 'a-long-random-test-token-0123456789';

let app: ReturnType<typeof createMcpHttpServer> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function call(options: { rateLimitPerMinute?: number }, times: number) {
  app = createMcpHttpServer({ token: TOKEN, port: 0, ...options });
  const { port } = await app.listen();

  const responses: Response[] = [];
  for (let i = 0; i < times; i++) {
    responses.push(
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN}`,
        },
      }),
    );
  }
  return responses;
}

describe('rate limiting with the shared token', () => {
  it('limits the shared identity as one client', async () => {
    const responses = await call({ rateLimitPerMinute: 2 }, 3);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 429]);
    expect(responses[2]?.headers.get('retry-after')).not.toBeNull();
  });

  it('defaults to 120 requests a minute', async () => {
    const [response] = await call({}, 1);

    expect(response?.headers.get('ratelimit-limit')).toBe('120');
  });

  it('0 turns the limit off, and no RateLimit headers are sent', async () => {
    const responses = await call({ rateLimitPerMinute: 0 }, 5);

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses[0]?.headers.get('ratelimit-limit')).toBeNull();
  });

  it('serves no protected-resource metadata: there is no authorization server to point at', async () => {
    app = createMcpHttpServer({ token: TOKEN, port: 0 });
    const { port } = await app.listen();

    const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);

    expect(response.status).toBe(404);
  });
});
