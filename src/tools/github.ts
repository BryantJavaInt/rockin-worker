// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import { queryResultSchema } from '../core/query.js';
import { getTopItems, repoItemSchema, search } from '../sources/github/queries.js';
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
    output: queryResultSchema(repoItemSchema),
    run: ({ limit }) => getTopItems({ limit }),
  }),

  defineTool({
    name: 'github_search',
    title: 'Search GitHub repositories',
    description:
      "Searches the user's synced GitHub repositories by name, description and topics, best match " +
      'first (ranked full-text search with stemming, so "habits" finds "habit tracker"). Use when ' +
      'the user names a repository or describes what a project does or is built with. ' +
      'Reads a local snapshot; it does not call the GitHub API.',
    input: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'Words to look for: part of a name, or what the project does. No special syntax.',
        ),
    }),
    output: queryResultSchema(repoItemSchema),
    run: ({ query }) => search({ query }),
  }),
];
