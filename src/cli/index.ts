// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { parseArgs } from 'node:util';
import { runAgent } from '../agent/agent.js';
import { ConfigError, loadConfig, requireSecret } from '../config/index.js';
import { APP, describeApp } from '../config/meta.js';
import { describeError } from '../core/errors.js';
import { serveStdio } from '../mcp/server.js';
import { SOURCE_NAMES, SOURCES, type SourceName } from '../sources/index.js';
import { type Tool, toInputJsonSchema } from '../tools/define.js';
import { findTool, TOOLS } from '../tools/registry.js';

const USAGE = `rockin-worker — sync data sources into SQLite and serve them to LLM agents

Usage:
  rockin-worker sync [github|notion|all] [--full]   Sync sources (default: all configured; --full also prunes deletions)
  rockin-worker ask "<question>" [--model <id>]     Ask the Claude agent, backed by the tools
  rockin-worker tool <name> [--flag value | json]   Run one tool locally and print its JSON
  rockin-worker serve                               Start the MCP server on stdio
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

async function syncCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { full: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const target = positionals[0] ?? 'all';
  if (target !== 'all' && !isSourceName(target)) {
    throw new UsageError(
      `Unknown source "${target}". Expected one of: ${SOURCE_NAMES.join(', ')}, all`,
    );
  }

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

    const summary = await source.sync(requireSecret(config, source.tokenEnv), {
      full: values.full,
    });
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
  console.error(
    `\n— tools: ${called} · turns: ${result.turns} · ` +
      `tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out · ${result.latencyMs}ms`,
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

function toolCommand(args: string[]): number {
  const [name, ...tokens] = args;
  const available = TOOLS.map((t) => t.name).join(', ');
  if (!name) throw new UsageError(`tool needs a name. Available: ${available}`);

  const tool = findTool(name);
  if (!tool) throw new UsageError(`Unknown tool "${name}". Available: ${available}`);

  console.log(JSON.stringify(tool.execute(parseToolArgs(tool, tokens)), null, 2));
  return 0;
}

/** Runs the CLI and returns the process exit code. Pure of `process.exit`, so it is testable. */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case 'sync':
        return await syncCommand(rest);
      case 'ask':
        return await askCommand(rest);
      case 'tool':
        return toolCommand(rest);
      case 'serve':
        await serveStdio();
        return 0;
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
