// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export type SignOptions = {
  /** Sign with a different key than the one the server publishes (a forgery). */
  key?: SigningKey;
  kid?: string;
  alg?: string;
  /** Seconds from now; negative for an already-expired token. */
  expiresIn?: number;
};

/**
 * A stand-in authorization server: it publishes RFC 8414 metadata and a JWKS, and signs access
 * tokens with the private half. It is what a real deployment gets from Keycloak, Auth0 or Entra ID,
 * small enough to break on purpose (metadata that lies, keys that vanish) in tests.
 */
export async function startAuthServer(options: { audience: string; metadata?: 'oauth' | 'oidc' }) {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = 'key-1';
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };

  const state = {
    keys: [publicJwk],
    jwksStatus: 200,
    metadataStatus: 200,
    metadataIssuer: undefined as string | undefined,
    hits: { metadata: 0, jwks: 0 },
  };

  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const metadataPath =
      options.metadata === 'oidc'
        ? '/.well-known/openid-configuration'
        : '/.well-known/oauth-authorization-server';

    if (req.url === metadataPath) {
      state.hits.metadata++;
      if (state.metadataStatus !== 200) return send(state.metadataStatus, { error: 'nope' });
      return send(200, { issuer: state.metadataIssuer ?? issuer, jwks_uri: `${issuer}/jwks.json` });
    }
    if (req.url === '/jwks.json') {
      state.hits.jwks++;
      if (state.jwksStatus !== 200) return send(state.jwksStatus, { error: 'nope' });
      return send(200, { keys: state.keys });
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    state,
    /** The signing key the server publishes, for tests that rotate or replace it. */
    async rotateKey() {
      const next = await generateKeyPair('ES256', { extractable: true });
      const nextJwk: JWK = { ...(await exportJWK(next.publicKey)), kid: 'key-2', alg: 'ES256' };
      state.keys = [nextJwk];
      return next.privateKey;
    },
    /** Signs an access token. Defaults describe a valid one; `claims` override or add fields. */
    async sign(claims: JWTPayload = {}, sign: SignOptions = {}): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const payload: JWTPayload = {
        iss: issuer,
        aud: options.audience,
        sub: 'user-1',
        client_id: 'client-a',
        scope: 'mcp:read',
        jti: randomUUID(),
        iat: now,
        exp: now + (sign.expiresIn ?? 300),
        ...claims,
      };
      return new SignJWT(payload)
        .setProtectedHeader({ alg: sign.alg ?? 'ES256', kid: sign.kid ?? kid })
        .sign(sign.key ?? privateKey);
    },
    /** A generated key the server does NOT publish — for forging tokens. */
    async strangerKey(): Promise<SigningKey> {
      return (await generateKeyPair('ES256')).privateKey;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
