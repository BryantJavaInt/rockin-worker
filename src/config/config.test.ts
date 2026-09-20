// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, requireSecret } from './index.js';

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const config = loadConfig({});

    expect(config.DB_PATH).toBe('./data.db');
    expect(config.LOG_DIR).toBe('./logs');
    expect(config.SYNC_MAX_PAGES).toBe(5);
    expect(config.GITHUB_TOKEN).toBeUndefined();
  });

  it('treats blank values (as copied from .env.example) as unset', () => {
    const config = loadConfig({ NOTION_TOKEN: '', GITHUB_TOKEN: '   ', DB_PATH: '' });

    expect(config.NOTION_TOKEN).toBeUndefined();
    expect(config.GITHUB_TOKEN).toBeUndefined();
    expect(config.DB_PATH).toBe('./data.db');
  });

  it('coerces numeric settings from strings', () => {
    expect(loadConfig({ SYNC_MAX_PAGES: '12' }).SYNC_MAX_PAGES).toBe(12);
  });

  it('rejects invalid values with a readable ConfigError', () => {
    expect(() => loadConfig({ SYNC_MAX_PAGES: 'lots' })).toThrow(ConfigError);
    expect(() => loadConfig({ SYNC_MAX_PAGES: '0' })).toThrow(/SYNC_MAX_PAGES/);
  });
});

describe('requireSecret', () => {
  it('returns a configured secret', () => {
    expect(requireSecret(loadConfig({ GITHUB_TOKEN: 'abc' }), 'GITHUB_TOKEN')).toBe('abc');
  });

  it('throws a ConfigError naming the missing secret', () => {
    expect(() => requireSecret(loadConfig({}), 'NOTION_TOKEN')).toThrow(/NOTION_TOKEN/);
  });
});
