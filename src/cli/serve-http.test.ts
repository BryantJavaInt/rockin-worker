// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './index.js';

let err: ReturnType<typeof vi.spyOn>;
const stderr = () => err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

const TOKEN = 'a-long-random-test-token-0123456789';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const name of ['MCP_AUTH_TOKEN', 'MCP_ALLOWED_ORIGINS', 'MCP_HTTP_HOST', 'MCP_HTTP_PORT']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cli: serve --http', () => {
  it('refuses to start without an auth token (fail closed)', async () => {
    expect(await run(['serve', '--http'])).toBe(1);
    expect(stderr()).toMatch(/MCP_AUTH_TOKEN is not set/);
  });

  it('refuses a weak token', async () => {
    vi.stubEnv('MCP_AUTH_TOKEN', 'short');

    expect(await run(['serve', '--http'])).toBe(1);
    expect(stderr()).toMatch(/at least 24 characters/);
  });

  it('does not accept the token as a flag (it would show up in the process list)', async () => {
    expect(await run(['serve', '--http', '--token', TOKEN])).toBe(1); // unknown option → runtime error
  });

  it('rejects --host/--port without --http, and an invalid port', async () => {
    vi.stubEnv('MCP_AUTH_TOKEN', TOKEN);

    expect(await run(['serve', '--port', '9000'])).toBe(2);
    expect(await run(['serve', '--http', '--port', 'abc'])).toBe(2);
    expect(await run(['serve', '--http', '--port', '70000'])).toBe(2);
  });

  it('serves on loopback and shuts down gracefully on the signal', async () => {
    vi.stubEnv('MCP_AUTH_TOKEN', TOKEN);
    const shutdown = new AbortController();

    const exit = run(['serve', '--http', '--port', '0'], { signal: shutdown.signal });
    await vi.waitFor(() => expect(stderr()).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\/mcp/));
    shutdown.abort();

    expect(await exit).toBe(0);
    expect(stderr()).not.toMatch(/non-loopback/);
  });
});
