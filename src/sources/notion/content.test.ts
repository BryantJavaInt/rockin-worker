// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../infra/http/client.js';
import { jsonResponse } from '../../testing/helpers.js';
import { blockText, createContentReader, MAX_CONTENT_CHARS } from './content.js';

const rich = (...parts: string[]) => parts.map((plain_text) => ({ plain_text }));
const paragraph = (id: string, text: string, hasChildren = false) => ({
  id,
  type: 'paragraph',
  has_children: hasChildren,
  paragraph: { rich_text: rich(text) },
});
const children = (results: unknown[], next: string | null = null) =>
  jsonResponse({ results, has_more: next !== null, next_cursor: next });

const reader = () =>
  createContentReader({
    token: 'notion-secret',
    baseUrl: 'https://notion.test',
    notionVersion: '2022-06-28',
    throttle: async () => {},
  });

afterEach(() => vi.unstubAllGlobals());

describe('blockText', () => {
  it('joins the rich-text fragments of a text block', () => {
    expect(
      blockText({ id: '1', type: 'heading_2', heading_2: { rich_text: rich('Launch ', 'plan') } }),
    ).toBe('Launch plan');
  });

  it('marks to-do state', () => {
    expect(
      blockText({ id: '1', type: 'to_do', to_do: { checked: true, rich_text: rich('Ship') } }),
    ).toBe('[x] Ship');
    expect(
      blockText({ id: '1', type: 'to_do', to_do: { checked: false, rich_text: rich('Test') } }),
    ).toBe('[ ] Test');
  });

  it('reads table rows cell by cell', () => {
    expect(
      blockText({
        id: '1',
        type: 'table_row',
        table_row: { cells: [rich('Owner'), rich('Ana')] },
      }),
    ).toBe('Owner | Ana');
  });

  it.each(['divider', 'image', 'unsupported'])('yields nothing for a %s block', (type) => {
    expect(blockText({ id: '1', type, [type]: {} })).toBe('');
    expect(blockText({ id: '1', type })).toBe('');
  });
});

describe('createContentReader', () => {
  it('sends the token and version, and follows pagination', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(children([paragraph('b1', 'First')], 'next-1'))
      .mockResolvedValueOnce(children([paragraph('b2', 'Second')]));
    vi.stubGlobal('fetch', fetchMock);

    expect(await reader()('page-1')).toBe('First\nSecond');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://notion.test/v1/blocks/page-1/children?page_size=100');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer notion-secret',
      'Notion-Version': '2022-06-28',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toContain('start_cursor=next-1');
  });

  it('descends into nested blocks but not into child pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/page-1/')) {
        return children([
          paragraph('outer', 'Outer', true),
          { id: 'sub', type: 'child_page', has_children: true, child_page: { title: 'Sub' } },
        ]);
      }
      if (url.includes('/outer/')) return children([paragraph('inner', 'Inner')]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await reader()('page-1')).toBe('Outer\nInner');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops descending at the depth limit', async () => {
    // Every block claims a child, forever. Depth 0 (the page) plus three levels = 4 requests.
    const fetchMock = vi.fn(async () => children([paragraph('again', 'Level', true)]));
    vi.stubGlobal('fetch', fetchMock);

    expect(await reader()('page-1')).toBe('Level\nLevel\nLevel\nLevel');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('caps the size of a huge page', async () => {
    const big = 'x'.repeat(5_000);
    const fetchMock = vi.fn(async () =>
      children(
        Array.from({ length: 10 }, (_, i) => paragraph(`b${i}`, big)),
        'more',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const content = await reader()('page-1');

    expect(content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the cap ends pagination too
  });

  it.each([403, 404])('returns an empty body for a page it may not read (%i)', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'nope' }, { status })),
    );

    expect(await reader()('page-1')).toBe('');
  });

  it('propagates other failures so the page is retried on the next run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'bad' }, { status: 400 })),
    );

    await expect(reader()('page-1')).rejects.toBeInstanceOf(HttpError);
  });

  it('paces every request through the throttle', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(children([paragraph('b1', 'A')], 'n'))
        .mockResolvedValueOnce(children([paragraph('b2', 'B')])),
    );
    const throttle = vi.fn(async () => {});

    await createContentReader({
      token: 't',
      baseUrl: 'https://notion.test',
      notionVersion: '2022-06-28',
      throttle,
    })('page-1');

    expect(throttle).toHaveBeenCalledTimes(2);
  });
});
