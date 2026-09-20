// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { z } from 'zod';
import { describeError } from '../../infra/errors.js';
import { fetchWithRetries } from '../../infra/http/client.js';
import { AuthError, type Authenticator, type Principal } from './types.js';

export type OAuthOptions = {
  /** The authorization server's issuer identifier (`iss`), e.g. https://auth.example.com. */
  issuer: string;
  /**
   * This server's canonical resource identifier (RFC 8707): the public URL of the MCP endpoint.
   * A token is accepted only if its `aud` names it, so a token minted for another API is useless here.
   */
  audience: string;
  /** Scope a token must carry. */
  scope: string;
  /** Skips discovery when the authorization server's key set lives somewhere non-standard. */
  jwksUri?: string;
  clockToleranceSeconds?: number;
  /**
   * Minimum time between key-set refetches. A token with an unknown key id triggers a refetch
   * (that is how key rotation is picked up), so without a cooldown forged tokens could make this
   * server hammer the authorization server. Default 30 s.
   */
  jwksCooldownMs?: number;
};

// Asymmetric algorithms only. A resource server holds no secret, so it must never accept a
// symmetric (HS*) or unsigned token: with a shared secret, anyone who can read a public key
// could forge tokens (the classic algorithm-confusion attack).
const ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

const MAX_TOKEN_LENGTH = 8_192;
const DISCOVERY_TIMEOUT_MS = 5_000;
// After a failed discovery, answer 503 straight away for a while instead of letting every request
// (including a flood of forged ones) wait on an authorization server that is down.
const DISCOVERY_RETRY_MS = 30_000;
const WELL_KNOWN = '/.well-known/oauth-protected-resource';

const ServerMetadata = z.object({ issuer: z.string(), jwks_uri: z.string() });

const stripSlash = (value: string) => value.replace(/\/+$/, '');

/**
 * Where an authorization server publishes its metadata, in the order the MCP specification
 * prescribes: RFC 8414 with the well-known segment inserted before the issuer's path, then the
 * OpenID Connect equivalents (inserted, then appended).
 */
