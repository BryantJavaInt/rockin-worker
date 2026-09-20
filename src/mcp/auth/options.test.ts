// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../config/index.js';
import { oauthOptionsFrom } from './options.js';

const from = (env: Record<string, string>) => oauthOptionsFrom(loadConfig(env));

describe('oauthOptionsFrom', () => {
  it('is undefined when OAuth is not configured', () => {
    expect(from({})).toBeUndefined();
  });

  it('builds the options, with the default scope', () => {
    expect(
      from({
        MCP_OAUTH_ISSUER: 'https://auth.example.com',
        MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp',
      }),
    ).toEqual({
      issuer: 'https://auth.example.com',
      audience: 'https://mcp.example.com/mcp',
      scope: 'mcp:read',
    });
  });

  it('accepts a custom scope and a JWKS URI', () => {
    expect(
      from({
        MCP_OAUTH_ISSUER: 'https://auth.example.com',
        MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp',
        MCP_OAUTH_SCOPE: 'mcp:tools',
        MCP_OAUTH_JWKS_URI: 'https://auth.example.com/keys',
      }),
    ).toMatchObject({ scope: 'mcp:tools', jwksUri: 'https://auth.example.com/keys' });
  });

  it('needs the issuer and the audience together', () => {
    expect(() => from({ MCP_OAUTH_ISSUER: 'https://auth.example.com' })).toThrow(/set together/);
    expect(() => from({ MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp' })).toThrow(
      /set together/,
    );
  });

  it.each([
    ['an issuer over plain http', { MCP_OAUTH_ISSUER: 'http://auth.example.com' }],
    ['an audience over plain http', { MCP_OAUTH_AUDIENCE: 'http://mcp.example.com/mcp' }],
    ['a JWKS URI over plain http', { MCP_OAUTH_JWKS_URI: 'http://auth.example.com/keys' }],
    ['an audience with a fragment', { MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp#x' }],
    ['an audience with a query', { MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp?a=1' }],
  ])('rejects %s', (_label, override) => {
    expect(() =>
      from({
        MCP_OAUTH_ISSUER: 'https://auth.example.com',
        MCP_OAUTH_AUDIENCE: 'https://mcp.example.com/mcp',
        ...override,
      }),
    ).toThrow(ConfigError);
  });

  it('allows http on localhost, for developing against a local authorization server', () => {
    expect(
      from({
        MCP_OAUTH_ISSUER: 'http://localhost:8080/realms/dev',
        MCP_OAUTH_AUDIENCE: 'http://127.0.0.1:8787/mcp',
      }),
    ).toMatchObject({ issuer: 'http://localhost:8080/realms/dev' });
  });

  it('rejects something that is not a URL at all', () => {
    expect(() => from({ MCP_OAUTH_ISSUER: 'not a url', MCP_OAUTH_AUDIENCE: 'x' })).toThrow(
      ConfigError,
    );
  });
});
