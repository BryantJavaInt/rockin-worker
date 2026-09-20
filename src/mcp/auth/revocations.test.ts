// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { isRevoked, listRevocations, revoke, unrevoke } from './revocations.js';
import type { Principal } from './types.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  kind: 'oauth',
  id: 'client-a',
  clientId: 'client-a',
  subject: 'user-1',
  tokenId: 'tok-1',
  scopes: ['mcp:read'],
  ...overrides,
});

beforeEach(resetDb);

describe('revocations', () => {
  it('nothing is revoked by default', () => {
    expect(isRevoked(principal())).toBe(false);
  });

  it.each([
    ['client', 'client-a'],
    ['subject', 'user-1'],
    ['token', 'tok-1'],
  ] as const)('revoking a %s refuses every credential that carries it', (kind, value) => {
    revoke(kind, value, 'lost laptop');

    expect(isRevoked(principal())).toBe(true);
  });

  it('is precise: revoking one client leaves others alone', () => {
    revoke('client', 'client-a');

    expect(isRevoked(principal({ clientId: 'client-b', id: 'client-b' }))).toBe(false);
    expect(isRevoked(principal({ clientId: 'client-b', subject: 'user-2', tokenId: 't2' }))).toBe(
      false,
    );
  });

  it('does not confuse kinds: a client named like a subject is not that subject', () => {
    revoke('client', 'user-1');

    expect(isRevoked(principal({ clientId: 'other' }))).toBe(false);
  });

  it('a token without the identifier cannot match it', () => {
    revoke('token', 'tok-1');

    expect(isRevoked(principal({ tokenId: undefined }))).toBe(false);
  });

  it('can be lifted again, and says whether there was anything to lift', () => {
    revoke('client', 'client-a');

    expect(unrevoke('client', 'client-a')).toBe(true);
    expect(isRevoked(principal())).toBe(false);
    expect(unrevoke('client', 'client-a')).toBe(false);
  });

  it('revoking twice updates the entry instead of failing', () => {
    revoke('client', 'client-a', 'first');
    revoke('client', 'client-a', 'second');

    expect(listRevocations()).toHaveLength(1);
    expect(listRevocations()[0]).toMatchObject({
      kind: 'client',
      value: 'client-a',
      reason: 'second',
    });
  });

  it('lists what is revoked, newest first, with the reason', () => {
    revoke('client', 'old');
    revoke('token', 'new', 'leaked in a log');

    const [first, second] = listRevocations();
    expect([first?.value, second?.value]).toEqual(['new', 'old']);
    expect(first?.reason).toBe('leaked in a log');
    expect(second?.reason).toBeNull();
  });
});
