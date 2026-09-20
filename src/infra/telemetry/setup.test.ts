// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { context, metrics, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { startCollector } from '../../testing/collector.js';
import { initTelemetry, metricExportIntervalMs, otlpConfig, parseOtlpHeaders } from './setup.js';
import { traced } from './tracing.js';

afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

describe('initTelemetry', () => {
  it('is off, and loads nothing, without an endpoint', async () => {
    const handle = await initTelemetry({});

    expect(handle.enabled).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('OTEL_SDK_DISABLED=true wins even when an endpoint is configured', async () => {
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_SDK_DISABLED: 'true',
    });

    expect(handle.enabled).toBe(false);
  });

  it('exports real spans over OTLP/HTTP to the configured collector on shutdown', async () => {
    const collector = await startCollector();
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_SERVICE_NAME: 'export-test',
    });

    traced('exported-operation', { 'job.kind': 'integration' }, () => 'done');
    await handle.shutdown(); // flushes the batch
    await collector.stop();

    expect(handle.enabled).toBe(true);
    expect(collector.received).toHaveLength(1);
    const [request] = collector.received;
    expect(request?.path).toBe('/v1/traces');
    expect(request?.contentType).toMatch(/json/);
    expect(request?.body).toContain('exported-operation');
    expect(request?.body).toContain('export-test'); // service.name from the standard variable
    expect(request?.body).toContain('integration');
  });

  it('an unreachable collector never throws into the program', async () => {
    const handle = await initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });

    traced('lost', {}, () => 1);

    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe('OTLP configuration', () => {
  it('appends /v1/traces to the general endpoint but uses a traces endpoint as-is', () => {
    expect(
      otlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' }, 'traces')?.url,
    ).toBe('http://collector:4318/v1/traces');
    expect(
      otlpConfig(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://ignored:4318',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/custom/path',
        },
        'traces',
      )?.url,
    ).toBe('https://traces.example.com/custom/path');
  });

  it('derives the metrics endpoint the same way, and reports none when nothing is configured', () => {
    expect(otlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }, 'metrics')?.url).toBe(
      'http://c:4318/v1/metrics',
    );
    expect(
      otlpConfig({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://m.example.com/x' }, 'metrics')
        ?.url,
    ).toBe('https://m.example.com/x');
    // A traces-only endpoint must not turn metrics on.
    expect(otlpConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t' }, 'metrics')).toBeNull();
    expect(otlpConfig({}, 'traces')).toBeNull();
  });

  it('reads the metric export interval, falling back to the 60 s default', () => {
    expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: '5000' })).toBe(5000);
    expect(metricExportIntervalMs({})).toBe(60_000);
    expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: 'soon' })).toBe(60_000);
    expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: '5' })).toBe(60_000);
  });

  it('parses the standard header list, keeping "=" inside values and decoding escapes', () => {
    expect(
      parseOtlpHeaders('authorization=Bearer abc==,x-team=data%20platform, =nokey,bad'),
    ).toEqual({
      authorization: 'Bearer abc==',
      'x-team': 'data platform',
    });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });

  it('prefers the traces-specific headers', () => {
    expect(
      otlpConfig(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
          OTEL_EXPORTER_OTLP_HEADERS: 'a=general',
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'a=traces',
        },
        'traces',
      )?.headers,
    ).toEqual({ a: 'traces' });
  });

  it('sends configured headers to the collector', async () => {
    const collector = await startCollector();
    const handle = await initTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=secret-123',
    });

    traced('with-headers', {}, () => 1);
    await handle.shutdown();
    await collector.stop();

    expect(collector.received[0]?.body).toContain('with-headers');
    expect(collector.headers[0]?.['x-api-key']).toBe('secret-123');
  });
});
