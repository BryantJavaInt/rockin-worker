// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

/** The command line was used wrongly (exit code 2, with the usage text), as opposed to failing at runtime. */
export class UsageError extends Error {
  override name = 'UsageError';
}
