// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { getSyncState, saveSyncState } from './state.js';

describe('sync state', () => {
  beforeEach(resetDb);

  it('reports an empty state for a source that never synced', () => {
    expect(getSyncState('github')).toEqual({ watermark: null, lastSuccessAt: null, pass: null });
  });

  it('round-trips and overwrites', () => {
    saveSyncState('github', { watermark: 'w1', lastSuccessAt: 't1' });
    saveSyncState('github', { watermark: 'w2', lastSuccessAt: 't2' });

    expect(getSyncState('github')).toEqual({ watermark: 'w2', lastSuccessAt: 't2', pass: null });
  });

  it('keeps sources independent', () => {
    saveSyncState('github', { watermark: 'g', lastSuccessAt: 't' });

    expect(getSyncState('notion').watermark).toBeNull();
  });

  it('stores a missing watermark as null even though the column is NOT NULL', () => {
    saveSyncState('notion', { watermark: null, lastSuccessAt: 't' });

    expect(getSyncState('notion')).toEqual({ watermark: null, lastSuccessAt: 't', pass: null });
  });
});

describe('sync state: unfinished pass', () => {
  beforeEach(resetDb);

  it('round-trips a saved pass and clears it when saved without one', () => {
    const pass = {
      cursor: 'c2',
      startedAt: '2026-03-01T00:00:00Z',
      newest: '2026-03-01T01:00:00Z',
      full: true,
      fetched: 250,
    };

    saveSyncState('github', { watermark: 'w', lastSuccessAt: 't', pass });
    expect(getSyncState('github').pass).toEqual(pass);

    saveSyncState('github', { watermark: 'w', lastSuccessAt: 't' });
    expect(getSyncState('github').pass).toBeNull();
  });
});
