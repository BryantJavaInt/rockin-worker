// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';

const EnvSchema = z.object({
  DB_PATH: z.string().default('./data.db'),
  LOG_DIR: z.string().default('./logs'),
  SYNC_MAX_PAGES: z.coerce.number().int().positive().default(5),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  GITHUB_TOKEN: z.string().optional(),
  NOTION_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;
export type SecretName = 'GITHUB_TOKEN' | 'NOTION_TOKEN' | 'ANTHROPIC_API_KEY';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses and validates the environment once, at the edge, so the rest of the
 * code works with typed values instead of raw `process.env` strings.
 *
 * Blank values (`NOTION_TOKEN=` copied from .env.example) are treated as unset,
 * otherwise an empty string would silently count as a configured secret.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = EnvSchema.safeParse(present);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }

  return parsed.data;
}

/** Secrets are optional at load time (each command needs a different one) and required at point of use. */
export function requireSecret(config: Config, name: SecretName): string {
  const value = config[name];
  if (!value) {
    throw new ConfigError(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
