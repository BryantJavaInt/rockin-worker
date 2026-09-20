// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { runAgent } from '../agent/agent.js';
import { loadConfig, requireSecret } from '../config/index.js';
import { closeDb } from '../infra/db/connection.js';
import { TOOLS } from '../tools/registry.js';
import { EVAL_CASES } from './cases.js';
import { seedFixtures } from './fixtures.js';
import { type CaseScore, scoreCase, summarizeScores } from './scoring.js';

// End-to-end evals: the real model, the real agent loop and the real tools, against
// fixed fixture data in a throwaway in-memory database (never your data.db).
// Requires ANTHROPIC_API_KEY. Deliberately not part of `npm test` or CI — it costs
// money and is nondeterministic; run it before demos and after changing tool
// descriptions or the system prompt (`npm run eval`).

dotenv.config({ quiet: true });

const { values } = parseArgs({
  options: {
    'min-score': { type: 'string', default: '0.85' },
    model: { type: 'string' },
  },
});

async function main(): Promise<number> {
  process.env.DB_PATH = ':memory:';
  const config = loadConfig();
  const apiKey = requireSecret(config, 'ANTHROPIC_API_KEY');
  const model = values.model ?? config.ANTHROPIC_MODEL;
  const minScore = Number(values['min-score']);

  seedFixtures();

  const scores: Array<
    CaseScore & { latencyMs: number; inputTokens: number; outputTokens: number }
  > = [];

  for (const testCase of EVAL_CASES) {
    try {
      const result = await runAgent(testCase.question, {
        apiKey,
        model,
        tools: TOOLS,
        temperature: 0,
      });
      scores.push({
        ...scoreCase(testCase, result),
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    } catch (err) {
      scores.push({
        id: testCase.id,
        pass: false,
        toolOk: false,
        contentOk: false,
        toolsCalled: [],
        failures: [`agent run failed: ${err instanceof Error ? err.message : String(err)}`],
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  }

  for (const score of scores) {
    console.log(`[${score.pass ? 'PASS' : 'FAIL'}] ${score.id}`);
    for (const failure of score.failures) console.log(`       - ${failure}`);
  }

  const summary = summarizeScores(scores);
  const tokens = scores.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
  console.log(
    `\nScore: ${summary.passed}/${summary.total} (${(summary.rate * 100).toFixed(0)}%) · ` +
      `model ${model} · ${tokens} tokens`,
  );

  const dir = path.resolve(config.LOG_DIR);
  mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify({ model, minScore, ...summary, tokens, cases: scores }, null, 2),
  );
  console.log(`Report: ${reportPath}`);

  return summary.rate >= minScore ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  closeDb();
}
