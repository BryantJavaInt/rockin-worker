// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import type { Tool } from './define.js';
import { githubTools } from './github.js';
import { notionTools } from './notion.js';

/** Every tool the project exposes. The single list the MCP server, agent and evals all read. */
export const TOOLS: readonly Tool[] = [...githubTools, ...notionTools];

export function findTool(name: string, tools: readonly Tool[] = TOOLS): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}
