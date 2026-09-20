// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAuthServer } from '../../testing/authserver.js';
import { createOAuthAuthenticator, discoveryUrls } from './oauth.js';
import { AuthError } from './types.js';

const AUDIENCE = 'https://mcp.example.com/mcp';

let auth: Awaited<ReturnType<typeof startAuthServer>>;
beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  auth = await startAuthServer({ audience: AUDIENCE });
});
afterEach(async () => {
  await auth.stop();
  vi.restoreAllMocks();
});

const authenticator = (overrides: Partial<Parameters<typeof createOAuthAuthenticator>[0]> = {}) =>
  createOAuthAuthenticator({
    issuer: auth.issuer,
    audience: AUDIENCE,
    scope: 'mcp:read',
    ...overrides,
  });

/** Runs `fn` and returns the AuthError it rejects with. */
async function refusal(fn: () => Promise<unknown>): Promise<AuthError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    return err as AuthError;
  }
  throw new Error('expected a refusal');
}

describe('discoveryUrls', () => {
  it('follows the MCP order: RFC 8414 inserted, OIDC inserted, OIDC appended', () => {
    expect(discoveryUrls('https://auth.example.com/tenant/1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant/1',
      'https://auth.example.com/.well-known/openid-configuration/tenant/1',
      'https://auth.example.com/tenant/1/.well-known/openid-configuration',
    ]);
  });

  it('has no duplicates for an issuer without a path', () => {
    expect(discoveryUrls('https://auth.example.com/')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });
});

describe('OAuth access token verification', () => {
  it('accepts a valid token and identifies the client, the user and the token', async () => {
    const principal = await authenticator().authenticate(await auth.sign({ jti: 'tok-1' }));

    expect(principal).toEqual({
      kind: 'oauth',
      id: 'client-a', // the client, so limits and revocation are per client
      clientId: 'client-a',
      subject: 'user-1',
      tokenId: 'tok-1',
      scopes: ['mcp:read'],
    });
  });

  it('discovers the key set once and reuses it', async () => {
    const oauth = authenticator();

    await oauth.authenticate(await auth.sign());
    await oauth.authenticate(await auth.sign());

    expect(auth.state.hits).toEqual({ metadata: 1, jwks: 1 });
  });

  it('falls back to OpenID Connect discovery', async () => {
    await auth.stop();
    auth = await startAuthServer({ audience: AUDIENCE, metadata: 'oidc' });

    await expect(authenticator().authenticate(await auth.sign())).resolves.toMatchObject({
      kind: 'oauth',
    });
  });

  it('uses a configured JWKS URI and skips discovery', async () => {
    const oauth = authenticator({ jwksUri: `${auth.issuer}/jwks.json` });

    await oauth.authenticate(await auth.sign());

    expect(auth.state.hits.metadata).toBe(0);
  });

  it('falls back to the subject when the token names no client, and reads scp arrays', async () => {
    const token = await auth.sign({
      client_id: undefined,
      scope: undefined,
      scp: ['mcp:read', 'x'],
    });

    expect(await authenticator().authenticate(token)).toMatchObject({
      id: 'user-1',
      scopes: ['mcp:read', 'x'],
    });
  });

  it('picks up a rotated signing key without a restart', async () => {
    const oauth = authenticator({ jwksCooldownMs: 0 });
    await oauth.authenticate(await auth.sign());

    const next = await auth.rotateKey();

    await expect(
      oauth.authenticate(await auth.sign({}, { key: next, kid: 'key-2' })),
    ).resolves.toMatchObject({ kind: 'oauth' });
  });

  describe('refuses', () => {
    it('an expired token', async () => {
      const error = await refusal(async () =>
        authenticator().authenticate(await auth.sign({}, { expiresIn: -3600 })),
      );

      expect(error).toMatchObject({ status: 401, code: 'invalid_token', outcome: 'expired' });
    });

    it('a token without an expiry', async () => {
      const token = await new SignJWT({ scope: 'mcp:read', sub: 'u' })
        .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
        .setIssuer(auth.issuer)
        .setAudience(AUDIENCE)
        .sign(await auth.strangerKey());

      // Even before the signature is judged, exp is required — but either way it is refused.
      expect((await refusal(async () => authenticator().authenticate(token))).status).toBe(401);
    });

    it('a token meant for another audience (RFC 8707)', async () => {
      const error = await refusal(async () =>
        authenticator().authenticate(await auth.sign({ aud: 'https://other-api.example.com' })),
      );

      expect(error).toMatchObject({ status: 401, outcome: 'invalid_claims' });
    });

    it('a token from another issuer', async () => {
      const error = await refusal(async () =>
        authenticator().authenticate(await auth.sign({ iss: 'https://evil.example.com' })),
      );

      expect(error.outcome).toBe('invalid_claims');
    });

    it('a forged token, signed with a key the server does not publish', async () => {
      const forged = await auth.sign({}, { key: await auth.strangerKey() });

      const error = await refusal(async () => authenticator().authenticate(forged));

      expect(error).toMatchObject({ status: 401, outcome: 'invalid_token' });
    });

    it('a token with an unknown key id', async () => {
      const error = await refusal(async () =>
        authenticator().authenticate(await auth.sign({}, { kid: 'never-published' })),
      );

      expect(error.status).toBe(401);
    });

    it.each(['HS256', 'none'])('the %s algorithm (algorithm confusion)', async (alg) => {
      // A symmetric token "signed" with the public key material, or no signature at all.
      const header = Buffer.from(JSON.stringify({ alg, kid: 'key-1', typ: 'JWT' })).toString(
        'base64url',
      );
      const now = Math.floor(Date.now() / 1000);
      const body = Buffer.from(
        JSON.stringify({
          iss: auth.issuer,
          aud: AUDIENCE,
          sub: 'u',
          scope: 'mcp:read',
          exp: now + 300,
        }),
      ).toString('base64url');
      const token = `${header}.${body}.${alg === 'none' ? '' : 'c2ln'}`;

      const error = await refusal(async () => authenticator().authenticate(token));

      expect(error.status).toBe(401);
    });

    it('garbage, an empty credential and an oversized one', async () => {
      const oauth = authenticator();

      for (const bearer of ['not-a-jwt', 'a.b.c', undefined, 'x'.repeat(9_000)]) {
        expect((await refusal(() => oauth.authenticate(bearer))).status).toBe(401);
      }
      expect(auth.state.hits.metadata).toBe(0); // malformed input never triggers discovery
    });

    it('a token that names neither a client nor a user', async () => {
      const error = await refusal(async () =>
        authenticator().authenticate(await auth.sign({ sub: undefined, client_id: undefined })),
      );

      expect(error.outcome).toBe('no_identity');
    });

    it('a token without the required scope, telling the client which one to ask for (403)', async () => {
      const error = await refusal(async () =>
        authenticator().authenticate(await auth.sign({ scope: 'profile email' })),
      );

      expect(error).toMatchObject({
        status: 403,
        code: 'insufficient_scope',
        scope: 'mcp:read',
      });
    });
  });

  describe('when the authorization server is unhealthy', () => {
    it('answers 503, not 401: the client did nothing wrong', async () => {
      auth.state.metadataStatus = 500;

      const error = await refusal(async () => authenticator().authenticate(await auth.sign()));

      expect(error).toMatchObject({ status: 503, code: 'temporarily_unavailable' });
    });

    it('fails fast for a while instead of asking again on every request', async () => {
      auth.state.metadataStatus = 404;
      const oauth = authenticator();
      const token = await auth.sign();

      await refusal(() => oauth.authenticate(token));
      const callsAfterFirst = auth.state.hits.metadata;
      await refusal(() => oauth.authenticate(token));
      await refusal(() => oauth.authenticate(token));

      expect(auth.state.hits.metadata).toBe(callsAfterFirst);
    });

    it('rejects metadata that names a different issuer (mix-up attack)', async () => {
      auth.state.metadataIssuer = 'https://someone-else.example.com';

      const error = await refusal(async () => authenticator().authenticate(await auth.sign()));

      expect(error.status).toBe(503);
    });

    it('answers 503 when the key set cannot be fetched', async () => {
      auth.state.jwksStatus = 500;

      const error = await refusal(async () => authenticator().authenticate(await auth.sign()));

      expect(error.status).toBe(503);
    });
  });
});

describe('the challenge and the protected-resource metadata', () => {
  it('points a client without a token at the metadata document (RFC 9728)', () => {
    expect(authenticator().challenge()).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('adds the error, and the scope for insufficient_scope, without breaking the header syntax', () => {
    const error = new AuthError(
      'insufficient_scope',
      403,
      'Needs "more" \\ scope.',
      'insufficient_scope',
      'mcp:read',
    );

    const header = authenticator().challenge(error);

    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="mcp:read"');
    expect(header).toContain('error_description="Needs more  scope."');
  });

  it('describes the resource and its authorization server', () => {
    const { metadata } = authenticator();

    expect(metadata?.paths).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
    expect(metadata?.document).toMatchObject({
      resource: AUDIENCE,
      authorization_servers: [auth.issuer],
      scopes_supported: ['mcp:read'],
      bearer_methods_supported: ['header'],
    });
  });
});
