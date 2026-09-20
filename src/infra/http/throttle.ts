// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

/**
 * Spaces calls at least `minIntervalMs` apart. Call the returned function before each request:
 * it resolves immediately for the first one and afterwards waits just long enough.
 *
 * This is client-side politeness, not error handling: Notion allows ~3 requests per second per
 * integration, and reading page bodies needs several requests per page. Pacing ourselves avoids
 * a stream of 429s that the retry logic would otherwise have to absorb.
 *
 * Reservations are made synchronously, so concurrent callers queue up in order instead of all
 * observing the same "last call" time.
 */
export function createThrottle(
  minIntervalMs: number,
  clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): () => Promise<void> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let nextSlot = 0;

  return async () => {
    const current = now();
    const slot = Math.max(current, nextSlot);
    nextSlot = slot + minIntervalMs;

    if (slot > current) await sleep(slot - current);
  };
}
