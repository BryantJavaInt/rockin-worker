// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSync } from '../../core/sync/engine.js';
import { getDb } from '../../infra/db/connection.js';
import { jsonResponse, resetDb } from '../../testing/helpers.js';
import { createNotionAdapter } from './adapter.js';

const noLog = () => {};
const page = (id: string, edited: string) => ({
  id,
  url: `https://notion.so/${id}`,
  last_edited_time: edited,
  properties: { Name: { type: 'title', title: [{ plain_text: `Page ${id}` }] } },
});
const blocks = (...texts: string[]) =>
  jsonResponse({
    results: texts.map((text, i) => ({
      id: `b${i}`,
      type: 'paragraph',
      paragraph: { rich_text: [{ plain_text: text }] },
    })),
    has_more: false,
    next_cursor: null,
  });
const search = (...pages: unknown[]) =>
  jsonResponse({ results: pages, has_more: false, next_cursor: null });

const withContent = () =>
  createNotionAdapter('notion-secret', 'https://notion.test', {
    syncContent: true,
    contentRequestIntervalMs: 0,
  });
const bodyOf = (id: string) =>
  (getDb().prepare('SELECT content FROM notion_pages WHERE id = ?').get(id) as { content: string })
    .content;

afterEach(() => vi.unstubAllGlobals());

describe('notion adapter: page content', () => {
  beforeEach(resetDb);

  it('reads the body of each synced page and stores it', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/v1/search')
        ? search(page('a', '2026-03-02T10:00:00.000Z'), page('b', '2026-03-01T10:00:00.000Z'))
        : url.includes('/a/children')
          ? blocks('Alpha body')
          : blocks('Beta body', 'second paragraph'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runSync(withContent(), { logRun: noLog });

    expect(summary).toMatchObject({ fetched: 2, inserted: 2, errors: 0 });
    expect(bodyOf('a')).toBe('Alpha body');
    expect(bodyOf('b')).toBe('Beta body\nsecond paragraph');
  });

  it('does not touch the blocks API when content sync is off', async () => {
    const fetchMock = vi.fn(async () => search(page('a', '2026-03-02T10:00:00.000Z')));
    vi.stubGlobal('fetch', fetchMock);

    await runSync(createNotionAdapter('notion-secret', 'https://notion.test'), {
      logRun: noLog,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf('a')).toBe('');
  });

  it('stores an empty body for a page the integration cannot read, and carries on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/v1/search')
          ? search(page('a', '2026-03-02T10:00:00.000Z'))
          : jsonResponse({ message: 'Could not find block' }, { status: 404 }),
      ),
    );

    const summary = await runSync(withContent(), { logRun: noLog });

    expect(summary).toMatchObject({ inserted: 1, errors: 0 });
    expect(bodyOf('a')).toBe('');
  });

  it('writes nothing when reading a body fails for another reason, so the next run retries it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/v1/search')
          ? search(page('a', '2026-03-02T10:00:00.000Z'))
          : jsonResponse({ message: 'invalid request' }, { status: 400 }),
      ),
    );

    const summary = await runSync(withContent(), { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toMatch(/400/);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM notion_pages').get()).toEqual({ n: 0 });
    warn.mockRestore();
  });
});
