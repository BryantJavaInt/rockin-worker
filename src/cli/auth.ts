// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { parseArgs } from 'node:util';
import {
  listRevocations,
  REVOCATION_KINDS,
  type RevocationKind,
  revoke,
  unrevoke,
} from '../mcp/auth/revocations.js';
import { UsageError } from './errors.js';

/** Exactly one of `--client`, `--subject`, `--token`, as a (kind, value) pair. */
function target(values: Record<string, string | boolean | undefined>): [RevocationKind, string] {
  const given = REVOCATION_KINDS.flatMap((kind) => {
    const value = values[kind];
    return typeof value === 'string' && value !== ''
      ? [[kind, value] as [RevocationKind, string]]
      : [];
  });

  const [only] = given;
  if (!only || given.length !== 1) {
    throw new UsageError('Give exactly one of --client <id>, --subject <id> or --token <jti>.');
  }
  return only;
}

/**
 * `auth revoke|unrevoke|list`: manage the credentials the remote MCP server refuses. A running
 * server sees the change on its next request — the deny-list lives in the shared database.
 */
export function authCommand(args: string[]): number {
  const [action, ...rest] = args;

  const { values } = parseArgs({
    args: rest,
    options: {
      client: { type: 'string' },
      subject: { type: 'string' },
      token: { type: 'string' },
      reason: { type: 'string' },
    },
  });

  switch (action) {
    case 'revoke': {
      const [kind, value] = target(values);
      revoke(kind, value, values.reason);
      console.log(`Revoked ${kind} "${value}". The server refuses it from its next request.`);
      return 0;
    }
    case 'unrevoke': {
      const [kind, value] = target(values);
      if (!unrevoke(kind, value)) {
        console.error(`${kind} "${value}" was not revoked.`);
        return 1;
      }
      console.log(`Lifted the revocation of ${kind} "${value}".`);
      return 0;
    }
    case 'list':
      console.log(JSON.stringify(listRevocations(), null, 2));
      return 0;
    default:
      throw new UsageError('auth needs an action: revoke, unrevoke or list.');
  }
}
