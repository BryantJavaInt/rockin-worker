// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { Document } from '../../core/search/indexer.js';
import { getDb } from '../../infra/db/connection.js';

// An embedding represents the start of a page well (its purpose, headings, opening paragraphs);
// the rest is left to lexical search, which indexes the whole body. The cap also keeps a long page
// from dominating the embedding request.
export const EMBED_CONTENT_CHARS = 2_000;

/** A Notion page is embedded as its title followed by an excerpt of its body. */
export function listPageDocuments(): Document[] {
  const rows = getDb()
    .prepare('SELECT id, title, substr(content, 1, ?) AS excerpt FROM notion_pages')
    .all(EMBED_CONTENT_CHARS) as Array<{ id: string; title: string; excerpt: string }>;

  return rows.map((row) => ({
    id: row.id,
    text: row.excerpt ? `${row.title}\n\n${row.excerpt}` : row.title,
  }));
}
