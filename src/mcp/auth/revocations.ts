// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { getDb } from '../../infra/db/connection.js';
import type { Principal } from './types.js';

export const REVOCATION_KINDS = ['client', 'subject', 'token'] as const;
export type RevocationKind = (typeof REVOCATION_KINDS)[number];

export type Revocation = {
  kind: RevocationKind;
  value: string;
  revokedAt: string;
  reason: string | null;
};

/**
 * A deny-list kept next to the data, so `auth revoke` (a CLI run) takes effect on the next
 * request of a running server: SQLite is the shared state between the two processes.
 *
 * A signed JWT is valid until it expires wherever its signature checks out; the authorization
 * server cannot recall it. This list is how *this* resource server stops honouring a client, a
 * user or a single token (by `jti`) immediately, without waiting for expiry.
 */
export function revoke(kind: RevocationKind, value: string, reason?: string): void {
  getDb()
    .prepare(
      `INSERT INTO revocations (kind, value, revokedAt, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET revokedAt = excluded.revokedAt, reason = excluded.reason`,
    )
    .run(kind, value, new Date().toISOString(), reason ?? null);
}

/** Returns whether an entry existed. */
export function unrevoke(kind: RevocationKind, value: string): boolean {
  const { changes } = getDb()
    .prepare('DELETE FROM revocations WHERE kind = ? AND value = ?')
    .run(kind, value);
  return Number(changes) > 0;
}

export function listRevocations(): Revocation[] {
  return getDb()
    .prepare(
      'SELECT kind, value, revokedAt, reason FROM revocations ORDER BY revokedAt DESC, rowid DESC',
    )
    .all() as Revocation[];
}

/** Whether any identifier the principal carries is on the deny-list. */
export function isRevoked(principal: Principal): boolean {
  const identifiers: Array<[RevocationKind, string | undefined]> = [
    ['client', principal.clientId],
    ['subject', principal.subject],
    ['token', principal.tokenId],
  ];

  const check = getDb().prepare('SELECT 1 FROM revocations WHERE kind = ? AND value = ?');
  return identifiers.some(([kind, value]) => value !== undefined && !!check.get(kind, value));
}
