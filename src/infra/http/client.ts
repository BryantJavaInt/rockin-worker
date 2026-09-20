// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

// Shared HTTP client used by every outbound call (GitHub, Notion, Anthropic).
// One retry policy for the whole project means one thing to reason about and test.
//
// Diagnostics go to stderr: when running as an MCP server, stdout carries the
// protocol and must never be polluted.

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

export type FetchWithRetriesOptions = {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  maxAttempts?: number;
  /** Per-attempt timeout. A hung connection is treated like a network error. */
  timeoutMs?: number;
  /** Which HTTP statuses are worth retrying. Defaults to 429 and any 5xx. */
  isRetryable?: (status: number) => boolean;
};

const defaultIsRetryable = (status: number) => status === 429 || status >= 500;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Performs a request, retrying transient failures:
 * - retryable status → honors the server's `Retry-After`, else backoff + jitter
 *   (jitter avoids a thundering herd of synchronized retries);
 * - thrown network error / timeout (AbortController) → backoff + jitter.
 *
 * On the last attempt a bad-status response is returned (callers check
 * `response.ok`); a network error is rethrown since there is no response.
 */
export async function fetchWithRetries(
  url: string,
  options: FetchWithRetriesOptions = {},
): Promise<Response> {
  const {
    headers,
    method,
    body,
    maxAttempts = 3,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    isRetryable = defaultIsRetryable,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

    if (response.ok || !isRetryable(response.status) || isLastAttempt) {
      return response;
    }

    const retryAfterMs = readRetryAfterMs(response);
    const waitMs = retryAfterMs ?? 1000 * attempt + Math.random() * 500;
    const reason = retryAfterMs !== null ? 'server Retry-After' : 'generic backoff';

    console.warn(
      `HTTP ${response.status} from ${url} — retrying in ${waitMs.toFixed(0)}ms ` +
        `(attempt ${attempt}/${maxAttempts}, ${reason})`,
    );

    await sleep(waitMs);
  }

  // Unreachable: every branch above returns or throws by the last attempt.
  throw new Error(`fetchWithRetries: exhausted ${maxAttempts} attempts calling ${url}`);
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
