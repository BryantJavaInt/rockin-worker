// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic by construction: an isolated in-memory database (Vitest gives each test
    // file its own worker, so each also gets a fresh one) and a temp log directory.
    // Tests never touch the real data.db or ./logs, whatever is in the developer's .env.
    env: {
      DB_PATH: ':memory:',
      LOG_DIR: path.join(tmpdir(), 'rockin-worker-test-logs'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entry points that only wire modules together / need real credentials.
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/main.ts', 'src/evals/run.ts'],
      reporter: ['text', 'lcov'],
      // A floor, not a target: CI fails if coverage regresses meaningfully.
      thresholds: { statements: 92, lines: 92, functions: 85, branches: 85 },
    },
  },
});
