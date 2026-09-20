// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { parseDuration } from './duration.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1.5h', 5_400_000],
    [' 10s ', 10_000],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['', '15', 'm', '-5m', '5 minutes', '1w', 'abc', '0s'])('rejects %j', (text) => {
    expect(() => parseDuration(text)).toThrow(/duration/i);
  });
});
