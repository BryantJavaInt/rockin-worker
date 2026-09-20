// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import { getRecentItems, searchByName } from '../sources/notion/queries.js';
import { defineTool } from './define.js';

export const notionTools = [
  defineTool({
    name: 'notion_getRecentItems',
    title: 'Recently edited Notion pages',
    description:
      "Lists the user's synced Notion pages ordered by last edit time, most recent first. " +
      'Use for questions like "what did I work on lately" or "my latest notes/docs". ' +
      'Reads a local snapshot; it does not call the Notion API.',
    input: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How many pages to return (default 10, maximum 20).'),
    }),
    run: ({ limit }) => getRecentItems({ limit }),
  }),

  defineTool({
    name: 'notion_searchByName',
    title: 'Search Notion pages by title',
    description:
      "Finds the user's synced Notion pages whose title contains the given text " +
      '(case-insensitive substring). Use when the user names, or partly names, a specific page or document. ' +
      'Reads a local snapshot; it does not call the Notion API.',
    input: z.object({
      query: z.string().min(1).describe('Text to look for inside the page title.'),
    }),
    run: ({ query }) => searchByName({ query }),
  }),
];
