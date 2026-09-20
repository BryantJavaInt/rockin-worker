// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { AgentResult } from '../agent/agent.js';
import type { EvalCase } from './cases.js';

export type CaseScore = {
  id: string;
  pass: boolean;
  toolOk: boolean;
  contentOk: boolean;
  toolsCalled: string[];
  failures: string[];
};

export type ScoreSummary = { passed: number; total: number; rate: number };

/** Scores one agent run against its case. Pure — no I/O — so it is unit-testable without an API key. */
export function scoreCase(
  testCase: EvalCase,
  result: Pick<AgentResult, 'answer' | 'toolCalls' | 'stopReason'>,
): CaseScore {
  const failures: string[] = [];
  const toolsCalled = result.toolCalls.map((call) => call.name);

  const toolOk = result.toolCalls.some(
    (call) => call.name === testCase.expectedTool && !call.isError,
  );
  if (!toolOk) {
    failures.push(
      `expected a successful call to ${testCase.expectedTool}, got [${toolsCalled.join(', ') || 'none'}]`,
    );
  }

  if (result.stopReason === 'max_turns') failures.push('agent hit the max-turns guard');

  const answer = result.answer.toLowerCase();
  let contentOk = true;

  for (const expected of testCase.answerIncludes ?? []) {
    if (!answer.includes(expected.toLowerCase())) {
      contentOk = false;
      failures.push(`answer is missing "${expected}"`);
    }
  }

  if (testCase.answerMatches && !new RegExp(testCase.answerMatches, 'i').test(result.answer)) {
    contentOk = false;
    failures.push(`answer does not match /${testCase.answerMatches}/i`);
  }

  return {
    id: testCase.id,
    pass: failures.length === 0,
    toolOk,
    contentOk,
    toolsCalled,
    failures,
  };
}

export function summarizeScores(scores: readonly CaseScore[]): ScoreSummary {
  const passed = scores.filter((score) => score.pass).length;
  return { passed, total: scores.length, rate: scores.length === 0 ? 0 : passed / scores.length };
}
