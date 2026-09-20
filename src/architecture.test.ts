// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Enforces the layering documented in docs/ARCHITECTURE.md. A dependency that points
// the wrong way — or a new package nobody classified — fails here, at review time,
// instead of silently eroding the structure.

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** layer → the layers it may import from (importing your own layer is always fine). */
const ALLOWED: Record<string, readonly string[]> = {
  config: [],
  infra: ['config'],
  core: ['config', 'infra'],
  sources: ['config', 'infra', 'core'],
  tools: ['config', 'infra', 'core', 'sources'],
  agent: ['config', 'infra', 'core', 'tools'],
  mcp: ['config', 'infra', 'core', 'tools'],
  evals: ['config', 'infra', 'core', 'sources', 'tools', 'agent'],
  cli: ['config', 'infra', 'core', 'sources', 'tools', 'agent', 'mcp'],
  main: ['cli', 'config', 'infra'],
  testing: ['infra'],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

const layerOf = (file: string): string => {
  const [first = '', second] = path.relative(SRC, file).split(path.sep);
  return second === undefined ? path.basename(first, '.ts') : first;
};

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((spec): spec is string => spec !== undefined)
    .map((spec) => path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
}

const files = walk(SRC);
const graph = new Map(files.map((file) => [file, importsOf(file)]));
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('architecture', () => {
  it('scans a meaningful number of files (the checks below cannot pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it('classifies every top-level package into a layer', () => {
    const layers = new Set(files.map(layerOf));

    expect([...layers].filter((layer) => !(layer in ALLOWED))).toEqual([]);
  });

  it('only imports downward along the declared layers', () => {
    const violations: string[] = [];

    for (const [file, targets] of graph) {
      const from = layerOf(file);
      for (const target of targets) {
        const to = layerOf(target);
        if (to !== from && !ALLOWED[from]?.includes(to)) {
          violations.push(`${rel(file)} (${from}) must not import ${rel(target)} (${to})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps data sources isolated from each other', () => {
    const violations: string[] = [];
    const sourceOf = (file: string) =>
      path.relative(path.join(SRC, 'sources'), file).split(path.sep);

    for (const [file, targets] of graph) {
      if (layerOf(file) !== 'sources') continue;
      const [ownPackage, ownFile] = sourceOf(file);
      // sources/index.ts is the registry and legitimately knows every source.
      if (ownFile === undefined) continue;

      for (const target of targets) {
        if (layerOf(target) !== 'sources') continue;
        const [targetPackage, targetFile] = sourceOf(target);
        if (targetFile !== undefined && targetPackage !== ownPackage) {
          violations.push(`${rel(file)} must not import ${rel(target)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('loads .env only at the entry points, so tests and libraries never read real credentials', () => {
    const importsDotenv = files
      .filter((file) =>
        /from\s+['"]dotenv(\/config)?['"]|import\s+['"]dotenv/.test(readFileSync(file, 'utf8')),
      )
      .map(rel)
      .sort();

    expect(importsDotenv).toEqual(['evals/run.ts', 'main.ts']);
  });

  it('has no import cycles', () => {
    const cycles: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();

    const visit = (file: string, trail: string[]): void => {
      if (state.get(file) === 'done') return;
      if (state.get(file) === 'visiting') {
        cycles.push([...trail.slice(trail.indexOf(file)), file].map(rel).join(' -> '));
        return;
      }
      state.set(file, 'visiting');
      for (const target of graph.get(file) ?? []) visit(target, [...trail, file]);
      state.set(file, 'done');
    };

    for (const file of graph.keys()) visit(file, []);

    expect(cycles).toEqual([]);
  });
});
