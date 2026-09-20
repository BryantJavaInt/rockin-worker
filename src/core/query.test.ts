// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../testing/helpers.js';
import { buildResult, clampLimit, escapeLike, MAX_RESULTS } from './query.js';
import { saveSyncState } from './sync/state.js';

describe('buildResult', () => {
  beforeEach(resetDb);

  it('explains an empty result from a source that has never synced', () => {
    const result = buildResult('github', []);

    expect(result).toMatchObject({ source: 'github', lastSyncAt: null, count: 0, items: [] });
    expect(result.note).toMatch(/never been synced/);
  });

  it('distinguishes "synced but nothing matched" from "never synced"', () => {
    saveSyncState('github', { watermark: null, lastSuccessAt: '2026-03-01T12:00:00Z' });

    const result = buildResult('github', []);

    expect(result.lastSyncAt).toBe('2026-03-01T12:00:00Z');
    expect(result.note).toMatch(/No matching items/);
  });

  it('counts items, reports freshness and adds no note when there is data', () => {
    saveSyncState('notion', { watermark: null, lastSuccessAt: 't' });

    const result = buildResult('notion', [{ id: 1 }, { id: 2 }]);

    expect(result).toMatchObject({ count: 2, lastSyncAt: 't' });
    expect(result.note).toBeUndefined();
  });
});

describe('clampLimit', () => {
  it('defaults, floors and caps', () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(0)).toBe(10);
    expect(clampLimit(-5)).toBe(10);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(999)).toBe(MAX_RESULTS);
  });
});

describe('escapeLike', () => {
  it('escapes %, _ and the escape character itself', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
