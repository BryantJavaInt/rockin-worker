// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { z } from 'zod';

/** One human-readable line-or-block for any thrown value; validation errors get Zod's readable form. */
export function describeError(err: unknown): string {
  if (err instanceof z.ZodError) return z.prettifyError(err);
  return err instanceof Error ? err.message : String(err);
}
