// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { getSyncState, saveSyncState } from './state.js';

describe('sync state', () => {
  beforeEach(resetDb);

  it('reports an empty state for a source that never synced', () => {
    expect(getSyncState('github')).toEqual({ watermark: null, lastSuccessAt: null });
  });

  it('round-trips and overwrites', () => {
    saveSyncState('github', { watermark: 'w1', lastSuccessAt: 't1' });
    saveSyncState('github', { watermark: 'w2', lastSuccessAt: 't2' });

    expect(getSyncState('github')).toEqual({ watermark: 'w2', lastSuccessAt: 't2' });
  });

  it('keeps sources independent', () => {
    saveSyncState('github', { watermark: 'g', lastSuccessAt: 't' });

    expect(getSyncState('notion').watermark).toBeNull();
  });

  it('stores a missing watermark as null even though the column is NOT NULL', () => {
    saveSyncState('notion', { watermark: null, lastSuccessAt: 't' });

    expect(getSyncState('notion')).toEqual({ watermark: null, lastSuccessAt: 't' });
  });
});
