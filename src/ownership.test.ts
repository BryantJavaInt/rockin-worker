// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Authorship must travel with the code. LICENSE is the single source of truth for who
// owns the project; this test fails when any file, manifest or metadata drifts from it,
// so a copied file or a forgotten header can't quietly lose its attribution.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

const licenseMatch = read('LICENSE').match(/^Copyright \(c\) (\d{4}(?:-\d{4})?) (.+)$/m);
const [, YEAR = '', HOLDER = ''] = licenseMatch ?? [];
const [GIVEN = '', ...rest] = HOLDER.split(' ');
const FAMILY = rest.join(' ');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.m?ts$/.test(name) ? [full] : [];
  });
}

describe('ownership', () => {
  it('LICENSE names a copyright holder and year', () => {
    expect(licenseMatch).not.toBeNull();
    expect(HOLDER.length).toBeGreaterThan(2);
    expect(read('LICENSE')).toMatch(/^MIT License/);
  });

  it('every source file carries the SPDX identifier and the copyright line', () => {
    const files = [...sourceFiles(path.join(ROOT, 'src')), path.join(ROOT, 'vitest.config.mts')];
    const expected = ['// SPDX-License-Identifier: MIT', `// Copyright (c) ${YEAR} ${HOLDER}`];
    const missing: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const start = lines[0]?.startsWith('#!') ? 1 : 0; // a shebang must stay on line 1
      if (lines[start] !== expected[0] || lines[start + 1] !== expected[1]) {
        missing.push(path.relative(ROOT, file));
      }
    }

    expect(files.length).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it('package.json declares the same author and license', () => {
    const pkg = JSON.parse(read('package.json'));

    expect(pkg.author.name).toBe(HOLDER);
    expect(pkg.author.url).toMatch(/^https:\/\/github\.com\//);
    expect(pkg.license).toBe('MIT');
    expect(pkg.homepage).toContain(pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1]);
    expect(pkg.files).toContain('LICENSE');
  });

  it('CITATION.cff, CODEOWNERS, the Docker image and the README all name the owner', () => {
    const citation = read('CITATION.cff');
    expect(citation).toContain(`family-names: ${FAMILY}`);
    expect(citation).toContain(`given-names: ${GIVEN}`);
    expect(citation).toMatch(/license: MIT/);

    expect(existsSync(path.join(ROOT, '.github/CODEOWNERS'))).toBe(true);
    expect(read('.github/CODEOWNERS')).toMatch(/^\* @\S+/m);

    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(`org.opencontainers.image.authors="${HOLDER}"`);
    expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');

    expect(read('README.md')).toContain(`© ${YEAR} ${HOLDER}`);
  });
});
