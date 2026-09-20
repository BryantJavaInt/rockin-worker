// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRevoked } from '../mcp/auth/revocations.js';
import type { Principal } from '../mcp/auth/types.js';
import { resetDb } from '../testing/helpers.js';
import { run } from './index.js';

let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
const stdout = () => out.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
const stderr = () => err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

const principal: Principal = {
  kind: 'oauth',
  id: 'c1',
  clientId: 'c1',
  subject: 'u1',
  tokenId: 't1',
  scopes: [],
};

beforeEach(() => {
  resetDb();
  out = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('cli: auth', () => {
  it('revokes a client, lists it, and lifts the revocation', async () => {
    expect(await run(['auth', 'revoke', '--client', 'c1', '--reason', 'lost laptop'])).toBe(0);
    expect(stdout()).toMatch(/Revoked client "c1"/);
    expect(isRevoked(principal)).toBe(true);

    expect(await run(['auth', 'list'])).toBe(0);
    const listed = JSON.parse(out.mock.calls.at(-1)?.[0] as string);
    expect(listed).toEqual([
      expect.objectContaining({ kind: 'client', value: 'c1', reason: 'lost laptop' }),
    ]);

    expect(await run(['auth', 'unrevoke', '--client', 'c1'])).toBe(0);
    expect(isRevoked(principal)).toBe(false);
  });

  it.each([
    ['--subject', 'u1'],
    ['--token', 't1'],
  ])('revokes by %s', async (flag, value) => {
    expect(await run(['auth', 'revoke', flag, value])).toBe(0);

    expect(isRevoked(principal)).toBe(true);
  });

  it('says so, with exit 1, when there is nothing to lift', async () => {
    expect(await run(['auth', 'unrevoke', '--client', 'never-revoked'])).toBe(1);
    expect(stderr()).toMatch(/was not revoked/);
  });

  it('lists an empty deny-list as an empty array', async () => {
    expect(await run(['auth', 'list'])).toBe(0);

    expect(JSON.parse(stdout())).toEqual([]);
  });

  it.each([
    ['no action', ['auth']],
    ['an unknown action', ['auth', 'ban']],
    ['no target', ['auth', 'revoke']],
    ['two targets', ['auth', 'revoke', '--client', 'a', '--subject', 'b']],
    ['an empty target', ['auth', 'revoke', '--client', '']],
  ])('is a usage error (exit 2) with %s', async (_label, argv) => {
    expect(await run(argv)).toBe(2);
  });
});
