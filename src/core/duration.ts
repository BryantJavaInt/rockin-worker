// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Parses a human duration such as "500ms", "30s", "15m", "2h" or "1d" into milliseconds.
 * The unit is mandatory: a bare "15" is ambiguous and is rejected rather than guessed.
 */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  if (!match) {
    throw new Error(`Invalid duration "${text}". Use a number and a unit, e.g. 30s, 15m, 2h, 1d.`);
  }

  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (ms <= 0) throw new Error(`Duration must be greater than zero, got "${text}".`);
  return ms;
}
