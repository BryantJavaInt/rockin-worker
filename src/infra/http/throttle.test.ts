// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { createThrottle } from './throttle.js';

function fakeClock() {
  let time = 1_000;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms: number) => {
      time += ms;
    },
    clock: {
      now: () => time,
      sleep: async (ms: number) => {
        slept.push(ms);
        // Time passes only once the sleeper actually resumes, like a real timer — so callers that
        // reserve slots in the same tick all observe the same "now".
        await Promise.resolve();
        time += ms;
      },
    },
  };
}

describe('createThrottle', () => {
  it('lets the first call through immediately, then spaces the following ones', async () => {
    const { clock, slept } = fakeClock();
    const throttle = createThrottle(350, clock);

    await throttle();
    await throttle();
    await throttle();

    expect(slept).toEqual([350, 350]);
  });

  it('does not wait when the caller was already slower than the interval', async () => {
    const { clock, slept, advance } = fakeClock();
    const throttle = createThrottle(350, clock);

    await throttle();
    advance(1_000);
    await throttle();

    expect(slept).toEqual([]);
  });

  it('a zero interval never waits (used in tests and for unthrottled sources)', async () => {
    const { clock, slept } = fakeClock();
    const throttle = createThrottle(0, clock);

    await Promise.all([throttle(), throttle(), throttle()]);

    expect(slept).toEqual([]);
  });

  it('queues concurrent callers in order instead of letting them all fire together', async () => {
    const { clock, slept } = fakeClock();
    const throttle = createThrottle(100, clock);

    await Promise.all([throttle(), throttle(), throttle()]);

    expect(slept).toEqual([100, 200]); // 2nd waits 100ms, 3rd waits 200ms from now
  });
});
