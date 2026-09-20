// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { Document } from '../../core/search/indexer.js';
import { getDb } from '../../infra/db/connection.js';
import { type RepoRow, toRepoItem } from './queries.js';

/** The text that describes a repository for semantic search: everything a person would search by. */
export function listRepoDocuments(): Document[] {
  const rows = getDb()
    .prepare('SELECT id, name, stars, description, language, topics, url FROM repos')
    .all() as RepoRow[];

  return rows.map((row) => {
    const repo = toRepoItem(row);
    const parts = [
      repo.name,
      repo.description,
      repo.language ? `Language: ${repo.language}` : null,
      repo.topics.length > 0 ? `Topics: ${repo.topics.join(', ')}` : null,
    ];
    return { id: String(repo.id), text: parts.filter(Boolean).join('. ') };
  });
}
