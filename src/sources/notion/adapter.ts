// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import type { SyncAdapter } from '../../core/sync/adapter.js';
import { ensureOk, fetchWithRetries } from '../../infra/http/client.js';
import { type NotionPage, upsertPage } from './store.js';

const DEFAULT_BASE_URL = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';

// The envelope failing validation means the integration itself is broken (auth,
// API version drift) — the page fetch throws. One bad page inside a valid
// envelope is just skipped.
const SearchResponseSchema = z.object({
  results: z.array(z.unknown()),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const PageSchema = z.object({
  id: z.string(),
  url: z.string(),
  last_edited_time: z.string(),
  // Shape depends on each database's schema, so it stays untyped until extractTitle.
  properties: z.record(z.string(), z.unknown()).default({}),
});

/**
 * A page's title lives in whichever property has type "title" — its key varies
 * per database ("Name", "Task", ...), so search by type instead of assuming a key.
 */
export function extractTitle(properties: Record<string, unknown>): string {
  for (const prop of Object.values(properties)) {
    const candidate = prop as { type?: string; title?: unknown } | null;
    if (candidate?.type === 'title' && Array.isArray(candidate.title)) {
      const text = candidate.title
        .map((part) => (part as { plain_text?: string }).plain_text ?? '')
        .join('');
      if (text) return text;
    }
  }
  return '(untitled)';
}

export function createNotionAdapter(
  token: string,
  baseUrl = DEFAULT_BASE_URL,
): SyncAdapter<NotionPage> {
  return {
    source: 'notion',

    async fetchPage(cursor) {
      // Notion's search endpoint has no server-side "modified since" filter, so we ask
      // for newest-edited-first and let the engine stop at the watermark.
      const response = await ensureOk(
        await fetchWithRetries(`${baseUrl}/v1/search`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filter: { property: 'object', value: 'page' },
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        }),
        'Notion',
      );

      const envelope = SearchResponseSchema.safeParse(await response.json());
      if (!envelope.success) {
        throw new Error(`Unexpected Notion response shape: ${z.prettifyError(envelope.error)}`);
      }

      const { results, has_more, next_cursor } = envelope.data;
      return { records: results, nextCursor: has_more ? next_cursor : null };
    },

    parse(raw) {
      const parsed = PageSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('[notion] skipping malformed page:', z.prettifyError(parsed.error));
        return null;
      }

      const page = parsed.data;
      return {
        modifiedAt: page.last_edited_time,
        value: {
          id: page.id,
          title: extractTitle(page.properties),
          url: page.url,
          lastEditedTime: page.last_edited_time,
          syncedAt: new Date().toISOString(),
        },
      };
    },

    upsert: upsertPage,
  };
}
