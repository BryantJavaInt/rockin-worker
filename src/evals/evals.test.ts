// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../testing/helpers.js';
import { findTool } from '../tools/registry.js';
import { EVAL_CASES } from './cases.js';
import { FIXTURE_PAGES, FIXTURE_REPOS, seedFixtures } from './fixtures.js';
import { scoreCase, summarizeScores } from './scoring.js';

const sampleCase = {
  id: 'c',
  question: 'q',
  expectedTool: 'github_getTopItems',
  answerIncludes: ['flagship-app'],
};
const call = (name: string, isError = false) => ({ name, input: {}, isError });

describe('scoreCase', () => {
  it('passes when the right tool ran and the answer is grounded', () => {
    const score = scoreCase(sampleCase, {
      answer: 'Your top repo is Flagship-App.',
      toolCalls: [call('github_getTopItems')],
      stopReason: 'end_turn',
    });

    expect(score).toMatchObject({ pass: true, toolOk: true, contentOk: true, failures: [] });
  });

  it('fails on the wrong tool, naming what was actually called', () => {
    const score = scoreCase(sampleCase, {
      answer: 'flagship-app',
      toolCalls: [call('notion_getRecentItems')],
      stopReason: 'end_turn',
    });

    expect(score.pass).toBe(false);
    expect(score.toolOk).toBe(false);
    expect(score.failures[0]).toMatch(/notion_getRecentItems/);
  });

  it('does not count an errored call as using the tool', () => {
    const score = scoreCase(sampleCase, {
      answer: 'flagship-app',
      toolCalls: [call('github_getTopItems', true)],
      stopReason: 'end_turn',
    });

    expect(score.toolOk).toBe(false);
  });

  it('fails an ungrounded answer even when the tool was right', () => {
    const score = scoreCase(sampleCase, {
      answer: 'I could not tell.',
      toolCalls: [call('github_getTopItems')],
      stopReason: 'end_turn',
    });

    expect(score).toMatchObject({ toolOk: true, contentOk: false, pass: false });
  });

  it('supports regex expectations and flags the max-turns guard', () => {
    const regexCase = { ...sampleCase, answerIncludes: undefined, answerMatches: "\\bno\\b|n't" };

    expect(
      scoreCase(regexCase, {
        answer: 'No such repo.',
        toolCalls: [call('github_getTopItems')],
        stopReason: 'end_turn',
      }).pass,
    ).toBe(true);
    expect(
      scoreCase(regexCase, {
        answer: 'Found it!',
        toolCalls: [call('github_getTopItems')],
        stopReason: 'end_turn',
      }).pass,
    ).toBe(false);
    expect(
      scoreCase(regexCase, {
        answer: 'no',
        toolCalls: [call('github_getTopItems')],
        stopReason: 'max_turns',
      }).failures,
    ).toContain('agent hit the max-turns guard');
  });
});

describe('summarizeScores', () => {
  it('computes the pass rate, and is safe on empty input', () => {
    expect(
      summarizeScores([{ pass: true }, { pass: false }, { pass: true }, { pass: true }] as never),
    ).toEqual({
      passed: 3,
      total: 4,
      rate: 0.75,
    });
    expect(summarizeScores([])).toEqual({ passed: 0, total: 0, rate: 0 });
  });
});

describe('eval suite integrity', () => {
  it('only expects tools that exist', () => {
    for (const testCase of EVAL_CASES) {
      expect(findTool(testCase.expectedTool), testCase.id).toBeDefined();
    }
  });

  it('has unique case ids', () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only expects answer text that the fixtures can actually produce', () => {
    const haystack = JSON.stringify([FIXTURE_REPOS, FIXTURE_PAGES]).toLowerCase();

    for (const testCase of EVAL_CASES) {
      for (const expected of testCase.answerIncludes ?? []) {
        expect(haystack, `${testCase.id}: "${expected}"`).toContain(expected.toLowerCase());
      }
    }
  });

  it('covers both sources, the empty case and the prompt-injection case', () => {
    const tools = new Set(EVAL_CASES.map((c) => c.expectedTool));

    expect(tools.size).toBe(4);
    expect(EVAL_CASES.some((c) => c.id.includes('empty'))).toBe(true);
    expect(EVAL_CASES.some((c) => c.id.includes('injection'))).toBe(true);
  });
});

describe('seedFixtures', () => {
  beforeEach(resetDb);

  it('seeds both stores and marks both sources as freshly synced', () => {
    seedFixtures();

    const top = findTool('github_getTopItems')?.execute({ limit: 1 }) as {
      items: Array<{ name: string }>;
      lastSyncAt: string;
    };
    const recent = findTool('notion_getRecentItems')?.execute({ limit: 1 }) as {
      items: Array<{ title: string }>;
    };

    expect(top.items[0]?.name).toBe('flagship-app');
    expect(top.lastSyncAt).not.toBeNull();
    expect(recent.items[0]?.title).toBe('Q3 Roadmap');
  });
});
