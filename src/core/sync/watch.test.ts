// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEvery } from './watch.js';

afterEach(() => vi.useRealTimers());

describe('runEvery', () => {
  it('runs immediately, then once per interval, and stops on abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const task = vi.fn(async () => {});

    const done = runEvery(task, 1_000, controller.signal, { jitterRatio: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);

    controller.abort();
    await done;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('adds jitter to the wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const task = vi.fn(async () => {});

    const done = runEvery(task, 1_000, controller.signal, { jitterRatio: 0.5, random: () => 1 });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(task).toHaveBeenCalledTimes(2);

    controller.abort();
    await done;
  });

  it('keeps going after a failed cycle and reports the error', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onError = vi.fn();
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('cycle failed'))
      .mockResolvedValue(undefined);

    const done = runEvery(task, 1_000, controller.signal, { jitterRatio: 0, onError });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(task).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'cycle failed' }));

    controller.abort();
    await done;
  });

  it('lets the cycle in flight finish before returning (graceful shutdown)', async () => {
    const controller = new AbortController();
    let finished = false;
    const task = async () => {
      controller.abort(); // shutdown requested mid-cycle
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    };

    await runEvery(task, 60_000, controller.signal);

    expect(finished).toBe(true);
  });

  it('never starts a cycle if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const task = vi.fn(async () => {});

    await runEvery(task, 1_000, controller.signal);

    expect(task).not.toHaveBeenCalled();
  });
});
