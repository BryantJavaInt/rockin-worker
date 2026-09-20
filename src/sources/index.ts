// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { SecretName } from '../config/index.js';
import { runSync, type SyncOptions, type SyncSummary } from '../core/sync/engine.js';
import { createGithubAdapter } from './github/adapter.js';
import { createNotionAdapter } from './notion/adapter.js';

export type SourceDefinition = {
  /** Which secret authenticates this source. */
  tokenEnv: SecretName;
  sync(token: string, options?: SyncOptions): Promise<SyncSummary>;
};

/** Registry of syncable sources. Adding a source = one adapter + one entry here. */
export const SOURCES = {
  github: {
    tokenEnv: 'GITHUB_TOKEN',
    sync: (token, options) => runSync(createGithubAdapter(token), options),
  },
  notion: {
    tokenEnv: 'NOTION_TOKEN',
    sync: (token, options) => runSync(createNotionAdapter(token), options),
  },
} as const satisfies Record<string, SourceDefinition>;

export type SourceName = keyof typeof SOURCES;

export const SOURCE_NAMES = Object.keys(SOURCES) as SourceName[];
