// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { context, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { initTelemetry, otlpTraceConfig, parseOtlpHeaders } from './setup.js';
import { traced } from './tracing.js';

type Received = { path: string; contentType: string; body: string };

/** A tiny OTLP/HTTP collector: records whatever an exporter posts to it. */
async function startCollector() {
  const received: Received[] = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      headers.push(req.headers);
      received.push({
        path: req.url ?? '',
        contentType: String(req.headers['content-type']),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    received,
    headers,
    endpoint: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => {
  trace.disable();
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
    expect(otlpTraceConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' }).url).toBe(
      'http://collector:4318/v1/traces',
    );
    expect(
      otlpTraceConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://ignored:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/custom/path',
      }).url,
    ).toBe('https://traces.example.com/custom/path');
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
      otlpTraceConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_HEADERS: 'a=general',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'a=traces',
      }).headers,
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
