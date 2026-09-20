// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { Document } from '../../core/search/indexer.js';
import { getDb } from '../../infra/db/connection.js';

/** A Notion page is searchable by its title (page bodies are not synced). */
export function listPageDocuments(): Document[] {
  const rows = getDb().prepare('SELECT id, title FROM notion_pages').all() as Array<{
    id: string;
    title: string;
  }>;

  return rows.map((row) => ({ id: row.id, text: row.title }));
}
