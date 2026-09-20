// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';

/**
 * A Tool is defined exactly once. The MCP server, the agent loop and the evals
 * all consume this same object, so the name, description and input schema the
 * model sees can never drift between them.
 *
 * This file is the framework only — it knows nothing about any data source.
 */
export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodObject;
  /** Shape of what `execute` returns. Lets MCP clients receive typed `structuredContent`. */
  readonly output?: z.ZodObject;
  /** Validates untrusted (LLM-produced) arguments against `input`, then runs the tool. */
  execute(args: unknown): unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  output?: z.ZodObject;
  run: (args: z.infer<S>) => unknown | Promise<unknown>;
}): Tool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    input: def.input,
    output: def.output,
    execute: (args) => def.run(def.input.parse(args ?? {})),
  };
}

/** JSON Schema for the model's tool definition, derived from the same Zod schema that validates calls. */
export function toInputJsonSchema(tool: Tool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return schema;
}
