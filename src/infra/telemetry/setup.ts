// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { APP } from '../../config/meta.js';
import { describeError } from '../errors.js';

export type TelemetryHandle = {
  enabled: boolean;
  /** Flushes buffered spans and stops exporting. Bounded, so a dead collector cannot hang exit. */
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

/**
 * Where and how to export, read from the given environment. Passed to the exporter explicitly:
 * left to itself it would consult `process.env`, ignoring the environment this function was
 * given. Per the OpenTelemetry spec, a traces-specific endpoint is used as-is, while the general
 * one is a base URL that gets `/v1/traces` appended.
 */
export function otlpTraceConfig(env: NodeJS.ProcessEnv): {
  url: string;
  headers: Record<string, string>;
} {
  const url =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    `${(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').replace(/\/+$/, '')}/v1/traces`;
  const headers = parseOtlpHeaders(
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  return { url, headers };
}

/**
 * Starts exporting traces over OTLP/HTTP when — and only when — a collector endpoint is
 * configured through the standard OpenTelemetry variables (`OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`; headers, service name, etc. follow the same standard).
 * `OTEL_SDK_DISABLED=true` always wins.
 *
 * The SDK is imported dynamically, so a run without telemetry never even loads it. Telemetry is
 * best-effort: a failure to start it is reported and the program carries on without traces.
 */
export async function initTelemetry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryHandle> {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || env.OTEL_SDK_DISABLED === 'true') return DISABLED;

  try {
    const [
      { NodeTracerProvider, BatchSpanProcessor },
      { OTLPTraceExporter },
      { resourceFromAttributes },
    ] = await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
    ]);

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': env.OTEL_SERVICE_NAME || APP.name,
        'service.version': APP.version,
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ ...otlpTraceConfig(env), timeoutMillis: EXPORT_TIMEOUT_MS }),
        ),
      ],
    });
    provider.register();

    return {
      enabled: true,
      shutdown: async () => {
        // Best effort, in both directions: never hang the exit on a dead collector (the
        // timeout), and never fail the program because traces could not be delivered (the catch).
        try {
          await Promise.race([
            provider.shutdown(),
            new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
          ]);
        } catch (err) {
          console.error(`Telemetry: could not flush traces (${describeError(err)}).`);
        }
      },
    };
  } catch (err) {
    console.error(`Telemetry disabled: could not start OpenTelemetry (${describeError(err)}).`);
    return DISABLED;
  }
}
