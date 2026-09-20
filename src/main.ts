#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import dotenv from 'dotenv';
import { run } from './cli/index.js';
import { closeDb } from './infra/db/connection.js';

// quiet: dotenv v17 logs to stdout by default, which would corrupt the MCP
// stdio protocol. Real environment variables still win over .env values.
dotenv.config({ quiet: true });

// exitCode (not process.exit) lets pending stdout/stderr writes flush first.
// SIGINT (Ctrl+C) and SIGTERM (docker stop) request a graceful shutdown: a running sync
// cycle finishes and the MCP server closes its transport, then the DB is closed below.
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown.abort());
}

process.exitCode = await run(process.argv.slice(2), { signal: shutdown.signal });
closeDb();
