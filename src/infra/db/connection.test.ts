// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { getDb, withTransaction } from './connection.js';

describe('withTransaction', () => {
  beforeEach(resetDb);

  it('commits every write when the callback succeeds', () => {
    withTransaction(() => {
      getDb().exec(
        "INSERT INTO repos (id, name, stars, syncedAt) VALUES (1, 'a', 1, 'x'), (2, 'b', 2, 'x')",
      );
    });

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 2 });
  });

  it('rolls back every write when the callback throws', () => {
    expect(() =>
      withTransaction(() => {
        getDb().exec("INSERT INTO repos (id, name, stars, syncedAt) VALUES (1, 'a', 1, 'x')");
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 0 });
  });
});

describe('getDb', () => {
  it('reuses one connection per database path', () => {
    expect(getDb()).toBe(getDb());
  });

  it('applies migrations on open', () => {
    const { user_version } = getDb().prepare('PRAGMA user_version').get() as {
      user_version: number;
    };

    expect(user_version).toBeGreaterThan(0);
  });
});
