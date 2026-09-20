// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonResponse } from '../testing/helpers.js';
import { childrenOf, installTestTracing, parentIdOf } from '../testing/telemetry.js';
import { defineTool } from '../tools/define.js';
import { runAgent } from './agent.js';

const tracing = installTestTracing();
afterAll(() => tracing.uninstall());
beforeEach(() => tracing.reset());
afterEach(() => vi.unstubAllGlobals());

const SECRET_QUESTION = 'What is in my private repo called project-nightingale?';
const SECRET_TOOL_OUTPUT = 'confidential-page-title-4711';

const lookup = defineTool({
  name: 'lookup',
  title: 'Lookup',
  description: 'Looks something up.',
  input: z.object({ q: z.string() }),
  run: () => ({ found: SECRET_TOOL_OUTPUT }),
});

const reply = (content: unknown[], stop_reason: string, usage: object = {}) =>
  jsonResponse({
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 5, ...usage },
  });

function stubTwoTurns() {
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
        reply([{ type: 'text', text: 'It is fine.' }], 'end_turn', {
          cache_read_input_tokens: 900,
        }),
      ),
  );
}

describe('agent telemetry', () => {
  it('traces invoke_agent → chat → (HTTP) and execute_tool as a proper tree', async () => {
    stubTwoTurns();

    await runAgent(SECRET_QUESTION, { apiKey: 'k', model: 'claude-test', tools: [lookup] });

    const [agent] = tracing.named('invoke_agent rockin-worker');
    const chats = tracing.named('chat claude-test');
    const [tool] = tracing.named('execute_tool lookup');
    const https = tracing.named('HTTP POST');

    expect(chats).toHaveLength(2);
    expect(chats.every((c) => parentIdOf(c) === agent?.spanContext().spanId)).toBe(true);
    expect(parentIdOf(tool as never)).toBe(agent?.spanContext().spanId);
    expect(https.map((h) => parentIdOf(h))).toEqual(chats.map((c) => c.spanContext().spanId));
    expect(childrenOf(agent as never, tracing.spans()).length).toBe(3); // 2 chats + 1 tool
  });

  it('follows the GenAI semantic conventions, including cache token usage', async () => {
    stubTwoTurns();

    await runAgent('q', { apiKey: 'k', model: 'claude-test', tools: [lookup], temperature: 0 });

    const [first, second] = tracing.named('chat claude-test');
    expect(first?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-test',
      'gen_ai.request.temperature': 0,
      'gen_ai.response.finish_reasons': ['tool_use'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.cache_creation.input_tokens': 900,
    });
    expect(second?.attributes).toMatchObject({
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.usage.cache_read.input_tokens': 900,
    });

    expect(tracing.named('invoke_agent rockin-worker')[0]?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 10,
      'gen_ai.usage.cache_read.input_tokens': 900,
      'agent.turns': 2,
      'agent.tool_calls': 1,
      'agent.stop_reason': 'end_turn',
    });
    expect(tracing.named('execute_tool lookup')[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lookup',
    });
  });

  it('never records prompts, answers or tool output — private data must not reach a tracing backend', async () => {
    stubTwoTurns();

    await runAgent(SECRET_QUESTION, {
      apiKey: 'sk-secret-key',
      model: 'claude-test',
      tools: [lookup],
    });

    const everything = JSON.stringify(
      tracing.spans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
    );
    expect(everything).not.toContain('project-nightingale');
    expect(everything).not.toContain(SECRET_TOOL_OUTPUT);
    expect(everything).not.toContain('It is fine.');
    expect(everything).not.toContain('sk-secret-key');
  });

  it('records a failed model call on the chat span and the enclosing agent span', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));

    await expect(
      runAgent('q', { apiKey: 'k', model: 'claude-test', tools: [lookup] }),
    ).rejects.toThrow();

    expect(tracing.named('chat claude-test')[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(tracing.named('invoke_agent rockin-worker')[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records a tool that rejects the model's arguments as a failed execute_tool span", async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          reply([{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 5 } }], 'tool_use'),
        )
        .mockResolvedValueOnce(reply([{ type: 'text', text: 'ok' }], 'end_turn')),
    );

    await runAgent('q', { apiKey: 'k', model: 'claude-test', tools: [lookup] });

    expect(tracing.named('execute_tool lookup')[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
