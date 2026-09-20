// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { type Attributes, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { APP } from '../../config/meta.js';
import { describeError } from '../errors.js';

/**
 * Instrumentation uses only `@opentelemetry/api`. Like any library, this project records spans
 * against a *global* tracer that is a no-op until an application registers an SDK — so without
 * telemetry configured it costs nothing, and with it the same code emits real traces
 * (see setup.ts). The tracer is fetched per call, so a provider registered later is picked up.
 */
const tracer = () => trace.getTracer(APP.name, APP.version);

export type TraceOptions = { kind?: SpanKind };

/**
 * Runs `fn` inside a new active span (so any span started inside becomes its child), ends the
 * span when `fn` finishes, and records a thrown or rejected error on it.
 *
 * It preserves what it wraps: a synchronous `fn` stays synchronous (and a synchronous throw stays
 * a synchronous throw), a promise-returning `fn` stays a promise. Wrapping a call therefore never
 * changes its behaviour — only makes it observable.
 */
export function traced<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T,
  options: TraceOptions = {},
): T {
  return tracer().startActiveSpan(
    name,
    { attributes, kind: options.kind ?? SpanKind.INTERNAL },
    (span): T => {
      const fail = (err: unknown): never => {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: describeError(err) });
        span.end();
        throw err;
      };

      try {
        const result = fn(span);
        if (result instanceof Promise) {
          return result.then((value) => {
            span.end();
            return value;
          }, fail) as T;
        }
        span.end();
        return result;
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** Marks a span as failed without throwing — for outcomes the code handles (e.g. a sync run with errors). */
export function markError(span: Span, message: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export { SpanKind };
