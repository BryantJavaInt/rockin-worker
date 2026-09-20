// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthError, type Authenticator } from './types.js';

/**
 * Compares tokens in constant time. Hashing both sides first gives equal-length inputs (which
 * timingSafeEqual requires) and keeps the token's length from leaking through timing.
 */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * The single shared secret: right for one person or one trusted team, with one identity for all
 * callers. It cannot tell clients apart, so it cannot revoke one of them — that is what the
 * OAuth mode is for.
 */
export function createStaticAuthenticator(token: string): Authenticator {
  return {
    async authenticate(bearer) {
      if (!tokensMatch(bearer, token)) {
        throw new AuthError('invalid_token', 401, 'Unauthorized.', 'unauthenticated');
      }
      return { kind: 'static', id: 'static', scopes: [] };
    },
    challenge: () => 'Bearer realm="mcp"',
  };
}
