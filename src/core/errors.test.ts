// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeError } from './errors.js';

describe('describeError', () => {
  it('uses the message of a plain Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error throwables', () => {
    expect(describeError('just a string')).toBe('just a string');
  });

  it('renders validation errors readably, not as raw JSON', () => {
    const result = z.object({ query: z.string().min(1) }).safeParse({ query: '' });
    const text = describeError(result.error);

    expect(text).toMatch(/query/);
    expect(text).not.toMatch(/"origin"/);
  });
});
