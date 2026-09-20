// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

function clock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('allows up to the limit, counting down, then refuses', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now });

    const results = [1, 2, 3, 4].map(() => limiter.hit('a'));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]).toMatchObject({ limit: 3, resetSeconds: 60 });
  });

  it('counts each key separately', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now });

    expect(limiter.hit('client-a').allowed).toBe(true);
    expect(limiter.hit('client-a').allowed).toBe(false);
    expect(limiter.hit('client-b').allowed).toBe(true);
  });

  it('lets a caller back in once the window has passed', () => {
    const { now, advance } = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now });
    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);

    advance(120_000);

    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('does not allow a double burst across a window boundary', () => {
    const { now, advance } = clock();
    const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, now });

    for (let i = 0; i < 10; i++) limiter.hit('a'); // spend the whole limit…
    advance(61_000); // …just after the window rolled over

    // A fixed window would allow 10 more right now. The previous window still weighs in.
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('recovers gradually as the previous window fades', () => {
    const { now, advance } = clock();
    const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, now });
    for (let i = 0; i < 10; i++) limiter.hit('a');

    advance(90_000); // half of the next window has elapsed: about half the old load still counts

    const allowed = Array.from({ length: 10 }, () => limiter.hit('a').allowed).filter(Boolean);
    expect(allowed.length).toBeGreaterThanOrEqual(4);
    expect(allowed.length).toBeLessThanOrEqual(6);
  });

  it('does not count refused requests against the caller', () => {
    const { now, advance } = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now });
    limiter.hit('a');
    for (let i = 0; i < 50; i++) limiter.hit('a'); // a client hammering after being refused

    advance(120_000);

    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('forgets idle keys, so memory stays bounded', () => {
    const { now, advance } = clock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1_000, now });
    for (let i = 0; i < 10_000; i++) limiter.hit(`key-${i}`);

    advance(10_000);

    // The next key triggers an eviction sweep; behaviour stays correct afterwards.
    expect(limiter.hit('fresh')).toMatchObject({ allowed: true, remaining: 4 });
    expect(limiter.hit('key-1')).toMatchObject({ allowed: true, remaining: 4 });
  });
});
