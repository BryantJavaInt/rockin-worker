// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

/** Scales a vector to unit length, so a dot product between two of them IS their cosine similarity. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  let sumOfSquares = 0;
  for (let i = 0; i < vector.length; i++) sumOfSquares += (vector[i] as number) ** 2;
  const length = Math.sqrt(sumOfSquares) || 1; // a zero vector stays zero instead of becoming NaN

  return Float32Array.from(vector, (x) => x / length);
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** Vectors are stored as raw little-endian float32 in a BLOB: 4 bytes per dimension, no parsing cost. */
export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice(); // own, aligned buffer (a BLOB view may not be 4-byte aligned)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
