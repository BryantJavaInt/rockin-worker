// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { getDb } from '../infra/db/connection.js';

/** Empties every table so each test starts from a known state (the DB is shared within a test file). */
export function resetDb(): void {
  getDb().exec(
    'DELETE FROM repos; DELETE FROM notion_pages; DELETE FROM sync_state; DELETE FROM embeddings;',
  );
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}
