// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './index.js';

let err: ReturnType<typeof vi.spyOn>;
const stderr = () => err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

const OAUTH = {
  MCP_OAUTH_ISSUER: 'https://auth.example.com',
  MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp',
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const name of [
    'MCP_AUTH_TOKEN',
    'MCP_ALLOWED_ORIGINS',
    'MCP_HTTP_HOST',
    'MCP_HTTP_PORT',
    'MCP_OAUTH_ISSUER',
    'MCP_OAUTH_AUDIENCE',
    'MCP_OAUTH_JWKS_URI',
    'MCP_OAUTH_SCOPE',
    'MCP_RATE_LIMIT_PER_MINUTE',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const setEnv = (env: Record<string, string>) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
};

describe('cli: serve --http with OAuth', () => {
  it('starts without a shared token when OAuth is configured, and says which mode it is in', async () => {
    setEnv(OAUTH);
    const shutdown = new AbortController();

    const exit = run(['serve', '--http', '--port', '0'], { signal: shutdown.signal });
    await vi.waitFor(() =>
      expect(stderr()).toMatch(
        /Authentication: OAuth 2\.1 access tokens from https:\/\/auth\.example\.com/,
      ),
    );
    shutdown.abort();

    expect(await exit).toBe(0);
  });

  it('refuses both a shared token and OAuth', async () => {
    setEnv({ ...OAUTH, MCP_AUTH_TOKEN: 'a-long-random-test-token-0123456789' });

    expect(await run(['serve', '--http'])).toBe(1);
    expect(stderr()).toMatch(/either MCP_AUTH_TOKEN .* or the MCP_OAUTH_\* variables/);
  });

  it('refuses an issuer without an audience', async () => {
    setEnv({ MCP_OAUTH_ISSUER: OAUTH.MCP_OAUTH_ISSUER });

    expect(await run(['serve', '--http'])).toBe(1);
    expect(stderr()).toMatch(/must be set together/);
  });

  it('refuses an issuer that is not https', async () => {
    setEnv({ ...OAUTH, MCP_OAUTH_ISSUER: 'http://auth.example.com' });

    expect(await run(['serve', '--http'])).toBe(1);
    expect(stderr()).toMatch(/https/);
  });

  it('rejects a negative rate limit', async () => {
    setEnv({
      MCP_AUTH_TOKEN: 'a-long-random-test-token-0123456789',
      MCP_RATE_LIMIT_PER_MINUTE: '-1',
    });

    expect(await run(['serve', '--http'])).toBe(1);
    expect(stderr()).toMatch(/MCP_RATE_LIMIT_PER_MINUTE/);
  });
});
