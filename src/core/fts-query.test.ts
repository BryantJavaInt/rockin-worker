// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { ftsMatchQuery } from './query.js';

describe('ftsMatchQuery', () => {
  it('turns words into required, quoted prefix terms', () => {
    expect(ftsMatchQuery('q3 road')).toBe('"q3"* "road"*');
    expect(ftsMatchQuery('  Café   Niño ')).toBe('"café"* "niño"*');
  });

  it('can never smuggle FTS syntax through: operators become plain quoted words', () => {
    const query = ftsMatchQuery('NEAR(a b) OR "x" -y* col:z') ?? '';

    // Every term is a quoted word; nothing outside quotes except the prefix star and spaces.
    expect(query.replace(/"[\p{L}\p{N}]+"\*/gu, '').trim()).toBe('');
  });

  it.each(['', '   ', '***', '%', '()', '"'])('returns null when %j has no word', (text) => {
    expect(ftsMatchQuery(text)).toBeNull();
  });
});
