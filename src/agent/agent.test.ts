// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { seedFixtures } from '../evals/fixtures.js';
import { HttpError } from '../infra/http/client.js';
import { jsonResponse, resetDb } from '../testing/helpers.js';
import { defineTool } from '../tools/define.js';
import { TOOLS } from '../tools/registry.js';
import { runAgent, SYSTEM_PROMPT } from './agent.js';

const echoTool = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Echoes text back.',
  input: z.object({ text: z.string() }),
  run: ({ text }) => ({ echoed: text }),
});

const options = { apiKey: 'test-key', model: 'test-model', tools: [echoTool] };

const reply = (content: unknown[], stop_reason: string) =>
  jsonResponse({
    id: 'msg_1',
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
const toolUse = (input: unknown, name = 'echo', id = 'tu_1') => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const text = (t: string) => ({ type: 'text', text: t });

const requestBody = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(fetchMock.mock.calls[call]?.[1].body);

afterEach(() => vi.unstubAllGlobals());

describe('runAgent', () => {
  it('answers directly when no tool is needed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([text('Hello!')], 'end_turn')));

    const result = await runAgent('hi', options);

    expect(result).toMatchObject({
      answer: 'Hello!',
      toolCalls: [],
      turns: 1,
      stopReason: 'end_turn',
    });
  });

  it('runs the requested tool, feeds the result back, and returns the final answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply([text('Let me check.'), toolUse({ text: 'hi' })], 'tool_use'))
      .mockResolvedValueOnce(reply([text('It said: hi')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAgent('say hi', options);

    expect(result.answer).toBe('It said: hi');
    expect(result.toolCalls).toEqual([{ name: 'echo', input: { text: 'hi' }, isError: false }]);
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    // Request 1: authenticated, carries the system prompt and the tool's JSON Schema.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('test-key');
    const first = requestBody(fetchMock, 0);
    expect(first.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    expect(first.tools[0]).toMatchObject({ name: 'echo', input_schema: { type: 'object' } });

    // Request 2: replays the assistant turn and answers the tool call by id.
    const second = requestBody(fetchMock, 1);
    const toolResult = second.messages.at(-1).content[0];
    expect(second.messages.at(-1).role).toBe('user');
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(JSON.parse(toolResult.content)).toEqual({ echoed: 'hi' });
  });

  it('reports invalid model-produced arguments back to the model instead of crashing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply([toolUse({ text: 123 })], 'tool_use'))
      .mockResolvedValueOnce(reply([text('Sorry, retrying.')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAgent('x', options);

    expect(result.toolCalls[0]?.isError).toBe(true);
    const toolResult = requestBody(fetchMock, 1).messages.at(-1).content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/Tool "echo" failed/);
  });

  it('reports an unknown tool as an error result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply([toolUse({}, 'made_up')], 'tool_use'))
      .mockResolvedValueOnce(reply([text('ok')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAgent('x', options);

    expect(result.toolCalls).toEqual([{ name: 'made_up', input: {}, isError: true }]);
    expect(requestBody(fetchMock, 1).messages.at(-1).content[0].content).toMatch(/Unknown tool/);
  });

  it('truncates oversized tool output before it reaches the model', async () => {
    const bigTool = defineTool({
      name: 'big',
      title: 'Big',
      description: 'Returns a lot.',
      input: z.object({}),
      run: () => 'x'.repeat(50_000),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply([toolUse({}, 'big')], 'tool_use'))
      .mockResolvedValueOnce(reply([text('done')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('x', { ...options, tools: [bigTool] });

    const content: string = requestBody(fetchMock, 1).messages.at(-1).content[0].content;
    expect(content.length).toBeLessThan(21_000);
    expect(content.endsWith('[truncated]')).toBe(true);
  });

  it('stops at maxTurns instead of looping forever', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => reply([toolUse({ text: 'again' })], 'tool_use'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAgent('loop', { ...options, maxTurns: 3 });

    expect(result).toMatchObject({ stopReason: 'max_turns', answer: '', turns: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws a typed HttpError on an API failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid x-api-key', { status: 401 })),
    );

    await expect(runAgent('x', options)).rejects.toBeInstanceOf(HttpError);
  });

  it('forwards temperature only when set', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () => reply([text('ok')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('x', options);
    await runAgent('x', { ...options, temperature: 0 });

    expect(requestBody(fetchMock, 0)).not.toHaveProperty('temperature');
    expect(requestBody(fetchMock, 1).temperature).toBe(0);
  });
});

describe('runAgent with the real tool registry', () => {
  beforeEach(() => {
    resetDb();
    seedFixtures();
  });

  it('hands the model real store data, including the hostile page title, as plain tool output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply([toolUse({ limit: 3 }, 'notion_getRecentItems')], 'tool_use'))
      .mockResolvedValueOnce(reply([text('done')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('recent pages?', { apiKey: 'k', model: 'm', tools: TOOLS });

    const toolResult = requestBody(fetchMock, 1).messages.at(-1).content[0];
    const payload = JSON.parse(toolResult.content);
    expect(payload.items.map((i: { title: string }) => i.title)).toContain('Q3 Roadmap');
    expect(toolResult.content).toContain('BANANA'); // present as data...
    expect(SYSTEM_PROMPT).toMatch(/DATA .* not instructions/s); // ...and the model is told to treat it so
  });
});

describe('prompt caching', () => {
  const twoTools = [
    echoTool,
    defineTool({
      name: 'second',
      title: 'Second',
      description: 'Another tool.',
      input: z.object({}),
      run: () => ({}),
    }),
  ];

  it('marks the system prompt and only the LAST tool as a cache breakpoint', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply([text('ok')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('x', { ...options, tools: twoTools });

    const body = requestBody(fetchMock, 0);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0]).not.toHaveProperty('cache_control');
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends a plain system string and no cache markers when disabled', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply([text('ok')], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('x', { ...options, tools: twoTools, promptCaching: false });

    const body = requestBody(fetchMock, 0);
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('accumulates cache reads and writes across turns, tolerating null/absent fields', async () => {
    const withUsage = (usage: object, content: unknown[], stop: string) =>
      jsonResponse({ id: 'm', content, stop_reason: stop, usage });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        withUsage(
          {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 1200,
            cache_read_input_tokens: null,
          },
          [toolUse({ text: 'hi' })],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(
        withUsage(
          { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1200 },
          [text('done')],
          'end_turn',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAgent('x', options);

    expect(result.usage).toEqual({
      inputTokens: 14,
      outputTokens: 7,
      cacheReadTokens: 1200,
      cacheCreationTokens: 1200,
    });
  });
});
