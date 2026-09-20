// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSync } from '../../core/sync/engine.js';
import { getDb } from '../../infra/db/connection.js';
import { jsonResponse, resetDb } from '../../testing/helpers.js';
import { createNotionAdapter, extractTitle } from './adapter.js';

const noLog = () => {};
const titleProp = (text: string) => ({ type: 'title', title: [{ plain_text: text }] });
const page = (id: string, edited: string, title = `Page ${id}`) => ({
  id,
  url: `https://notion.so/${id}`,
  last_edited_time: edited,
  properties: { Name: titleProp(title) },
});
const envelope = (results: unknown[], next: string | null = null) =>
  jsonResponse({ results, has_more: next !== null, next_cursor: next });

afterEach(() => vi.unstubAllGlobals());

describe('extractTitle', () => {
  it('finds the title property regardless of its key', () => {
    expect(extractTitle({ Status: { type: 'select' }, Task: titleProp('Ship v2') })).toBe(
      'Ship v2',
    );
  });

  it('joins rich-text fragments', () => {
    expect(
      extractTitle({
        t: { type: 'title', title: [{ plain_text: 'Q3 ' }, { plain_text: 'Plan' }] },
      }),
    ).toBe('Q3 Plan');
  });

  it('falls back for missing or empty titles', () => {
    expect(extractTitle({})).toBe('(untitled)');
    expect(extractTitle({ t: titleProp('') })).toBe('(untitled)');
    expect(extractTitle({ t: null })).toBe('(untitled)');
  });
});

describe('notion adapter', () => {
  beforeEach(resetDb);

  it('paginates with start_cursor, sorted newest-edited-first, and stores titles', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        envelope([page('a', '2026-03-02T10:00:00.000Z', 'Q3 Roadmap')], 'cursor-2'),
      )
      .mockResolvedValueOnce(envelope([page('b', '2026-03-01T10:00:00.000Z')]));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runSync(createNotionAdapter('notion-secret'), { logRun: noLog });

    expect(summary).toMatchObject({ fetched: 2, inserted: 2, errors: 0, apiCalls: 2 });

    const [firstUrl, firstInit] = fetchMock.mock.calls[0] ?? [];
    expect(firstUrl).toBe('https://api.notion.com/v1/search');
    expect(firstInit.method).toBe('POST');
    expect(firstInit.headers.Authorization).toBe('Bearer notion-secret');
    const firstBody = JSON.parse(firstInit.body);
    expect(firstBody.sort).toEqual({ direction: 'descending', timestamp: 'last_edited_time' });
    expect(firstBody).not.toHaveProperty('start_cursor');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body).start_cursor).toBe('cursor-2');

    expect(getDb().prepare("SELECT title FROM notion_pages WHERE id = 'a'").get()).toEqual({
      title: 'Q3 Roadmap',
    });
  });

  it('aborts the run when the response envelope is not what Notion documents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ object: 'error', status: 400 })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runSync(createNotionAdapter('t'), { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toMatch(/Unexpected Notion response shape/);
    warn.mockRestore();
  });

  it('skips a single malformed page inside a valid envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelope([{ id: 42 }, page('ok', '2026-03-02T10:00:00.000Z')])),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runSync(createNotionAdapter('t'), { logRun: noLog });

    expect(summary).toMatchObject({ skipped: 1, fetched: 1, errors: 0 });
    warn.mockRestore();
  });

  it('a full sync deletes pages that no longer exist in Notion', async () => {
    getDb().exec(
      "INSERT INTO notion_pages VALUES ('gone', 'Old', 'u', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00Z')",
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelope([page('a', '2026-03-02T10:00:00.000Z')])),
    );

    const summary = await runSync(createNotionAdapter('t'), { full: true, logRun: noLog });

    expect(summary.deleted).toBe(1);
    expect(getDb().prepare('SELECT id FROM notion_pages').all()).toEqual([{ id: 'a' }]);
  });

  it('treats has_more=false as the end even if a cursor is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [page('a', '2026-03-02T10:00:00.000Z')],
        has_more: false,
        next_cursor: 'stale',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runSync(createNotionAdapter('t'), { logRun: noLog });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
