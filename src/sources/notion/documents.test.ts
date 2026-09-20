// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../testing/helpers.js';
import { EMBED_CONTENT_CHARS, listPageDocuments } from './documents.js';
import { upsertPage } from './store.js';

const add = (id: string, title: string, content?: string) =>
  upsertPage({
    id,
    title,
    content,
    url: `https://notion.so/${id}`,
    lastEditedTime: '2026-01-01T00:00:00.000Z',
    syncedAt: '2026-03-01T00:00:00Z',
  });

describe('listPageDocuments', () => {
  beforeEach(resetDb);

  it('embeds the title alone for a page without a body', () => {
    add('a', 'Roadmap');

    expect(listPageDocuments()).toEqual([{ id: 'a', text: 'Roadmap' }]);
  });

  it('embeds the title followed by the body', () => {
    add('a', 'Roadmap', 'Ship search first.');

    expect(listPageDocuments()).toEqual([{ id: 'a', text: 'Roadmap\n\nShip search first.' }]);
  });

  it('cuts a long body to the excerpt size', () => {
    add('a', 'Long', 'w'.repeat(EMBED_CONTENT_CHARS * 3));

    expect(listPageDocuments()[0]?.text).toBe(`Long\n\n${'w'.repeat(EMBED_CONTENT_CHARS)}`);
  });
});
