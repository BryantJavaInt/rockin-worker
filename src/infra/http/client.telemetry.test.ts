// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestTracing } from '../../testing/telemetry.js';
import { fetchWithRetries } from './client.js';

const tracing = installTestTracing();
afterAll(() => tracing.uninstall());
beforeEach(() => tracing.reset());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('http client telemetry', () => {
  it('emits one client span per request with method, target and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));

    await fetchWithRetries('https://api.example.com/v1/things', { method: 'POST' });

    const [span] = tracing.named('HTTP POST');
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toMatchObject({
      'http.request.method': 'POST',
      'url.full': 'https://api.example.com/v1/things',
      'server.address': 'api.example.com',
      'http.response.status_code': 200,
    });
    expect(span?.attributes).not.toHaveProperty('http.request.resend_count');
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('never puts the query string in a trace (it can carry secrets)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

    await fetchWithRetries('https://api.example.com/search?api_key=SECRET&q=private');

    const url = String(tracing.named('HTTP GET')[0]?.attributes['url.full']);
    expect(url).toBe('https://api.example.com/search');
    expect(JSON.stringify(tracing.spans().map((s) => s.attributes))).not.toContain('SECRET');
  });

  it('counts retries on the single span of a logical request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 })),
    );

    await fetchWithRetries('https://api.example.com/x');

    expect(tracing.named('HTTP GET')).toHaveLength(1);
    expect(tracing.named('HTTP GET')[0]?.attributes).toMatchObject({
      'http.response.status_code': 200,
      'http.request.resend_count': 2,
    });
  });

  it('marks a 4xx/5xx final response as an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));

    await fetchWithRetries('https://api.example.com/missing');

    expect(tracing.named('HTTP GET')[0]?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'HTTP 404',
    });
  });

  it('records a network failure that exhausts its attempts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const promise = fetchWithRetries('https://api.example.com/x', { maxAttempts: 2 });
    const expectation = expect(promise).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await expectation;
    vi.useRealTimers();

    expect(tracing.named('HTTP GET')[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
