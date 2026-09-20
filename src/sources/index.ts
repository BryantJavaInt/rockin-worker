// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { loadConfig, type SecretName } from '../config/index.js';
import type { Document } from '../core/search/indexer.js';
import { runSync, type SyncOptions, type SyncSummary } from '../core/sync/engine.js';
import { createGithubAdapter } from './github/adapter.js';
import { listRepoDocuments } from './github/documents.js';
import { createNotionAdapter } from './notion/adapter.js';
import { listPageDocuments } from './notion/documents.js';

export type SourceDefinition = {
  /** Which secret authenticates this source. */
  tokenEnv: SecretName;
  sync(token: string, options?: SyncOptions): Promise<SyncSummary>;
  /** What semantic search embeds for this source, read from the local store (no upstream call). */
  documents(): Document[];
};

/** Registry of syncable sources. Adding a source = one adapter + one entry here. */
export const SOURCES = {
  github: {
    tokenEnv: 'GITHUB_TOKEN',
    sync: (token, options) => runSync(createGithubAdapter(token), options),
    documents: listRepoDocuments,
  },
  notion: {
    tokenEnv: 'NOTION_TOKEN',
    sync: (token, options) =>
      runSync(
        createNotionAdapter(token, undefined, { syncContent: loadConfig().NOTION_SYNC_CONTENT }),
        options,
      ),
    documents: listPageDocuments,
  },
} as const satisfies Record<string, SourceDefinition>;

export type SourceName = keyof typeof SOURCES;

export const SOURCE_NAMES = Object.keys(SOURCES) as SourceName[];
