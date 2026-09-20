// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

export type RateDecision = {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window (0 when refused). */
  remaining: number;
  /** Seconds until a refused caller may try again, or until the window fully resets. */
  resetSeconds: number;
};

export type RateLimiter = { hit(key: string): RateDecision };

const MAX_TRACKED_KEYS = 10_000;

/**
 * A sliding-window-counter limiter: `limit` requests per `windowMs` for each key.
 *
 * A plain fixed window lets a caller spend the limit at the end of one window and again at the
 * start of the next — twice the intended rate in a moment. This counts the previous window in
 * proportion to how much of it still overlaps the last `windowMs`, which removes that burst with
 * two integers of state per key.
 *
 * The state is in memory and per process: with several instances each enforces the limit on its
 * own. That is the right size for a single-node server; a shared store would be the next step.
 * Refused requests are not counted, so a caller that keeps retrying is not locked out for longer.
 */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const { limit, windowMs, now = Date.now } = options;
  const windows = new Map<string, { start: number; current: number; previous: number }>();

  function evictStale(at: number): void {
    // Entries idle for two windows carry no information; dropping them bounds memory.
    for (const [key, entry] of windows) {
      if (at - entry.start >= 2 * windowMs) windows.delete(key);
    }
  }

  return {
    hit(key) {
      const at = now();
      if (windows.size >= MAX_TRACKED_KEYS) evictStale(at);

      let entry = windows.get(key);
      if (!entry) {
        entry = { start: at, current: 0, previous: 0 };
        windows.set(key, entry);
      }

      const elapsed = at - entry.start;
      if (elapsed >= 2 * windowMs) {
        entry.previous = 0;
        entry.current = 0;
        entry.start = at;
      } else if (elapsed >= windowMs) {
        entry.previous = entry.current;
        entry.current = 0;
        entry.start += windowMs;
      }

      const overlap = 1 - (at - entry.start) / windowMs;
      const used = entry.previous * overlap + entry.current;
      const resetSeconds = Math.max(1, Math.ceil((entry.start + windowMs - at) / 1000));

      if (used + 1 > limit) {
        return { allowed: false, limit, remaining: 0, resetSeconds };
      }

      entry.current++;
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, Math.floor(limit - used - 1)),
        resetSeconds,
      };
    },
  };
}
