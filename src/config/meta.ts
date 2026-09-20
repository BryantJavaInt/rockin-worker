// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createRequire } from 'node:module';

type PackageJson = {
  name: string;
  version: string;
  license: string;
  homepage: string;
  author: { name: string; url: string };
};

// package.json is the single source of truth for name, version and authorship.
// It sits two directories above both src/config and dist/config, so one relative
// path works for tsx, vitest and the compiled build alike.
const pkg = createRequire(import.meta.url)('../../package.json') as PackageJson;

export const APP = {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  homepage: pkg.homepage,
  author: pkg.author.name,
  authorUrl: pkg.author.url,
} as const;

/** What `--version` prints: identity, version and who owns the project. */
export function describeApp(): string {
  return [
    `${APP.name} ${APP.version}`,
    `By ${APP.author} (${APP.authorUrl}) · ${APP.license} License`,
    APP.homepage,
  ].join('\n');
}
