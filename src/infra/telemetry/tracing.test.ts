// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installTestTracing, parentIdOf } from '../../testing/telemetry.js';
import { markError, traced } from './tracing.js';

const tracing = installTestTracing();
beforeAll(() => tracing.reset());
afterAll(() => tracing.uninstall());
beforeEach(() => tracing.reset());

describe('traced', () => {
  it('records a finished span with the given attributes and returns the value', () => {
    const value = traced('work', { 'job.id': 7 }, () => 42);

    expect(value).toBe(42);
    const [span] = tracing.named('work');
    expect(span?.attributes).toMatchObject({ 'job.id': 7 });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('keeps a synchronous function synchronous, and a synchronous throw a synchronous throw', () => {
    expect(traced('sync', {}, () => 'plain')).toBe('plain'); // not a Promise
    expect(() =>
      traced('boom', {}, () => {
        throw new Error('sync failure');
      }),
    ).toThrow('sync failure');

    const [span] = tracing.named('boom');
    expect(span?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'sync failure' });
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('awaits a promise, ends the span afterwards, and passes the result through', async () => {
    const value = await traced('async', {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'later';
    });

    expect(value).toBe('later');
    expect(tracing.named('async')).toHaveLength(1);
    expect(tracing.named('async')[0]?.endTime).not.toEqual([0, 0]);
  });

  it('records a rejected promise as an error and re-rejects with the same error', async () => {
    const original = new Error('async failure');

    await expect(traced('reject', {}, async () => Promise.reject(original))).rejects.toBe(original);

    expect(tracing.named('reject')[0]?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'async failure',
    });
  });

  it('wraps non-Error throwables', () => {
    expect(() =>
      traced('string', {}, () => {
        throw 'just a string';
      }),
    ).toThrow();

    expect(tracing.named('string')[0]?.status.message).toBe('just a string');
  });

  it('nests: a span started inside another becomes its child, across awaits', async () => {
    await traced('outer', {}, async () => {
      await Promise.resolve();
      await traced('inner', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    });

    const outer = tracing.named('outer')[0];
    const inner = tracing.named('inner')[0];
    expect(parentIdOf(inner as never)).toBe(outer?.spanContext().spanId);
  });

  it('markError flags a span without throwing', () => {
    traced('handled', {}, (span) => markError(span, 'handled failure'));

    expect(tracing.named('handled')[0]?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'handled failure',
    });
  });
});
