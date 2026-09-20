#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import dotenv from 'dotenv';
import { run } from './cli/index.js';
import { closeDb } from './infra/db/connection.js';
import { initTelemetry } from './infra/telemetry/setup.js';

// quiet: dotenv v17 logs to stdout by default, which would corrupt the MCP
// stdio protocol. Real environment variables still win over .env values.
dotenv.config({ quiet: true });

// exitCode (not process.exit) lets pending stdout/stderr writes flush first.
// SIGINT (Ctrl+C) and SIGTERM (docker stop) request a graceful shutdown: a running sync
// cycle finishes and the MCP server closes its transport, then the DB is closed below.
// Traces are exported only when an OTLP endpoint is configured (see infra/telemetry/setup.ts).
const telemetry = await initTelemetry();

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown.abort());
}

try {
  process.exitCode = await run(process.argv.slice(2), { signal: shutdown.signal });
} finally {
  closeDb();
  await telemetry.shutdown(); // flush buffered spans before the process exits
}
