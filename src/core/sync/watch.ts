// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

export type RunEveryOptions = {
  /** Random extra delay, as a fraction of the interval, so several workers don't fire in lockstep. */
  jitterRatio?: number;
  random?: () => number;
  /** Called when a cycle throws. The loop keeps going: one bad cycle must not kill a worker. */
  onError?: (err: unknown) => void;
};

/** Sleeps for `ms`, but wakes immediately when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();

    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Runs `task` now and then every `intervalMs` (plus jitter) until `signal` aborts.
 * Cycles never overlap — the next wait starts after the previous cycle finishes — and an
 * abort lets the cycle in flight complete, then returns. That is a graceful shutdown.
 */
export async function runEvery(
  task: () => Promise<void>,
  intervalMs: number,
  signal: AbortSignal,
  options: RunEveryOptions = {},
): Promise<void> {
  const { jitterRatio = 0.1, random = Math.random, onError } = options;

  while (!signal.aborted) {
    try {
      await task();
    } catch (err) {
      onError?.(err);
    }
    if (signal.aborted) break;
    await abortableSleep(intervalMs * (1 + jitterRatio * random()), signal);
  }
}
