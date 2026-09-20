// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../config/index.js';

/**
 * Structured run history, one JSON object per line (JSONL).
 *
 * Appending a line never rewrites the file, so it stays O(1) as history grows,
 * and every line is independently parseable (`jq`, log shippers) without
 * loading the whole file.
 */
export type RunLogEntry = {
  source: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  summary: Record<string, unknown>;
};

export function logSyncRun(entry: RunLogEntry): void {
  const dir = path.resolve(loadConfig().LOG_DIR);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, 'sync-history.jsonl'), `${JSON.stringify(entry)}\n`, 'utf-8');
}
