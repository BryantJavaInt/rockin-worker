// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonResponse } from '../testing/helpers.js';
import { defineTool } from '../tools/define.js';
import { runAgent } from './agent.js';

afterEach(() => vi.unstubAllGlobals());

const reply = (content: unknown[], stop_reason: string) =>
  jsonResponse({ content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });

// Regression guard: JSON.stringify(somePromise) is "{}" — an un-awaited async tool would send the
// model an empty object and the agent would answer from nothing, with no error anywhere.
describe('agent with asynchronous tools', () => {
  it('awaits the tool and hands the model its real result', async () => {
    const slow = defineTool({
      name: 'slow',
      title: 'Slow',
      description: 'Resolves later.',
      input: z.object({}),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { answer: 42 };
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply([{ type: 'tool_use', id: 't1', name: 'slow', input: {} }], 'tool_use'),
      )
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'done' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('q', { apiKey: 'k', model: 'm', tools: [slow] });

    const sent = JSON.parse(fetchMock.mock.calls[1]?.[1].body);
    const toolResult = sent.messages.at(-1).content[0];
    expect(JSON.parse(toolResult.content)).toEqual({ answer: 42 });
  });

  it('reports a rejected async tool as a tool error, not a crash', async () => {
    const failing = defineTool({
      name: 'failing',
      title: 'Failing',
      description: 'Rejects.',
      input: z.object({}),
      run: async () => {
        throw new Error('backend unreachable');
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply([{ type: 'tool_use', id: 't1', name: 'failing', input: {} }], 'tool_use'),
      )
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'sorry' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAgent('q', { apiKey: 'k', model: 'm', tools: [failing] });

    expect(result.toolCalls[0]?.isError).toBe(true);
    const sent = JSON.parse(fetchMock.mock.calls[1]?.[1].body);
    expect(sent.messages.at(-1).content[0].content).toMatch(/backend unreachable/);
  });

  it('runs several tool calls of one turn concurrently', async () => {
    const order: string[] = [];
    const make = (name: string, ms: number) =>
      defineTool({
        name,
        title: name,
        description: name,
        input: z.object({}),
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          order.push(name);
          return name;
        },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(
          [
            { type: 'tool_use', id: 'a', name: 'slow', input: {} },
            { type: 'tool_use', id: 'b', name: 'fast', input: {} },
          ],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'ok' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    await runAgent('q', { apiKey: 'k', model: 'm', tools: [make('slow', 30), make('fast', 1)] });

    expect(order).toEqual(['fast', 'slow']); // the fast one did not wait for the slow one
    const ids = JSON.parse(fetchMock.mock.calls[1]?.[1].body)
      .messages.at(-1)
      .content.map((b: { tool_use_id: string }) => b.tool_use_id);
    expect(ids).toEqual(['a', 'b']); // ...but results keep the model's order
  });
});
