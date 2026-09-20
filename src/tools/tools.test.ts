// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { seedFixtures } from '../evals/fixtures.js';
import { upsertRepo } from '../sources/github/store.js';
import { resetDb } from '../testing/helpers.js';
import { defineTool, toInputJsonSchema } from './define.js';
import { findTool, TOOLS } from './registry.js';

describe('tool registry', () => {
  it('has unique, provider-safe names', () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('exposes both sources', () => {
    const prefixes = new Set(TOOLS.map((tool) => tool.name.split('_')[0]));

    expect(prefixes).toEqual(new Set(['github', 'notion']));
  });

  it('produces plain JSON Schema for the model, without the $schema marker', () => {
    for (const tool of TOOLS) {
      const schema = toInputJsonSchema(tool);
      expect(schema.type).toBe('object');
      expect(schema).not.toHaveProperty('$schema');
    }
  });

  it('findTool returns undefined for unknown names', () => {
    expect(findTool('nope')).toBeUndefined();
  });
});

describe('tool execution', () => {
  beforeEach(resetDb);

  it('validates untrusted arguments before running', () => {
    const tool = findTool('github_search');

    expect(() => tool?.execute({ query: '' })).toThrow(z.ZodError);
    expect(() => tool?.execute({})).toThrow(z.ZodError);
    expect(() => findTool('github_getTopItems')?.execute({ limit: -3 })).toThrow(z.ZodError);
  });

  it('runs the query for valid arguments (and tolerates missing args)', () => {
    upsertRepo({ id: 1, name: 'x', stars: 1, syncedAt: '2026-03-01T00:00:00Z' });

    expect(findTool('github_getTopItems')?.execute(undefined)).toMatchObject({ count: 1 });
  });

  it('defineTool passes parsed (not raw) arguments to the handler', () => {
    const tool = defineTool({
      name: 't',
      title: 't',
      description: 'd',
      input: z.object({ n: z.coerce.number() }),
      run: ({ n }) => n * 2,
    });

    expect(tool.execute({ n: '21' })).toBe(42);
  });
});

describe('tool output contracts', () => {
  beforeEach(resetDb);

  const sampleArgs: Record<string, unknown> = {
    github_getTopItems: { limit: 3 },
    github_search: { query: 'a' },
    notion_getRecentItems: { limit: 3 },
    notion_search: { query: 'a' },
  };

  it('every tool declares an output schema and a sample call for this test', () => {
    for (const tool of TOOLS) {
      expect(tool.output, tool.name).toBeDefined();
      expect(sampleArgs[tool.name], `add sample args for ${tool.name}`).toBeDefined();
    }
  });

  it('real results conform to the declared schema — with data, and when empty', () => {
    for (const tool of TOOLS) {
      expect(
        () => tool.output?.parse(tool.execute(sampleArgs[tool.name])),
        `${tool.name} (empty)`,
      ).not.toThrow();
    }

    seedFixtures();
    for (const tool of TOOLS) {
      const result = tool.output?.parse(tool.execute(sampleArgs[tool.name])) as { count: number };
      expect(result.count, `${tool.name} (seeded)`).toBeGreaterThan(0);
    }
  });
});
