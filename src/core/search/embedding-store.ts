// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { getDb } from '../../infra/db/connection.js';
import { decodeVector, encodeVector } from './vector.js';

export type StoredEmbedding = { id: string; textHash: string; model: string };

export function listEmbeddings(source: string): StoredEmbedding[] {
  return getDb()
    .prepare('SELECT id, textHash, model FROM embeddings WHERE source = ?')
    .all(source) as StoredEmbedding[];
}

export function saveEmbeddings(
  source: string,
  model: string,
  rows: Array<{ id: string; textHash: string; vector: Float32Array }>,
): void {
  const statement = getDb().prepare(
    `INSERT INTO embeddings (source, id, model, textHash, dim, vector) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, id) DO UPDATE SET
       model = excluded.model, textHash = excluded.textHash,
       dim = excluded.dim, vector = excluded.vector`,
  );

  for (const row of rows) {
    statement.run(source, row.id, model, row.textHash, row.vector.length, encodeVector(row.vector));
  }
}

/** Deletes vectors of documents that no longer exist. Ids travel as one JSON array (json_each). */
export function pruneEmbeddings(source: string, keepIds: string[]): number {
  const { changes } = getDb()
    .prepare(
      'DELETE FROM embeddings WHERE source = ? AND id NOT IN (SELECT value FROM json_each(?))',
    )
    .run(source, JSON.stringify(keepIds));
  return Number(changes);
}

/** All stored vectors of one model. Vectors from other models are incomparable and ignored. */
export function loadVectors(
  source: string,
  model: string,
): Array<{ id: string; vector: Float32Array }> {
  const rows = getDb()
    .prepare('SELECT id, vector FROM embeddings WHERE source = ? AND model = ?')
    .all(source, model) as Array<{ id: string; vector: Uint8Array }>;

  return rows.map((row) => ({ id: row.id, vector: decodeVector(row.vector) }));
}
