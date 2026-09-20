// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { createGithubAdapter } from './adapter.js';

const base = { id: 1, name: 'repo-1', stargazers_count: 10, updated_at: '2026-03-02T00:00:00Z' };

describe('github adapter metadata', () => {
  it('keeps description, language, topics and the repo URL', () => {
    const parsed = createGithubAdapter('t').parse({
      ...base,
      description: 'A tool',
      language: 'Rust',
      topics: ['cli', 'sync'],
      html_url: 'https://github.com/x/repo-1',
    });

    expect(parsed?.value).toMatchObject({
      description: 'A tool',
      language: 'Rust',
      topics: ['cli', 'sync'],
      url: 'https://github.com/x/repo-1',
    });
  });

  it('tolerates their absence (null or missing)', () => {
    const adapter = createGithubAdapter('t');

    expect(adapter.parse({ ...base, description: null, language: null })?.value).toMatchObject({
      description: null,
      language: null,
      topics: [],
      url: null,
    });
    expect(adapter.parse(base)?.value).toMatchObject({ description: null, topics: [] });
  });
});
