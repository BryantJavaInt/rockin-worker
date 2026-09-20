// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { context, metrics, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { startCollector } from '../../testing/collector.js';
import { recordMcpRequest } from './metrics.js';
import { initTelemetry } from './setup.js';
import { traced } from './tracing.js';

afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

const pathsOf = (collector: Awaited<ReturnType<typeof startCollector>>) =>
  collector.received.map((r) => r.path).sort();

describe('OTLP metrics export', () => {
  it('exports recorded metrics to /v1/metrics when the collector is configured', async () => {
    const collector = await startCollector();
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_SERVICE_NAME: 'metrics-test',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=secret-123',
    });

    recordMcpRequest('unauthorized');
    await handle.shutdown(); // performs the final collection and export
    await collector.stop();

    const request = collector.received.find((r) => r.path === '/v1/metrics');
    expect(request?.contentType).toMatch(/json/);
    expect(request?.body).toContain('rockin.mcp.requests');
    expect(request?.body).toContain('unauthorized');
    expect(request?.body).toContain('metrics-test');
    expect(collector.headers.every((h) => h['x-api-key'] === 'secret-123')).toBe(true);
  });

  it('exports only metrics when only a metrics endpoint is set', async () => {
    const collector = await startCollector();
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${collector.endpoint}/v1/metrics`,
    });

    recordMcpRequest('ok');
    traced('not-exported', {}, () => 1);
    await handle.shutdown();
    await collector.stop();

    expect(pathsOf(collector)).toEqual(['/v1/metrics']);
  });

  it('OTEL_METRICS_EXPORTER=none keeps traces but drops metrics', async () => {
    const collector = await startCollector();
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_METRICS_EXPORTER: 'none',
    });

    recordMcpRequest('ok');
    traced('exported', {}, () => 1);
    await handle.shutdown();
    await collector.stop();

    expect(pathsOf(collector)).toEqual(['/v1/traces']);
  });

  it('OTEL_TRACES_EXPORTER=none keeps metrics but drops traces', async () => {
    const collector = await startCollector();
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_TRACES_EXPORTER: 'none',
    });

    recordMcpRequest('ok');
    traced('not-exported', {}, () => 1);
    await handle.shutdown();
    await collector.stop();

    expect(pathsOf(collector)).toEqual(['/v1/metrics']);
  });

  it('is disabled when both signals are switched off', async () => {
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
    });

    expect(handle.enabled).toBe(false);
  });

  it('an unreachable collector never throws into the program', async () => {
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:9/v1/metrics',
    });

    recordMcpRequest('ok');

    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
