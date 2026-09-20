// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import { loadConfig } from '../../config/index.js';
import { ensureOk, fetchWithRetries } from '../http/client.js';

/**
 * Turns text into vectors. It is a port: the rest of the system depends on this interface,
 * so the provider (Voyage today) can change without touching search or indexing.
 *
 * `kind` matters: retrieval models embed a short *query* differently from a *document*, and
 * matching one against the other is what makes semantic search work.
 */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

const BATCH_SIZE = 128; // Voyage's per-request input limit

const VoyageResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
});

export function createVoyageProvider(
  apiKey: string,
  model: string,
  baseUrl = 'https://api.voyageai.com',
): EmbeddingProvider {
  return {
    model,

    async embed(texts, kind) {
      const vectors: number[][] = [];

      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const batch = texts.slice(start, start + BATCH_SIZE);
        const response = await ensureOk(
          await fetchWithRetries(`${baseUrl}/v1/embeddings`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: batch, model, input_type: kind }),
          }),
          'Voyage embeddings API',
        );

        const parsed = VoyageResponse.parse(await response.json());
        if (parsed.data.length !== batch.length) {
          throw new Error(
            `Voyage returned ${parsed.data.length} embeddings for ${batch.length} inputs.`,
          );
        }
        // The API tags each vector with its input index; do not rely on response order.
        vectors.push(...[...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
      }

      return vectors;
    },
  };
}

// The provider used by search tools is resolved from configuration, unless overridden.
// `undefined` = not overridden (use config), `null` = force "no provider", otherwise use it.
let override: EmbeddingProvider | null | undefined;

/** Overrides the provider (tests, embedding a different model). Pass `undefined` to reset. */
export function useEmbeddingProvider(provider: EmbeddingProvider | null | undefined): void {
  override = provider;
}

/** The configured provider, or null when semantic search is not set up (no API key). */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (override !== undefined) return override;

  const { VOYAGE_API_KEY, EMBEDDING_MODEL } = loadConfig();
  return VOYAGE_API_KEY ? createVoyageProvider(VOYAGE_API_KEY, EMBEDDING_MODEL) : null;
}
