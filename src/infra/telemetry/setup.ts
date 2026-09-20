// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { APP } from '../../config/meta.js';
import { describeError } from '../errors.js';

export type TelemetryHandle = {
  /** True when at least one signal (traces or metrics) is being exported. */
  enabled: boolean;
  /** Flushes buffered spans and metrics and stops exporting. Bounded, so a dead collector cannot hang exit. */
  shutdown(): Promise<void>;
};

const DISABLED: TelemetryHandle = { enabled: false, shutdown: async () => {} };
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXPORT_TIMEOUT_MS = 3_000;

/** Parses the standard "key=value,key2=value2" header list (values may be URL-encoded). */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (text ?? '').split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key) headers[key] = decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return headers;
}

export type Signal = 'traces' | 'metrics';

const PATH: Record<Signal, string> = { traces: '/v1/traces', metrics: '/v1/metrics' };

/**
 * Where and how to export one signal, read from the given environment. Passed to the exporter
 * explicitly: left to itself it would consult `process.env`, ignoring the environment this
 * function was given. Per the OpenTelemetry spec, a signal-specific endpoint is used as-is, while
 * the general one is a base URL that gets `/v1/traces` or `/v1/metrics` appended. Returns null
 * when no endpoint applies to the signal.
 */
export function otlpConfig(
  env: NodeJS.ProcessEnv,
  signal: Signal,
): { url: string; headers: Record<string, string> } | null {
  const upper = signal.toUpperCase();
  const specific = env[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`];
  const general = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!specific && !general) return null;

  const url = specific || `${(general ?? '').replace(/\/+$/, '')}${PATH[signal]}`;
  const headers = parseOtlpHeaders(
    env[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`] ?? env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  return { url, headers };
}

/** Whether a signal is switched off by `OTEL_SDK_DISABLED` or `OTEL_<SIGNAL>_EXPORTER=none`. */
function isOff(env: NodeJS.ProcessEnv, signal: Signal): boolean {
  return (
    env.OTEL_SDK_DISABLED === 'true' || env[`OTEL_${signal.toUpperCase()}_EXPORTER`] === 'none'
  );
}

/** `OTEL_METRIC_EXPORT_INTERVAL` in milliseconds; 60 s (the specification's default) when absent or invalid. */
export function metricExportIntervalMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(value) && value >= 1_000 ? value : 60_000;
}

/**
 * Starts exporting traces and metrics over OTLP/HTTP when — and only when — a collector endpoint
 * is configured through the standard OpenTelemetry variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, or
 * the per-signal `..._TRACES_ENDPOINT` / `..._METRICS_ENDPOINT`; headers, service name, export
 * interval etc. follow the same standard). `OTEL_SDK_DISABLED=true` always wins, and
 * `OTEL_TRACES_EXPORTER=none` / `OTEL_METRICS_EXPORTER=none` switch one signal off.
 *
 * The SDK is imported dynamically, so a run without telemetry never even loads it. Telemetry is
 * best-effort: a failure to start it is reported and the program carries on without it.
 */
export async function initTelemetry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryHandle> {
  const traces = isOff(env, 'traces') ? null : otlpConfig(env, 'traces');
  const meters = isOff(env, 'metrics') ? null : otlpConfig(env, 'metrics');
  if (!traces && !meters) return DISABLED;

  try {
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const resource = resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME || APP.name,
      'service.version': APP.version,
    });
    const shutdowns: Array<() => Promise<void>> = [];

    if (traces) {
      const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }] = await Promise.all(
        [
          import('@opentelemetry/sdk-trace-node'),
          import('@opentelemetry/exporter-trace-otlp-http'),
        ],
      );
      const provider = new NodeTracerProvider({
        resource,
        spanProcessors: [
          new BatchSpanProcessor(
            new OTLPTraceExporter({ ...traces, timeoutMillis: EXPORT_TIMEOUT_MS }),
          ),
        ],
      });
      provider.register();
      shutdowns.push(() => provider.shutdown());
    }

    if (meters) {
      const [
        { MeterProvider, PeriodicExportingMetricReader },
        { OTLPMetricExporter },
        { metrics },
      ] = await Promise.all([
        import('@opentelemetry/sdk-metrics'),
        import('@opentelemetry/exporter-metrics-otlp-http'),
        import('@opentelemetry/api'),
      ]);
      const provider = new MeterProvider({
        resource,
        readers: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ ...meters, timeoutMillis: EXPORT_TIMEOUT_MS }),
            exportIntervalMillis: metricExportIntervalMs(env),
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
          }),
        ],
      });
      metrics.setGlobalMeterProvider(provider);
      // shutdown() performs a final collection, so a short CLI run still reports its metrics.
      shutdowns.push(() => provider.shutdown());
    }

    return {
      enabled: true,
      shutdown: async () => {
        // Best effort, in both directions: never hang the exit on a dead collector (the
        // timeout), and never fail the program because telemetry could not be delivered (the catch).
        for (const stop of shutdowns) {
          try {
            await Promise.race([
              stop(),
              new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
            ]);
          } catch (err) {
            console.error(`Telemetry: could not flush (${describeError(err)}).`);
          }
        }
      },
    };
  } catch (err) {
    console.error(`Telemetry disabled: could not start OpenTelemetry (${describeError(err)}).`);
    return DISABLED;
  }
}
