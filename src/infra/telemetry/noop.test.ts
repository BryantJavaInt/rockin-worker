// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { markError, traced } from './tracing.js';

// No tracer provider is registered in this file: it is the production default when no OTLP
// endpoint is configured. Instrumentation must then be invisible — same values, same errors.
describe('tracing without any SDK registered (the default)', () => {
  it('changes nothing about what the wrapped code returns or throws', async () => {
    expect(traced('x', {}, () => 1)).toBe(1);
    await expect(traced('x', {}, async () => 'v')).resolves.toBe('v');
    expect(() =>
      traced('x', {}, () => {
        throw new Error('same error');
      }),
    ).toThrow('same error');
    await expect(traced('x', {}, async () => Promise.reject(new Error('same')))).rejects.toThrow(
      'same',
    );
  });

  it('markError is safe on a no-op span', () => {
    expect(() => traced('x', {}, (span) => markError(span, 'ignored'))).not.toThrow();
  });
});
