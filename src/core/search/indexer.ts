// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createHash } from 'node:crypto';
import { withTransaction } from '../../infra/db/connection.js';
import type { EmbeddingProvider } from '../../infra/embeddings/provider.js';
import { listEmbeddings, pruneEmbeddings, saveEmbeddings } from './embedding-store.js';
import { normalize } from './vector.js';

/** What gets embedded for one synced item: a stable id and the text that describes it. */
export type Document = { id: string; text: string };

export type IndexSummary = {
  source: string;
  model: string;
  embedded: number;
  unchanged: number;
  removed: number;
};

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Brings the vector index of one source in line with its current documents, paying for
 * embeddings only where something changed: new documents, edited text (by hash), or a model
 * switch. Each batch commits on its own, so a failure midway keeps the progress made and the
 * next run simply continues — indexing is idempotent.
 */
export async function indexDocuments(options: {
  source: string;
  documents: Document[];
  provider: EmbeddingProvider;
  batchSize?: number;
}): Promise<IndexSummary> {
  const { source, provider, batchSize = 64 } = options;
  // Providers reject empty inputs, and an empty document has nothing to match anyway.
  const documents = options.documents.filter((doc) => doc.text.trim() !== '');

  const existing = new Map(listEmbeddings(source).map((row) => [row.id, row]));
  const pending = documents.filter((doc) => {
    const stored = existing.get(doc.id);
    return !stored || stored.model !== provider.model || stored.textHash !== hashText(doc.text);
  });

  let embedded = 0;
  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    const vectors = await provider.embed(
      batch.map((doc) => doc.text),
      'document',
    );
    if (vectors.length !== batch.length) {
      throw new Error(`Provider returned ${vectors.length} vectors for ${batch.length} documents.`);
    }

    withTransaction(() =>
      saveEmbeddings(
        source,
        provider.model,
        batch.map((doc, i) => ({
          id: doc.id,
          textHash: hashText(doc.text),
          vector: normalize(vectors[i] as number[]),
        })),
      ),
    );
    embedded += batch.length;
  }

  const removed = pruneEmbeddings(
    source,
    documents.map((doc) => doc.id),
  );

  return {
    source,
    model: provider.model,
    embedded,
    unchanged: documents.length - pending.length,
    removed,
  };
}
