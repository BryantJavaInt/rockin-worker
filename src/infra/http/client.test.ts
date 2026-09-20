// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOk, fetchWithRetries, HttpError, readRetryAfterMs } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    const response = new Response(null, { headers: { 'Retry-After': '30' } });
    expect(readRetryAfterMs(response)).toBe(30_000);
  });

  it('parses an HTTP-date', () => {
    const future = new Date(Date.now() + 8_000);
    const response = new Response(null, { headers: { 'Retry-After': future.toUTCString() } });
    expect(readRetryAfterMs(response)).toBeGreaterThan(6_000);
  });

  it('returns null when the header is absent', () => {
    expect(readRetryAfterMs(new Response(null))).toBeNull();
  });
});

describe('fetchWithRetries', () => {
  it('returns immediately on a 200, without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithRetries('https://example.com');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable status (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithRetries('https://example.com', { maxAttempts: 3 });

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable status (500) then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetries('https://example.com', { maxAttempts: 3 });
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After instead of the generic backoff window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetries('https://example.com', { maxAttempts: 3 });
    // The generic backoff for attempt 1 is >= 1000ms; Retry-After here is
    // exactly 1000ms. Advancing just past it should already resolve.
    await vi.advanceTimersByTimeAsync(1_001);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last bad response once attempts are exhausted, without throwing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetries('https://example.com', { maxAttempts: 2 });
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a thrown network error then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetries('https://example.com', { maxAttempts: 3 });
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung request after timeoutMs and retries', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // Never resolves on its own — only reacts to the abort signal,
        // simulating a connection that hangs.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetries('https://example.com', { maxAttempts: 2, timeoutMs: 5_000 });
    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows the network error once attempts are exhausted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetries('https://example.com', { maxAttempts: 2 });
    const expectation = expect(promise).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await expectation;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ensureOk', () => {
  it('passes a successful response through untouched', async () => {
    const response = new Response('ok', { status: 200 });

    expect(await ensureOk(response, 'Test API')).toBe(response);
  });

  it('throws a typed HttpError carrying the status and a body excerpt', async () => {
    const response = new Response('rate limited, slow down', { status: 429 });

    const error = await ensureOk(response, 'Test API').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429 });
    expect((error as Error).message).toMatch(/Test API responded 429: rate limited/);
  });
});
