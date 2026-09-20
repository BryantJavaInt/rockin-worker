// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { APP } from '../config/meta.js';
import { describeError } from '../core/errors.js';
import type { Tool } from '../tools/define.js';
import { TOOLS } from '../tools/registry.js';

function textResult(payload: unknown, options: { isError?: boolean; structured?: boolean } = {}) {
  return {
    // Text stays for hosts that ignore structuredContent (older clients, some UIs).
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(options.structured ? { structuredContent: payload as Record<string, unknown> } : {}),
    ...(options.isError ? { isError: true } : {}),
  };
}

/**
 * Builds the MCP server from the shared tool registry. It contains no business
 * logic of its own — it only adapts registered tools to the MCP protocol.
 * Creating it has no side effects, so it can be constructed freely in tests.
 */
export function createMcpServer(tools: readonly Tool[] = TOOLS): McpServer {
  const server = new McpServer({
    name: APP.name,
    title: 'Rockin Worker',
    version: APP.version,
    websiteUrl: APP.homepage,
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input.shape,
        ...(tool.output ? { outputSchema: tool.output.shape } : {}),
        // Tells MCP clients these tools can be auto-approved: they only read a local store.
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          return textResult(await tool.execute(args), { structured: tool.output !== undefined });
        } catch (err) {
          return textResult({ error: describeError(err) }, { isError: true });
        }
      },
    );
  }

  return server;
}

/**
 * Serves over stdio (stdout is the protocol channel — never write to it). Resolves when the
 * client disconnects or `signal` aborts (SIGINT/SIGTERM), closing the transport cleanly first.
 * `transport` is injectable so the shutdown path can be tested without a real stdin.
 */
export async function serveStdio(
  server: McpServer = createMcpServer(),
  signal?: AbortSignal,
  transport: Transport = new StdioServerTransport(),
): Promise<void> {
  if (signal?.aborted) return;

  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  signal?.addEventListener('abort', () => void server.close(), { once: true });

  await server.connect(transport);
  await closed;
}
