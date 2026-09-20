// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { parseArgs } from 'node:util';
import { runAgent } from '../agent/agent.js';
import { ConfigError, loadConfig, requireSecret } from '../config/index.js';
import { APP, describeApp } from '../config/meta.js';
import { parseDuration } from '../core/duration.js';
import { describeError } from '../core/errors.js';
import { indexDocuments } from '../core/search/indexer.js';
import { runEvery } from '../core/sync/watch.js';
import { getEmbeddingProvider } from '../infra/embeddings/provider.js';
import { serveHttp } from '../mcp/http.js';
import { serveStdio } from '../mcp/server.js';
import { SOURCE_NAMES, SOURCES, type SourceName } from '../sources/index.js';
import { type Tool, toInputJsonSchema } from '../tools/define.js';
import { findTool, TOOLS } from '../tools/registry.js';

const USAGE = `rockin-worker — sync data sources into SQLite and serve them to LLM agents

Usage:
  rockin-worker sync [github|notion|all] [--full] [--every 15m]
                                                    Sync sources (default: all configured).
                                                    --full re-syncs everything and prunes deletions;
                                                    --every keeps running as a worker until Ctrl+C;
                                                    --embed also refreshes the semantic index
  rockin-worker embed [github|notion|all]           Build/refresh the semantic-search index (needs VOYAGE_API_KEY)
  rockin-worker ask "<question>" [--model <id>]     Ask the Claude agent, backed by the tools
  rockin-worker tool <name> [--flag value | json]   Run one tool locally and print its JSON
  rockin-worker serve [--http] [--host h] [--port p] Start the MCP server: stdio by default, or HTTP
                                                    (needs MCP_AUTH_TOKEN; binds to 127.0.0.1 unless told otherwise)
  rockin-worker version                             Show version, author and license
  rockin-worker help

Tools: ${TOOLS.map((t) => t.name).join(', ')}
Exit codes: 0 ok · 1 runtime failure · 2 usage error

© ${APP.author} · ${APP.license} License · ${APP.homepage}`;

class UsageError extends Error {
  override name = 'UsageError';
}

const isSourceName = (value: string): value is SourceName =>
  (SOURCE_NAMES as string[]).includes(value);

const MIN_WATCH_INTERVAL_MS = 1000;

/** One pass over the selected sources. Returns the exit code for that pass. */
async function syncOnce(target: string, full: boolean): Promise<number> {
  const config = loadConfig();
  const names = target === 'all' ? SOURCE_NAMES : [target as SourceName];
  let exitCode = 0;
  let ran = 0;

  for (const name of names) {
    const source = SOURCES[name];

    if (target === 'all' && !config[source.tokenEnv]) {
      console.warn(`Skipping ${name}: ${source.tokenEnv} is not set.`);
      continue;
    }

    const summary = await source.sync(requireSecret(config, source.tokenEnv), { full });
    ran++;
    console.log(JSON.stringify(summary, null, 2));
    if (summary.errors > 0) exitCode = 1;
  }

  if (ran === 0) {
    console.error('No source is configured. Set GITHUB_TOKEN and/or NOTION_TOKEN in .env.');
    return 1;
  }
  return exitCode;
}

/** Brings the semantic index of the selected sources in line with the local store. */
async function embedOnce(target: string): Promise<number> {
  const provider = getEmbeddingProvider();
  if (!provider) {
    throw new ConfigError(
      'VOYAGE_API_KEY is not set. Semantic search needs an embeddings provider (see .env.example).',
    );
  }

  const names = target === 'all' ? SOURCE_NAMES : [target as SourceName];
  for (const name of names) {
    const summary = await indexDocuments({
      source: name,
      documents: SOURCES[name].documents(),
      provider,
    });
    console.log(JSON.stringify(summary, null, 2));
  }
  return 0;
}

async function embedCommand(args: string[]): Promise<number> {
  const target = args[0] ?? 'all';
  if (target !== 'all' && !isSourceName(target)) {
    throw new UsageError(
      `Unknown source "${target}". Expected one of: ${SOURCE_NAMES.join(', ')}, all`,
    );
  }
  return embedOnce(target);
}

async function syncCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      full: { type: 'boolean', default: false },
      every: { type: 'string' },
      embed: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const target = positionals[0] ?? 'all';
  if (target !== 'all' && !isSourceName(target)) {
    throw new UsageError(
      `Unknown source "${target}". Expected one of: ${SOURCE_NAMES.join(', ')}, all`,
    );
  }

  if (values.every === undefined) {
    const code = await syncOnce(target, values.full);
    return code === 0 && values.embed ? embedOnce(target) : code;
  }

  // Worker mode: sync on an interval until told to stop. A failing cycle is logged and the
  // worker keeps going — it should not die because GitHub had a bad minute.
  let intervalMs: number;
  try {
    intervalMs = parseDuration(values.every);
  } catch (err) {
    throw new UsageError(describeError(err));
  }
  if (intervalMs < MIN_WATCH_INTERVAL_MS) {
    throw new UsageError('--every must be at least 1s, to avoid hammering the upstream APIs.');
  }

  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  if (signal?.aborted) controller.abort();

  console.error(
    `Worker started: syncing ${target} every ${values.every}. Ctrl+C stops after the current cycle.`,
  );
  await runEvery(
    async () => {
      const code = await syncOnce(target, values.full);
      if (code !== 0)
        console.error(`Cycle finished with errors (exit ${code}); will retry next interval.`);
      // A worker keeps the semantic index fresh on its own once a provider is configured.
      if (values.embed || getEmbeddingProvider()) await embedOnce(target);
    },
    intervalMs,
    controller.signal,
    { onError: (err) => console.error(`Cycle failed: ${describeError(err)}`) },
  );
  console.error('Worker stopped.');
  return 0;
}

