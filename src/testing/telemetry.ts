// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * Registers a real tracer provider that keeps finished spans in memory. `provider.register()`
 * also installs the async context manager, so parent/child relationships across `await` are
 * exactly what a production exporter would see. Global OpenTelemetry state can only be set once
 * per process; Vitest isolates each test file, so install in `beforeAll` and `uninstall` after.
 */
export function installTestTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();

  const spans = () => exporter.getFinishedSpans();
  const named = (name: string | RegExp) =>
    spans().filter((s) => (typeof name === 'string' ? s.name === name : name.test(s.name)));

  return {
    spans,
    named,
    reset: () => exporter.reset(),
    async uninstall() {
      await provider.shutdown();
      trace.disable();
      context.disable();
    },
  };
}

export const parentIdOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;
export const childrenOf = (parent: ReadableSpan, all: ReadableSpan[]) =>
  all.filter((s) => parentIdOf(s) === parent.spanContext().spanId);