export function discoveryUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = stripSlash(url.pathname);
  return [
    ...new Set([
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${url.origin}/.well-known/openid-configuration${path}`,
      `${stripSlash(issuer)}/.well-known/openid-configuration`,
    ]),
  ];
}

async function discoverJwksUri(issuer: string): Promise<string> {
  for (const url of discoveryUrls(issuer)) {
    const response = await fetchWithRetries(url, {
      maxAttempts: 2,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    if (!response.ok) continue;

    const metadata = ServerMetadata.safeParse(await response.json().catch(() => null));
    if (!metadata.success) continue;

    // RFC 8414 §3.3: the issuer in the document must be the one we asked for, otherwise a
    // server could describe itself as somebody else (a mix-up attack).
    if (stripSlash(metadata.data.issuer) !== stripSlash(issuer)) {
      throw new Error(`metadata at ${url} names a different issuer`);
    }
    return metadata.data.jwks_uri;
  }
  throw new Error('no authorization server metadata found');
}

const scopesOf = (payload: JWTPayload): string[] => {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return [];
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const invalid = (message: string, outcome: string) =>
  new AuthError('invalid_token', 401, message, outcome);

/** Maps a verification failure to a refusal. Infrastructure trouble must not look like a bad token. */
function toAuthError(err: unknown): AuthError {
  if (err instanceof AuthError) return err;
  if (err instanceof errors.JWTExpired) return invalid('The access token expired.', 'expired');
  if (err instanceof errors.JWTClaimValidationFailed) {
    return invalid('The access token has the wrong issuer, audience or claims.', 'invalid_claims');
  }
  // A key set that cannot be fetched (timeout, network) is our problem, not the client's.
  if (
    err instanceof errors.JWKSTimeout ||
    (err instanceof errors.JOSEError && err.code === 'ERR_JOSE_GENERIC')
  ) {
    return new AuthError(
      'temporarily_unavailable',
      503,
      'The authorization server keys are unavailable.',
      'auth_unavailable',
    );
  }
  if (err instanceof errors.JOSEError)
    return invalid('The access token is invalid.', 'invalid_token');
  throw err;
}

/**
 * An OAuth 2.1 *resource server*: it validates access tokens issued by an external authorization
 * server (Keycloak, Auth0, Entra ID, …) and publishes RFC 9728 metadata so MCP clients can find
 * that server. It issues nothing itself and holds no secret.
 *
 * A token is accepted only when its signature verifies against the server's published keys, it
 * has not expired, `iss` and `aud` match this deployment, it carries the required scope, and it
 * identifies a client or user (a rate limit and a revocation both need someone to apply to).
 */
export function createOAuthAuthenticator(options: OAuthOptions): Authenticator {
  const { issuer, audience, scope, clockToleranceSeconds = 30 } = options;
  const resource = new URL(audience);
  const resourcePath = stripSlash(resource.pathname);
  const metadataUrl = `${resource.origin}${WELL_KNOWN}${resourcePath}`;

  let keys: Promise<JWTVerifyGetKey> | undefined;
  let failedAt = 0;

  function getKeys(): Promise<JWTVerifyGetKey> {
    if (keys) return keys;
    if (failedAt && Date.now() - failedAt < DISCOVERY_RETRY_MS) {
      return Promise.reject(toAuthError(new errors.JOSEError('discovery recently failed')));
    }

    const attempt = (async () => {
      const jwksUri = options.jwksUri ?? (await discoverJwksUri(issuer));
      return createRemoteJWKSet(new URL(jwksUri), {
        timeoutDuration: DISCOVERY_TIMEOUT_MS,
        cooldownDuration: options.jwksCooldownMs ?? 30_000,
      });
    })();
    keys = attempt;
    attempt.catch((err) => {
      console.warn(`[mcp-auth] cannot load the authorization server keys: ${describeError(err)}`);
      keys = undefined;
      failedAt = Date.now();
    });
    return attempt.catch((err) => {
      throw err instanceof AuthError ? err : toAuthError(new errors.JOSEError(String(err)));
    });
  }

  return {
    async authenticate(bearer): Promise<Principal> {
      if (!bearer || bearer.length > MAX_TOKEN_LENGTH) {
        throw invalid('The access token is missing or malformed.', 'unauthenticated');
      }

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(
          bearer,
          async (header, token) => (await getKeys())(header, token),
          {
            issuer,
            audience,
            algorithms: ALGORITHMS,
            clockTolerance: clockToleranceSeconds,
            requiredClaims: ['exp'],
          },
        ));
      } catch (err) {
        throw toAuthError(err);
      }

      const subject = text(payload.sub);
      const clientId = text(payload.client_id) ?? text(payload.azp);
      if (!subject && !clientId) {
        throw invalid('The access token does not identify a client or a user.', 'no_identity');
      }

      const scopes = scopesOf(payload);
      if (!scopes.includes(scope)) {
        throw new AuthError(
          'insufficient_scope',
          403,
          'The access token lacks the required scope.',
          'insufficient_scope',
          scope,
        );
      }

      return {
        kind: 'oauth',
        id: (clientId ?? subject) as string,
        ...(subject ? { subject } : {}),
        ...(clientId ? { clientId } : {}),
        ...(text(payload.jti) ? { tokenId: text(payload.jti) } : {}),
        scopes,
      };
    },

    challenge(error) {
      const parts: string[] = [];
      if (error) {
        // Quotes and backslashes would break the header's quoted-string syntax.
        parts.push(
          `error="${error.code}"`,
          `error_description="${error.message.replace(/["\\]/g, '')}"`,
        );
        if (error.scope) parts.push(`scope="${error.scope}"`);
      }
      parts.push(`resource_metadata="${metadataUrl}"`);
      return `Bearer ${parts.join(', ')}`;
    },

    metadata: {
      paths: [...new Set([`${WELL_KNOWN}${resourcePath}`, WELL_KNOWN])],
      document: {
        resource: audience,
        authorization_servers: [issuer],
        scopes_supported: [scope],
        bearer_methods_supported: ['header'],
        resource_name: 'Rockin Worker MCP server',
      },
    },
  };
}
