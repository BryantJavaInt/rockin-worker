// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { loadConfig } from '../../config/index.js';
import { getEmbeddingProvider } from '../../infra/embeddings/provider.js';
import { loadVectors } from './embedding-store.js';
import { dot, normalize } from './vector.js';

/**
 * Reciprocal Rank Fusion: merges several best-first id lists into one. Each list contributes
 * 1 / (k + rank) per id, so an id ranked well by several lists beats one ranked first by only
 * one. It needs no score calibration — BM25 scores and cosine similarities are on unrelated
 * scales, which is exactly why fusing by rank is the robust choice. k = 60 is the standard.
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): string[] {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }

  // Array.sort is stable, so equal scores keep first-seen order (lexical list wins ties).
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Ids of the stored documents most similar to the query vector, best first, above `minScore`. */
export function semanticRank(
  source: string,
  queryVector: Float32Array,
  model: string,
  options: { limit: number; minScore: number },
): string[] {
  return loadVectors(source, model)
    .map(({ id, vector }) => ({ id, score: dot(queryVector, vector) }))
    .filter((match) => match.score >= options.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit)
    .map((match) => match.id);
}

export type HybridResult = {
  ids: string[];
  ranking: 'lexical' | 'hybrid';
  /** Why semantic ranking was skipped, when the caller should know. */
  warning?: string;
};

const CANDIDATES = 50;

/**
 * Best-first ids for a search: the lexical ranking, fused with a semantic ranking when a
 * provider is configured and the source has been indexed. Semantic search is an enhancement,
 * never a dependency: any failure (no key, empty index, provider outage) degrades to the
 * lexical result instead of failing the tool call.
 */
export async function hybridRank(options: {
  source: string;
  query: string;
  lexicalIds: string[];
}): Promise<HybridResult> {
  const { source, query, lexicalIds } = options;
  const lexical: HybridResult = { ids: lexicalIds, ranking: 'lexical' };

  const provider = getEmbeddingProvider();
  if (!provider) return lexical;

  if (loadVectors(source, provider.model).length === 0) {
    return {
      ...lexical,
      warning: 'Semantic search is configured but not indexed yet; run `embed`.',
    };
  }

  try {
    const [queryVector] = await provider.embed([query], 'query');
    if (!queryVector) return lexical;

    const semanticIds = semanticRank(source, normalize(queryVector), provider.model, {
      limit: CANDIDATES,
      minScore: loadConfig().SEMANTIC_MIN_SCORE,
    });
    if (semanticIds.length === 0) return lexical;

    return { ids: reciprocalRankFusion([lexicalIds, semanticIds]), ranking: 'hybrid' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...lexical,
      warning: `Semantic ranking was unavailable (${reason}); results are lexical only.`,
    };
  }
}
