// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';
import type { SyncAdapter } from '../../core/sync/adapter.js';
import { ensureOk, fetchWithRetries } from '../../infra/http/client.js';
import { type Repo, upsertRepo } from './store.js';

const DEFAULT_BASE_URL = 'https://api.github.com';

// z.object strips unknown keys, so only the fields we use are trusted and kept.
const RepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  stargazers_count: z.number(),
  updated_at: z.string(),
});

/** Extracts the `rel="next"` URL from a GitHub `Link` header, or null on the last page. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function createGithubAdapter(token: string, baseUrl = DEFAULT_BASE_URL): SyncAdapter<Repo> {
  const origin = new URL(baseUrl).origin;

  return {
    source: 'github',

    async fetchPage(cursor) {
      // The cursor is a URL that came from the server. Never send our bearer token
      // to a host other than the one we configured, even if a response points elsewhere.
      const url = cursor ?? `${baseUrl}/user/repos?per_page=100&sort=updated&direction=desc`;
      if (new URL(url).origin !== origin) {
        throw new Error(`Refusing to follow pagination link to foreign origin: ${url}`);
      }

      const response = await ensureOk(
        await fetchWithRetries(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }),
        'GitHub',
      );

      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        throw new Error('GitHub returned a non-array response for /user/repos');
      }

      return { records: body, nextCursor: parseNextLink(response.headers.get('link')) };
    },

    parse(raw) {
      const parsed = RepoSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('[github] skipping malformed repo:', z.prettifyError(parsed.error));
        return null;
      }

      const repo = parsed.data;
      return {
        modifiedAt: repo.updated_at,
        value: {
          id: repo.id,
          name: repo.name,
          stars: repo.stargazers_count,
          syncedAt: new Date().toISOString(),
        },
      };
    },

    upsert: upsertRepo,
  };
}
