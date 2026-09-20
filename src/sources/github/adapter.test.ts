// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSync } from '../../core/sync/engine.js';
import { getDb } from '../../infra/db/connection.js';
import { HttpError } from '../../infra/http/client.js';
import { jsonResponse, resetDb } from '../../testing/helpers.js';
import { createGithubAdapter, parseNextLink } from './adapter.js';

const noLog = () => {};
const repo = (id: number, updated_at: string, extra: object = {}) => ({
  id,
  name: `repo-${id}`,
  stargazers_count: id * 10,
  updated_at,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('parseNextLink', () => {
  it('extracts the rel="next" URL', () => {
    const header =
      '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe('https://api.github.com/user/repos?page=2');
  });

  it('returns null on the last page or with no header', () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe('github adapter', () => {
  beforeEach(resetDb);

  it('syncs across pages by following the Link header, authenticating every request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([repo(1, '2026-03-02T00:00:00Z'), repo(2, '2026-03-01T00:00:00Z')], {
          headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([repo(3, '2026-02-01T00:00:00Z')]));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runSync(createGithubAdapter('secret-token'), { logRun: noLog });

    expect(summary).toMatchObject({ fetched: 3, inserted: 3, errors: 0, apiCalls: 2 });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.github.com/user/repos?page=2');
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer secret-token');
    }
    expect(getDb().prepare('SELECT stars FROM repos WHERE id = 3').get()).toEqual({ stars: 30 });
  });

  it('never sends the token to a foreign host named by a pagination link', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse([repo(1, '2026-03-02T00:00:00Z')], {
        headers: { link: '<https://evil.example/collect>; rel="next"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runSync(createGithubAdapter('secret-token'), { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toMatch(/foreign origin/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the evil host was never contacted
    warn.mockRestore();
  });

  it('surfaces upstream HTTP failures as an HttpError and does not advance state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad credentials', { status: 401 })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const adapter = createGithubAdapter('t');
    await expect(adapter.fetchPage(null)).rejects.toBeInstanceOf(HttpError);
    const summary = await runSync(adapter, { logRun: noLog });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toMatch(/401/);
    warn.mockRestore();
  });

  it('a full sync deletes repositories that no longer exist on GitHub', async () => {
    getDb().exec("INSERT INTO repos VALUES (999, 'deleted-upstream', 1, '2020-01-01T00:00:00Z')");
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([repo(1, '2026-03-02T00:00:00Z')])),
    );

    const summary = await runSync(createGithubAdapter('t'), { full: true, logRun: noLog });

    expect(summary.deleted).toBe(1);
    expect(getDb().prepare('SELECT id FROM repos').all()).toEqual([{ id: 1 }]);
  });

  it('rejects a non-array payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'oops' })));

    await expect(createGithubAdapter('t').fetchPage(null)).rejects.toThrow(/non-array/);
  });

  it('keeps only trusted fields and skips malformed repos', () => {
    const adapter = createGithubAdapter('t');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = adapter.parse(
      repo(7, '2026-03-02T00:00:00Z', { private: true, owner: { login: 'x' } }),
    );
    expect(ok?.modifiedAt).toBe('2026-03-02T00:00:00Z');
    expect(ok?.value).toMatchObject({ id: 7, name: 'repo-7', stars: 70 });
    expect(ok?.value).not.toHaveProperty('private');

    expect(adapter.parse({ id: 'not-a-number' })).toBeNull();
    expect(adapter.parse(null)).toBeNull();
    warn.mockRestore();
  });
});
