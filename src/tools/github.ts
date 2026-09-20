// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import { getTopItems, searchByName } from '../sources/github/queries.js';
import { defineTool } from './define.js';

export const githubTools = [
  defineTool({
    name: 'github_getTopItems',
    title: 'Top GitHub repositories by stars',
    description:
      "Lists the user's synced GitHub repositories ranked by star count, highest first. " +
      'Use for questions about popularity or "my best/top/most-starred repos". ' +
      'Reads a local snapshot; it does not call the GitHub API.',
    input: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How many repositories to return (default 10, maximum 20).'),
    }),
    run: ({ limit }) => getTopItems({ limit }),
  }),

  defineTool({
    name: 'github_searchByName',
    title: 'Search GitHub repositories by name',
    description:
      "Finds the user's synced GitHub repositories whose name contains the given text " +
      '(case-insensitive substring). Use when the user names, or partly names, a specific repository. ' +
      'Reads a local snapshot; it does not call the GitHub API.',
    input: z.object({
      query: z.string().min(1).describe('Text to look for inside the repository name.'),
    }),
    run: ({ query }) => searchByName({ query }),
  }),
];
