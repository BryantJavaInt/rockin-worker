// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { EmbeddingProvider } from '../infra/embeddings/provider.js';

export type FakeProvider = EmbeddingProvider & {
  calls: Array<{ texts: string[]; kind: 'document' | 'query' }>;
};

/**
 * A deterministic stand-in for a real embedding model. Words in the same concept group land
 * on the same axis, so "routine" and "habits" are close while sharing no letters — exactly the
 * property that makes semantic search different from lexical search, without any network.
 */
export function fakeEmbeddings(concepts: string[][], model = 'fake-model'): FakeProvider {
  const calls: FakeProvider['calls'] = [];

  const vectorOf = (text: string): number[] => {
    const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const vector = concepts.map((group) => (group.some((word) => words.has(word)) ? 1 : 0));
    // A text touching no concept still needs a non-zero vector: give it its own "unrelated" axis.
    return [...vector, vector.some((x) => x === 1) ? 0 : 1];
  };

  return {
    model,
    calls,
    async embed(texts, kind) {
      calls.push({ texts: [...texts], kind });
      return texts.map(vectorOf);
    },
  };
}

export const CONCEPTS = [
  ['habit', 'habits', 'routine', 'routines', 'streak', 'streaks', 'daily'],
  ['finance', 'money', 'budget', 'currency', 'fx', 'payments'],
  ['sync', 'crdt', 'offline', 'replication'],
];
