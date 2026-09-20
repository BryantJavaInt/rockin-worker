// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP } from '../config/meta.js';
import { seedFixtures } from '../evals/fixtures.js';
import { jsonResponse, resetDb } from '../testing/helpers.js';
import { run } from './index.js';

let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
const stdout = () => out.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
const stderr = () => err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

beforeEach(() => {
  resetDb();
  out = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Hermetic: whatever secrets the developer has exported must not leak into tests.
  for (const name of ['GITHUB_TOKEN', 'NOTION_TOKEN', 'ANTHROPIC_API_KEY']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cli: usage', () => {
  it('prints help and exits 0', async () => {
    expect(await run(['help'])).toBe(0);
    expect(stdout()).toMatch(/Usage:/);
  });

  it('exits 2 with usage when no command is given', async () => {
    expect(await run([])).toBe(2);
    expect(stderr()).toMatch(/Usage:/);
  });

  it.each(['version', '--version', '-v'])('%s prints version, author and license', async (flag) => {
    expect(await run([flag])).toBe(0);
    expect(stdout()).toContain(`rockin-worker ${APP.version}`);
    expect(stdout()).toContain(`By ${APP.author}`);
    expect(stdout()).toContain('MIT License');
  });

  it('credits the author in the help text', async () => {
    await run(['help']);
    expect(stdout()).toContain(`© ${APP.author}`);
  });

  it('exits 2 for an unknown command', async () => {
    expect(await run(['frobnicate'])).toBe(2);
    expect(stderr()).toMatch(/Unknown command "frobnicate"/);
  });
});

describe('cli: tool', () => {
  it('runs a tool against the local store and prints JSON', async () => {
    seedFixtures();

    expect(await run(['tool', 'github_getTopItems', '{"limit":1}'])).toBe(0);
    expect(JSON.parse(stdout()).items[0].name).toBe('flagship-app');
  });

  it('accepts flags, so no shell-specific JSON quoting is needed', async () => {
    seedFixtures();

    expect(await run(['tool', 'github_getTopItems', '--limit', '1'])).toBe(0);
    expect(JSON.parse(stdout()).items).toHaveLength(1);
  });

  it('accepts --key=value and keeps string-typed values as strings', async () => {
    seedFixtures();

    expect(await run(['tool', 'github_searchByName', '--query=flag'])).toBe(0);
    expect(JSON.parse(stdout()).items[0].name).toBe('flagship-app');

    out.mockClear();
    // "45" looks numeric, but the tool's schema says string — it must not be coerced.
    expect(await run(['tool', 'github_searchByName', '--query', '45'])).toBe(0);
    expect(JSON.parse(stdout()).count).toBe(0);
  });

  it('rejects typos in flag names instead of silently ignoring them', async () => {
    expect(await run(['tool', 'github_getTopItems', '--limt', '5'])).toBe(2);
    expect(stderr()).toMatch(/Unknown flag --limt.*--limit/);
  });

  it('rejects a flag with no value and stray positional arguments', async () => {
    expect(await run(['tool', 'github_getTopItems', '--limit'])).toBe(2);
    expect(await run(['tool', 'github_getTopItems', '5'])).toBe(2);
  });

  it('points to flags when JSON was mangled by the shell (PowerShell strips the quotes)', async () => {
    expect(await run(['tool', 'github_getTopItems', '{limit:1}'])).toBe(2);
    expect(stderr()).toMatch(/Use flags instead/);
  });

  it('rejects unknown tools, missing names and malformed JSON with exit 2', async () => {
    expect(await run(['tool'])).toBe(2);
    expect(await run(['tool', 'nope'])).toBe(2);
    expect(await run(['tool', 'github_getTopItems', '{not json'])).toBe(2);
    expect(await run(['tool', 'github_searchByName', '{}'])).toBe(1); // schema violation → runtime failure
    expect(stderr()).toMatch(/query/); // readable, not a raw Zod JSON dump
    expect(stderr()).not.toMatch(/"origin"/);
  });
});

describe('cli: sync', () => {
  it('rejects an unknown source', async () => {
    expect(await run(['sync', 'gitlab'])).toBe(2);
  });

  it('fails clearly when the requested source has no token', async () => {
    expect(await run(['sync', 'github'])).toBe(1);
    expect(stderr()).toMatch(/GITHUB_TOKEN is not set/);
  });

  it('fails when "all" finds nothing configured', async () => {
    expect(await run(['sync', 'all'])).toBe(1);
    expect(stderr()).toMatch(/No source is configured/);
  });

  it('syncs one source end to end and prints the summary', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([
            { id: 1, name: 'r', stargazers_count: 3, updated_at: '2026-03-01T00:00:00Z' },
          ]),
        ),
    );

    expect(await run(['sync', 'github'])).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ source: 'github', inserted: 1, errors: 0 });
  });

  it('"all" syncs only the configured sources and skips the rest', async () => {
    vi.stubEnv('NOTION_TOKEN', 'secret_test');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [], has_more: false, next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await run(['sync'])).toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('api.notion.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when a source reports errors', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    expect(await run(['sync', 'github'])).toBe(1);
    expect(JSON.parse(stdout()).errors).toBe(1);
  });
});

describe('cli: ask', () => {
  it('needs a question', async () => {
    expect(await run(['ask'])).toBe(2);
  });

  it('needs an API key', async () => {
    expect(await run(['ask', 'hello'])).toBe(1);
    expect(stderr()).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it('prints the agent answer, and the run stats on stderr', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: [{ type: 'text', text: 'Hi there' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      ),
    );

    expect(await run(['ask', 'hello', 'world'])).toBe(0);
    expect(stdout()).toBe('Hi there');
    expect(stderr()).toMatch(/tokens: 4 in \/ 2 out/);
  });
});

describe('cli: sync --every (worker mode)', () => {
  it('rejects an invalid or dangerously short interval', async () => {
    expect(await run(['sync', 'github', '--every', 'soon'])).toBe(2);
    expect(stderr()).toMatch(/Invalid duration/);
    expect(await run(['sync', 'github', '--every', '500ms'])).toBe(2);
    expect(stderr()).toMatch(/at least 1s/);
  });

  it('syncs, keeps running, and stops gracefully on the shutdown signal', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse([
          { id: 1, name: 'r', stargazers_count: 3, updated_at: '2026-03-01T00:00:00Z' },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const shutdown = new AbortController();

    const exit = run(['sync', 'github', '--every', '1h'], { signal: shutdown.signal });
    await vi.waitFor(() => expect(stdout()).toContain('"source": "github"'));
    shutdown.abort();

    expect(await exit).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderr()).toMatch(/Worker started/);
    expect(stderr()).toMatch(/Worker stopped/);
  });

  it('a failing cycle does not stop the worker', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    const shutdown = new AbortController();

    const exit = run(['sync', 'github', '--every', '1h'], { signal: shutdown.signal });
    await vi.waitFor(() => expect(stderr()).toMatch(/Cycle finished with errors/));
    shutdown.abort();

    expect(await exit).toBe(0);
  });
});

describe('cli: ask reports prompt-cache usage', () => {
  it('shows cache reads and writes when the API reports them', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
          },
        }),
      ),
    );

    expect(await run(['ask', 'hello'])).toBe(0);
    expect(stderr()).toMatch(/prompt cache: 900 read \/ 0 written/);
  });
});
