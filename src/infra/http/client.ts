// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

// Shared HTTP client used by every outbound call (GitHub, Notion, Anthropic).
// One retry policy for the whole project means one thing to reason about and test.
//
// Diagnostics go to stderr: when running as an MCP server, stdout carries the
// protocol and must never be polluted.

import { markError, SpanKind, traced } from '../telemetry/tracing.js';

export class HttpError extends Error {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads `Retry-After` (RFC 9110 §10.2.3): delta-seconds or an HTTP-date.
 * Returns null when absent or unparsable so callers can fall back to backoff.
 */
export function readRetryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);

  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());

  return null;
}

/**
 * Primary rate limits (GitHub): a 403/429 with `X-RateLimit-Remaining: 0` and the epoch-seconds
 * time the window resets in `X-RateLimit-Reset`. These responses carry no `Retry-After`.
 */
export function readRateLimitResetMs(response: Response): number | null {
  if (response.headers.get('x-ratelimit-remaining') !== '0') return null;

  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) return null;

  return Math.max(0, resetSeconds * 1000 - Date.now());
}

export type FetchWithRetriesOptions = {
  /** Called with the attempt number (1-based) before each try; used to record retries on the span. */
  onAttempt?: (attempt: number) => void;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  maxAttempts?: number;
  /** Per-attempt timeout. A hung connection is treated like a network error. */
  timeoutMs?: number;
  /**
   * Longest wait the server may ask for (Retry-After / rate-limit reset) before we give up
   * and return the response instead. A CLI must not sleep for an hour. Default 60s.
   */
  maxRetryWaitMs?: number;
  /** Which responses are worth retrying. Defaults to 429, any 5xx, and a rate-limited 403. */
  isRetryable?: (response: Response) => boolean;
};

const defaultIsRetryable = (response: Response) =>
  response.status === 429 ||
  response.status >= 500 ||
  (response.status === 403 && readRateLimitResetMs(response) !== null);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;

/**
 * Performs a request, retrying transient failures:
 * - retryable status → honors the server's `Retry-After`, else backoff + jitter
 *   (jitter avoids a thundering herd of synchronized retries);
 * - thrown network error / timeout (AbortController) → backoff + jitter.
 *
 * On the last attempt a bad-status response is returned (callers check
 * `response.ok`); a network error is rethrown since there is no response.
 */
async function fetchWithRetriesImpl(
  url: string,
  options: FetchWithRetriesOptions = {},
): Promise<Response> {
  const {
    headers,
    method,
    body,
    maxAttempts = 3,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetryWaitMs = DEFAULT_MAX_RETRY_WAIT_MS,
    isRetryable = defaultIsRetryable,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.onAttempt?.(attempt);
    const isLastAttempt = attempt === maxAttempts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { headers, method, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);

      if (isLastAttempt) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      const isTimeout = (err as { name?: string }).name === 'AbortError';
      const waitMs = 1000 * attempt + Math.random() * 500;

      console.warn(
        `${isTimeout ? `Timeout after ${timeoutMs}ms` : 'Network error'} calling ${url} — ` +
          `retrying in ${waitMs.toFixed(0)}ms (attempt ${attempt}/${maxAttempts})`,
      );

      await sleep(waitMs);
      continue;
    }

    clearTimeout(timer);

    if (response.ok || !isRetryable(response) || isLastAttempt) {
      return response;
    }

    // A wait the server asked for (Retry-After, or the rate-limit window reset) wins over
    // our own guess — unless it is longer than we are willing to block for.
    const serverWaitMs = readRetryAfterMs(response) ?? readRateLimitResetMs(response);
    if (serverWaitMs !== null && serverWaitMs > maxRetryWaitMs) {
      console.warn(
        `HTTP ${response.status} from ${url} — server asked to wait ${Math.round(serverWaitMs / 1000)}s, ` +
          `more than the ${Math.round(maxRetryWaitMs / 1000)}s limit; giving up.`,
      );
      return response;
    }

    const waitMs = serverWaitMs ?? 1000 * attempt + Math.random() * 500;
    const reason = serverWaitMs !== null ? 'server-directed wait' : 'generic backoff';

    console.warn(
      `HTTP ${response.status} from ${url} — retrying in ${waitMs.toFixed(0)}ms ` +
        `(attempt ${attempt}/${maxAttempts}, ${reason})`,
    );

    await sleep(waitMs);
  }

  // Unreachable: every branch above returns or throws by the last attempt.
  throw new Error(`fetchWithRetries: exhausted ${maxAttempts} attempts calling ${url}`);
}

/** Origin + path only: a query string can carry secrets and must never end up in a trace. */
function describeTarget(url: string): { full: string; host: string } {
  try {
    const target = new URL(url);
    return { full: `${target.origin}${target.pathname}`, host: target.hostname };
  } catch {
    return { full: 'invalid-url', host: 'unknown' };
  }
}

/**
 * Public entry point: the retry logic above, recorded as one client span per logical request
 * (attempts included), with the final status code and the number of resends.
 */
export function fetchWithRetries(
  url: string,
  options: FetchWithRetriesOptions = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  const target = describeTarget(url);

  return traced(
    `HTTP ${method}`,
    { 'http.request.method': method, 'url.full': target.full, 'server.address': target.host },
    async (span) => {
      let attempts = 0;
      const response = await fetchWithRetriesImpl(url, {
        ...options,
        onAttempt: (attempt) => {
          attempts = attempt;
          options.onAttempt?.(attempt);
        },
      });

      span.setAttribute('http.response.status_code', response.status);
      if (attempts > 1) span.setAttribute('http.request.resend_count', attempts - 1);
      if (response.status >= 400) markError(span, `HTTP ${response.status}`);
      return response;
    },
    { kind: SpanKind.CLIENT },
  );
}

/** Turns a non-2xx response into a typed error, keeping a short body excerpt for debugging. */
export async function ensureOk(response: Response, label: string): Promise<Response> {
  if (response.ok) return response;

  const excerpt = (await response.text().catch(() => '')).slice(0, 200);
  throw new HttpError(
    response.status,
    response.url,
    `${label} responded ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
  );
}
