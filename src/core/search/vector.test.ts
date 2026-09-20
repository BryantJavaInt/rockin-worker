// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { decodeVector, dot, encodeVector, normalize } from './vector.js';

describe('vectors', () => {
  it('normalize scales to unit length, so a dot product is a cosine', () => {
    const v = normalize([3, 4]);

    expect(dot(v, v)).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([0, 1]))).toBeCloseTo(0);
    expect(dot(normalize([2, 2]), normalize([1, 1]))).toBeCloseTo(1); // magnitude is irrelevant
  });

  it('keeps a zero vector at zero instead of producing NaN', () => {
    expect([...normalize([0, 0, 0])]).toEqual([0, 0, 0]);
  });

  it('round-trips through the BLOB encoding', () => {
    const original = normalize([0.1, -0.5, 0.25, 0.9]);

    const decoded = decodeVector(encodeVector(original));

    expect([...decoded]).toEqual([...original]);
  });

  it('decodes a BLOB that is not 4-byte aligned in its backing buffer', () => {
    const bytes = encodeVector(Float32Array.from([1, 2, 3]));
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);

    expect([...decodeVector(shifted.subarray(1))]).toEqual([1, 2, 3]);
  });
});
