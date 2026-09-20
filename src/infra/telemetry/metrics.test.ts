// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../agent/agent.js';
import type { SyncAdapter } from '../../core/sync/adapter.js';
import { runSync } from '../../core/sync/engine.js';
import { jsonResponse, resetDb } from '../../testing/helpers.js';
import { installTestMetrics } from '../../testing/telemetry.js';
import { defineTool } from '../../tools/define.js';
import { fetchWithRetries } from '../http/client.js';
import { recordMcpRequest } from './metrics.js';

type Installed = ReturnType<typeof installTestMetrics>;
let installed: Installed;

// Each test gets its own provider, which also exercises the instruments being rebuilt when the
// global meter provider changes (the API has no proxy meter to do that for us).
beforeEach(() => {
  resetDb();
  installed = installTestMetrics();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await installed.uninstall();
});

type Histogram = { count: number; sum: number };
const histogram = async (name: string) =>
  (await installed.collect(name)).map((p) => ({
    attributes: p.attributes,
    ...(p.value as Histogram),
  }));
const counter = async (name: string) =>
  (await installed.collect(name)).map((p) => ({
    attributes: p.attributes,
    value: p.value as number,
  }));

const noLog = () => {};

function fakeAdapter(
  records: Array<{ id: number; at: string }>,
  failing = false,
): SyncAdapter<{ id: number; at: string }> {
  return {
    source: 'fake',
    async fetchPage() {
      if (failing) throw new Error('boom');
      return { records, nextCursor: null };
    },
    parse: (raw) => {
      const r = raw as { id: number; at: string };
      return { modifiedAt: r.at, value: r };
    },
    upsert: () => 'inserted',
  };
}

describe('metrics', () => {
  it('costs nothing and never throws when no SDK is registered', async () => {
    await installed.uninstall(); // back to the no-op provider

    expect(() => recordMcpRequest('ok')).not.toThrow();
    await expect(
      runSync(fakeAdapter([{ id: 1, at: '2026-03-01T00:00:00Z' }]), { logRun: noLog }),
    ).resolves.toMatchObject({ inserted: 1 });

    installed = installTestMetrics(); // so afterEach has something to uninstall
  });

  it('starts recording when a provider is registered after the first use', async () => {
    await installed.uninstall();
    recordMcpRequest('early'); // recorded against the no-op provider

    installed = installTestMetrics();
    recordMcpRequest('late');

    expect(await counter('rockin.mcp.requests')).toEqual([
      { attributes: { outcome: 'late' }, value: 1 },
    ]);
  });

  it('records a sync run: its duration by outcome and the records by operation', async () => {
    await runSync(
      fakeAdapter([
        { id: 1, at: '2026-03-01T00:00:00Z' },
        { id: 2, at: '2026-03-02T00:00:00Z' },
      ]),
      {
        logRun: noLog,
      },
    );

    const [duration] = await histogram('rockin.sync.duration');
    expect(duration).toMatchObject({
      attributes: { 'sync.source': 'fake', outcome: 'ok' },
      count: 1,
    });
    expect(await counter('rockin.sync.records')).toEqual([
      { attributes: { 'sync.source': 'fake', operation: 'inserted' }, value: 2 },
    ]);
  });

  it('labels a failed sync run as an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSync(fakeAdapter([], true), { logRun: noLog });

    const [duration] = await histogram('rockin.sync.duration');
    expect(duration?.attributes).toMatchObject({ outcome: 'error' });
    warn.mockRestore();
  });

  it('records outbound HTTP by method, host and status — never by URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, { status: 404 })),
    );

    await fetchWithRetries('https://api.example.com/secret/path?token=hunter2');

    const points = await histogram('http.client.request.duration');
    expect(points).toHaveLength(1);
    expect(points[0]?.attributes).toEqual({
      'http.request.method': 'GET',
      'server.address': 'api.example.com',
      'http.response.status_code': 404,
      'error.type': '404',
    });
    expect(JSON.stringify(points)).not.toMatch(/hunter2|secret\/path/);
  });

  it('records a request that failed without a response, typed by its error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(
      fetchWithRetries('https://api.example.com/x', { maxAttempts: 1 }),
    ).rejects.toThrow();

    const [point] = await histogram('http.client.request.duration');
    expect(point?.attributes).toMatchObject({ 'error.type': 'TypeError' });
    expect(point?.attributes).not.toHaveProperty('http.response.status_code');
  });

  describe('tools', () => {
    const tool = (run: (args: { n: number }) => unknown) =>
      defineTool({
        name: 'probe',
        title: 'Probe',
        description: 'd',
        input: z.object({ n: z.number() }),
        run,
      });

    it('times successful and failing calls, and keeps sync tools synchronous', async () => {
      const syncTool = tool(({ n }) => n * 2);
      const asyncTool = tool(async ({ n }) => n * 3);

      expect(syncTool.execute({ n: 2 })).toBe(4); // still not a promise
      await expect(asyncTool.execute({ n: 2 })).resolves.toBe(6);
      expect(() => syncTool.execute({ n: 'bad' })).toThrow(); // input validation is a failed call
      await expect(
        tool(async () => {
          throw new Error('nope');
        }).execute({ n: 1 }),
      ).rejects.toThrow('nope');

      const points = await histogram('rockin.tool.duration');
      const byOutcome = Object.fromEntries(
        points.map((p) => [String(p.attributes.outcome), p.count]),
      );
      expect(byOutcome).toEqual({ ok: 2, error: 2 });
      expect(points.every((p) => p.attributes['gen_ai.tool.name'] === 'probe')).toBe(true);
    });
  });

  describe('agent', () => {
    const reply = (content: unknown[], stop_reason: string, usage: object = {}) =>
      jsonResponse({
        content,
        stop_reason,
        usage: { input_tokens: 10, output_tokens: 5, ...usage },
      });
    const lookup = defineTool({
      name: 'lookup',
      title: 'Lookup',
      description: 'd',
      input: z.object({ q: z.string() }),
      run: () => ({ ok: true }),
    });

    it('records model latency and token usage, counting cached input tokens as input', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            reply([{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'x' } }], 'tool_use', {
              cache_creation_input_tokens: 900,
            }),
          )
          .mockResolvedValueOnce(
            reply([{ type: 'text', text: 'Done.' }], 'end_turn', { cache_read_input_tokens: 900 }),
          ),
      );

      await runAgent('q', { apiKey: 'k', model: 'claude-test', tools: [lookup] });

      const tokens = await histogram('gen_ai.client.token.usage');
      const sumOf = (type: string) =>
        tokens.find((p) => p.attributes['gen_ai.token.type'] === type)?.sum;
      expect(sumOf('input')).toBe(1820); // (10 + 900) per turn, two turns
      expect(sumOf('output')).toBe(10);

      const [duration] = await histogram('gen_ai.client.operation.duration');
      expect(duration).toMatchObject({ count: 2 });
      expect(duration?.attributes).toMatchObject({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-test',
      });
      // Prompts, answers and tool output are never metric attributes.
      expect(JSON.stringify(tokens)).not.toMatch(/Done\./);
    });

    it('records a failed model call as an error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: 'bad' }, { status: 400 })),
      );

      await expect(
        runAgent('q', { apiKey: 'k', model: 'claude-test', tools: [lookup] }),
      ).rejects.toThrow();

      const [duration] = await histogram('gen_ai.client.operation.duration');
      expect(duration?.attributes).toMatchObject({ 'error.type': 'error' });
      expect(await histogram('gen_ai.client.token.usage')).toEqual([]);
    });
  });
});
