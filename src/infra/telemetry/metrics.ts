// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
} from '@opentelemetry/api';
import { APP } from '../../config/meta.js';

/**
 * Metrics, like traces, are recorded through the OpenTelemetry API only: without an SDK the
 * global meter provider is a no-op and every call below costs nothing.
 *
 * One difference from tracing forces the shape of this file. The API has a *proxy* tracer that
 * starts delegating once a provider is registered, but no proxy meter: an instrument created
 * before `initTelemetry` registers its provider stays a no-op forever. So instruments are built
 * lazily and rebuilt whenever the global provider changes, instead of once at import time.
 *
 * Attribute values are always low-cardinality (a fixed set of sources, tools, methods, outcomes,
 * a host name) — never a URL, a query, an id or free text — so a metrics backend cannot be
 * flooded by user input.
 */

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const TOKENS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536];

type Instruments = {
  syncDuration: Histogram;
  syncRecords: Counter;
  httpDuration: Histogram;
  toolDuration: Histogram;
  modelDuration: Histogram;
  modelTokens: Histogram;
  mcpRequests: Counter;
};

function createInstruments(meter: Meter): Instruments {
  const seconds = { unit: 's', advice: { explicitBucketBoundaries: SECONDS } };

  return {
    syncDuration: meter.createHistogram('rockin.sync.duration', {
      description: 'Duration of one sync pass for a source.',
      ...seconds,
    }),
    syncRecords: meter.createCounter('rockin.sync.records', {
      description: 'Records handled by sync passes, by operation.',
      unit: '{record}',
    }),
    httpDuration: meter.createHistogram('http.client.request.duration', {
      description: 'Duration of outbound HTTP requests, retries included.',
      ...seconds,
    }),
    toolDuration: meter.createHistogram('rockin.tool.duration', {
      description: 'Duration of tool executions.',
      ...seconds,
    }),
    modelDuration: meter.createHistogram('gen_ai.client.operation.duration', {
      description: 'Duration of model calls.',
      ...seconds,
    }),
    modelTokens: meter.createHistogram('gen_ai.client.token.usage', {
      description: 'Tokens used per model call, by type.',
      unit: '{token}',
      advice: { explicitBucketBoundaries: TOKENS },
    }),
    mcpRequests: meter.createCounter('rockin.mcp.requests', {
      description: 'Requests to the remote MCP endpoint, by outcome.',
      unit: '{request}',
    }),
  };
}

let cached: { provider: MeterProvider; instruments: Instruments } | undefined;

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider !== provider) {
    cached = {
      provider,
      instruments: createInstruments(provider.getMeter(APP.name, APP.version)),
    };
  }
  return cached.instruments;
}

/** Starts a timer; the returned function gives the seconds elapsed since. */
export function stopwatch(): () => number {
  const started = performance.now();
  return () => (performance.now() - started) / 1000;
}

export type SyncMetrics = {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
  errors: number;
};

export function recordSyncRun(source: string, seconds: number, result: SyncMetrics): void {
  const { syncDuration, syncRecords } = instruments();
  const outcome = result.errors > 0 ? 'error' : 'ok';

  syncDuration.record(seconds, { 'sync.source': source, outcome });
  for (const operation of ['inserted', 'updated', 'skipped', 'deleted'] as const) {
    if (result[operation] > 0) {
      syncRecords.add(result[operation], { 'sync.source': source, operation });
    }
  }
}

export function recordHttpRequest(
  seconds: number,
  attributes: { method: string; host: string; status?: number; error?: string },
): void {
  const labels: Attributes = {
    'http.request.method': attributes.method,
    'server.address': attributes.host,
  };
  if (attributes.status !== undefined) labels['http.response.status_code'] = attributes.status;
  // Per the semantic conventions: a 4xx/5xx is an error with the status as its type.
  const type =
    attributes.error ??
    (attributes.status && attributes.status >= 400 ? `${attributes.status}` : undefined);
  if (type) labels['error.type'] = type;

  instruments().httpDuration.record(seconds, labels);
}

export function recordToolCall(tool: string, seconds: number, ok: boolean): void {
  instruments().toolDuration.record(seconds, {
    'gen_ai.tool.name': tool,
    outcome: ok ? 'ok' : 'error',
  });
}

export function recordModelCall(
  model: string,
  seconds: number,
  usage?: { inputTokens: number; outputTokens: number },
): void {
  const { modelDuration, modelTokens } = instruments();
  const base = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.request.model': model,
  };

  modelDuration.record(seconds, { ...base, ...(usage ? {} : { 'error.type': 'error' }) });
  if (usage) {
    modelTokens.record(usage.inputTokens, { ...base, 'gen_ai.token.type': 'input' });
    modelTokens.record(usage.outputTokens, { ...base, 'gen_ai.token.type': 'output' });
  }
}

export function recordMcpRequest(outcome: string): void {
  instruments().mcpRequests.add(1, { outcome });
}