const MIN_TOKEN_LENGTH = 24;

async function serveCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      http: { type: 'boolean', default: false },
      host: { type: 'string' },
      port: { type: 'string' },
    },
  });

  if (!values.http) {
    if (values.host || values.port)
      throw new UsageError('--host and --port only apply with --http.');
    await serveStdio(undefined, signal);
    return 0;
  }

  const config = loadConfig();
  const token = requireSecret(config, 'MCP_AUTH_TOKEN');
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }

  const port = values.port === undefined ? config.MCP_HTTP_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port must be an integer between 0 and 65535, got "${values.port}".`);
  }

  await serveHttp(
    {
      token,
      host: values.host ?? config.MCP_HTTP_HOST,
      port,
      allowedOrigins: (config.MCP_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
    signal,
  );
  return 0;
}

async function askCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { model: { type: 'string' } },
    allowPositionals: true,
  });

  const question = positionals.join(' ').trim();
  if (!question) throw new UsageError('ask needs a question, e.g. ask "what are my top repos?"');

  const config = loadConfig();
  const result = await runAgent(question, {
    apiKey: requireSecret(config, 'ANTHROPIC_API_KEY'),
    model: values.model ?? config.ANTHROPIC_MODEL,
    tools: TOOLS,
  });

  console.log(result.answer || '(no answer)');
  const called = result.toolCalls.map((c) => c.name).join(', ') || 'none';
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = result.usage;
  const cache =
    cacheReadTokens + cacheCreationTokens > 0
      ? ` (prompt cache: ${cacheReadTokens} read / ${cacheCreationTokens} written)`
      : '';
  console.error(
    `\n— tools: ${called} · turns: ${result.turns} · ` +
      `tokens: ${inputTokens} in / ${outputTokens} out${cache} · ${result.latencyMs}ms`,
  );

  return result.stopReason === 'max_turns' ? 1 : 0;
}

/**
 * Tool arguments come either as flags (`--limit 5 --query fin`) or as a JSON object.
 * Flags exist because JSON needs shell-specific quoting: PowerShell strips the double
 * quotes, so '{"limit":5}' arrives as {limit:5} and is not valid JSON.
 * Values are coerced using the tool's own JSON Schema, and unknown flags are rejected
 * (zod would otherwise silently drop a typo like --limt).
 */
function parseToolArgs(tool: Tool, tokens: string[]): unknown {
  if (tokens.length === 0) return {};

  if (tokens[0]?.startsWith('{')) {
    const raw = tokens.join(' ');
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(
        `Arguments are not valid JSON (got: ${raw}). Use flags instead, e.g. --limit 5.`,
      );
    }
  }

  const properties = (toInputJsonSchema(tool).properties ?? {}) as Record<
    string,
    { type?: string }
  >;
  const args: Record<string, unknown> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (!token.startsWith('--')) {
      throw new UsageError(
        `Unexpected argument "${token}". Pass flags like --limit 5, or a JSON object.`,
      );
    }

    const eq = token.indexOf('=');
    const key = token.slice(2, eq === -1 ? undefined : eq);
    const raw = eq === -1 ? tokens[++i] : token.slice(eq + 1);

    if (!(key in properties)) {
      const valid =
        Object.keys(properties)
          .map((k) => `--${k}`)
          .join(', ') || '(none)';
      throw new UsageError(`Unknown flag --${key} for ${tool.name}. Valid flags: ${valid}`);
    }
    if (raw === undefined) throw new UsageError(`Flag --${key} needs a value.`);

    const type = properties[key]?.type;
    args[key] =
      type === 'number' || type === 'integer'
        ? Number(raw)
        : type === 'boolean'
          ? raw === 'true'
          : raw;
  }

  return args;
}

async function toolCommand(args: string[]): Promise<number> {
  const [name, ...tokens] = args;
  const available = TOOLS.map((t) => t.name).join(', ');
  if (!name) throw new UsageError(`tool needs a name. Available: ${available}`);

  const tool = findTool(name);
  if (!tool) throw new UsageError(`Unknown tool "${name}". Available: ${available}`);

  console.log(JSON.stringify(await tool.execute(parseToolArgs(tool, tokens)), null, 2));
  return 0;
}

/** Runs the CLI and returns the process exit code. Pure of `process.exit`, so it is testable. */
export async function run(argv: string[], deps: { signal?: AbortSignal } = {}): Promise<number> {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case 'sync':
        return await syncCommand(rest, deps.signal);
      case 'embed':
        return await embedCommand(rest);
      case 'ask':
        return await askCommand(rest);
      case 'tool':
        return await toolCommand(rest);
      case 'serve':
        return await serveCommand(rest, deps.signal);
      case 'version':
      case '--version':
      case '-v':
        console.log(describeApp());
        return 0;
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      case undefined:
        console.error(USAGE);
        return 2;
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(err instanceof ConfigError ? err.message : `Error: ${describeError(err)}`);
    return 1;
  }
}
