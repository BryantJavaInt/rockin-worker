// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import { ensureOk, fetchWithRetries, HttpError } from '../../infra/http/client.js';

/** Hard bounds on the work spent on one page, so a huge document cannot stall or bloat a sync. */
export const MAX_CONTENT_CHARS = 20_000;
const MAX_BLOCKS = 400;
const MAX_DEPTH = 3;

const RichText = z.array(z.object({ plain_text: z.string().optional() }).loose());

const BlockSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    has_children: z.boolean().optional(),
  })
  .loose();
type Block = z.infer<typeof BlockSchema>;

const ChildrenResponse = z.object({
  results: z.array(z.unknown()),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const plain = (richText: unknown): string => {
  const parsed = RichText.safeParse(richText);
  return parsed.success ? parsed.data.map((part) => part.plain_text ?? '').join('') : '';
};

/**
 * The human-readable text of one block, or '' when it has none. Every text-bearing block type
 * stores its words under `rich_text`; a table row keeps one rich-text array per cell. Images,
 * embeds, dividers and the like carry no text worth indexing and are skipped.
 */
export function blockText(block: Block): string {
  const body = block[block.type] as Record<string, unknown> | undefined;
  if (!body) return '';

  if (block.type === 'table_row' && Array.isArray(body.cells)) {
    return body.cells.map((cell) => plain(cell)).join(' | ');
  }

  const text = plain(body.rich_text);
  if (block.type === 'to_do' && text) return `${body.checked ? '[x]' : '[ ]'} ${text}`;
  return text;
}

// A child page or database is a page in its own right and is synced separately; descending into it
// would index the same words twice, under the wrong parent.
const SEPARATE_PAGES = new Set(['child_page', 'child_database']);

/**
 * Reads the body of Notion pages as plain text. Returns '' for a page the integration may not
 * read (403/404) — that is permanent, and must not block the sync. Any other failure (rate
 * limit exhausted, outage) propagates so the engine retries the page on the next run.
 */
export function createContentReader(options: {
  token: string;
  baseUrl: string;
  notionVersion: string;
  /** Awaited before every request to keep under Notion's rate limit. */
  throttle: () => Promise<void>;
}): (pageId: string) => Promise<string> {
  const { token, baseUrl, notionVersion, throttle } = options;
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': notionVersion };

  async function collect(
    blockId: string,
    depth: number,
    state: { chars: number; blocks: number; lines: string[] },
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      await throttle();
      const query = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await ensureOk(
        await fetchWithRetries(
          `${baseUrl}/v1/blocks/${encodeURIComponent(blockId)}/children?${query}`,
          {
            headers,
          },
        ),
        'Notion',
      );
      const page = ChildrenResponse.parse(await response.json());

      for (const raw of page.results) {
        if (state.blocks >= MAX_BLOCKS || state.chars >= MAX_CONTENT_CHARS) return;

        const block = BlockSchema.safeParse(raw);
        if (!block.success) continue;
        state.blocks++;

        const text = blockText(block.data).trim();
        if (text) {
          state.lines.push(text);
          state.chars += text.length + 1;
        }

        if (block.data.has_children && depth < MAX_DEPTH && !SEPARATE_PAGES.has(block.data.type)) {
          await collect(block.data.id, depth + 1, state);
        }
      }

      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor && state.blocks < MAX_BLOCKS && state.chars < MAX_CONTENT_CHARS);
  }

  return async (pageId) => {
    const state = { chars: 0, blocks: 0, lines: [] as string[] };

    try {
      await collect(pageId, 0, state);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return '';
      throw err;
    }

    return state.lines.join('\n').slice(0, MAX_CONTENT_CHARS);
  };
}
