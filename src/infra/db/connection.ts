// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../config/index.js';
import { migrate } from './migrations.js';

// One shared connection, re-opened only if DB_PATH changes (which is how tests
// swap in an isolated database without any mocking).
let instance: DatabaseSync | null = null;
let instancePath: string | null = null;

export function getDb(): DatabaseSync {
  const { DB_PATH } = loadConfig();

  if (instance && instancePath === DB_PATH) return instance;

  closeDb();
  const db = new DatabaseSync(DB_PATH);
  // WAL: readers (the MCP server) never block the writer (a running sync).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);

  instance = db;
  instancePath = DB_PATH;
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
  instancePath = null;
}

/**
 * Runs `fn` atomically: all writes commit together or none do.
 * `fn` must be synchronous — awaiting inside a transaction would hold the
 * write lock across network I/O. Not re-entrant (SQLite has no nested BEGIN).
 */
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
