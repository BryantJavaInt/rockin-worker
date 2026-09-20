// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { type Attributes, context, metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
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

/**
 * Registers a real meter provider that keeps exported metrics in memory. `collect(name)` forces
 * an export and returns the data points of one instrument, exactly as a collector would see them.
 * Like tracing, the global provider can be set once per process: install in `beforeAll`.
 */
export function installTestMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000, // never on its own: collect() flushes explicitly
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  return {
    async collect(name: string): Promise<Array<{ attributes: Attributes; value: unknown }>> {
      exporter.reset();
      await provider.forceFlush();
      return exporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === name)
        .flatMap((metric) =>
          metric.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value as unknown })),
        );
    },
    async uninstall() {
      await provider.shutdown();
      metrics.disable();
    },
  };
}
