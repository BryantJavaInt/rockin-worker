// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { APP } from '../config/meta.js';
import { describeError } from '../infra/errors.js';
import { recordMcpRequest } from '../infra/telemetry/metrics.js';
import type { Tool } from '../tools/define.js';
import { TOOLS } from '../tools/registry.js';
import { createOAuthAuthenticator, type OAuthOptions } from './auth/oauth.js';
import { createRateLimiter } from './auth/rate-limit.js';
import { isRevoked } from './auth/revocations.js';
import { createStaticAuthenticator } from './auth/static.js';
import { AuthError, type Authenticator, type Principal } from './auth/types.js';
import { createMcpServer } from './server.js';

export type McpHttpOptions = {
  /**
   * Shared secret clients must present as `Authorization: Bearer <token>`. Exactly one of `token`
   * and `oauth` must be given.
   */
  token?: string;
  /** Validate OAuth 2.1 access tokens from an external authorization server instead. */
  oauth?: OAuthOptions;
  /** Requests each client may make per minute; 0 turns the limit off. Default 120. */
  rateLimitPerMinute?: number;
  host?: string;
  port?: number;
  /** Browser origins allowed to call the server. Non-browser clients send no Origin and are unaffected. */
  allowedOrigins?: readonly string[];
  tools?: readonly Tool[];
  maxBodyBytes?: number;
};

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB: MCP requests are small JSON-RPC messages
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || host.startsWith('127.');

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

class BodyTooLarge extends Error {}

/**
 * Reads the request body, but stops *buffering* the moment it exceeds the limit, so an oversized
 * body can never grow memory. The socket is not destroyed here: the caller answers 413 with
 * `Connection: close` first, otherwise the client would see a reset instead of an error response.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0; // release what was buffered
        reject(new BodyTooLarge()); // later rejections are no-ops
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Picks how callers authenticate. Exactly one mode: two would leave it unclear which credential
 * a client is held to, and a misconfiguration must fail at start-up, not at the first request.
 */
function chooseAuthenticator(options: McpHttpOptions): Authenticator {
  if (options.token && options.oauth) {
    throw new Error('Configure either a shared token or OAuth for the MCP server, not both.');
  }
  if (options.oauth) return createOAuthAuthenticator(options.oauth);
  if (options.token) return createStaticAuthenticator(options.token);
  throw new Error('The MCP HTTP server needs a shared token or an OAuth configuration.');
}

/**
 * MCP over streamable HTTP, for clients that are not on the same machine.
 *
 * Security posture, in the order requests are checked:
 * 1. `Host` must be a loopback name when bound to loopback, and `Origin` (if sent) must be
 *    allow-listed — the MCP spec's defence against DNS-rebinding attacks from a web page.
 * 2. The bearer credential, *before* the body is read: either the shared token (constant-time
 *    comparison) or an OAuth 2.1 access token (signature, expiry, issuer, audience, scope), then
 *    the revocation list.
 * 3. A per-client rate limit.
 * 4. POST only, JSON body capped in size.
 *
 * It is stateless: every request gets its own server and transport, so there are no sessions
 * to hijack, nothing to clean up, and it scales horizontally. The tools are read-only, so
 * statelessness costs nothing. Bearer tokens on plain HTTP are readable on the network —
 * terminate TLS in front of any non-loopback deployment.
 */
export function createMcpHttpServer(options: McpHttpOptions) {
  const {
    host = '127.0.0.1',
    port = 8787,
    allowedOrigins = [],
    tools = TOOLS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    rateLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE,
  } = options;

  const auth = chooseAuthenticator(options);
  const limiter =
    rateLimitPerMinute > 0
      ? createRateLimiter({ limit: rateLimitPerMinute, windowMs: 60_000 })
      : null;

  /** Answers a refusal and records why, so the two can never drift apart. */
  function refuse(
    res: ServerResponse,
    outcome: string,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    recordMcpRequest(outcome);
    sendJson(res, status, body, headers);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isLoopback(host)) {
      const requestHost = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.includes(requestHost)) {
        return refuse(res, 'bad_host', 403, rpcError(-32000, 'Forbidden: unexpected Host header.'));
      }
    }

    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return refuse(res, 'bad_origin', 403, rpcError(-32000, 'Forbidden: origin not allowed.'));
    }

    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    let principal: Principal;
    try {
      principal = await auth.authenticate(bearer);
      if (principal.kind === 'oauth' && isRevoked(principal)) {
        throw new AuthError('invalid_token', 401, 'The access token has been revoked.', 'revoked');
      }
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      const headers: Record<string, string> = {
        // No credential at all gets a bare challenge; a rejected one says why (RFC 6750 §3.1).
        'WWW-Authenticate': auth.challenge(bearer ? err : undefined),
        ...(err.status === 503 ? { 'Retry-After': '30' } : {}),
      };
      return refuse(res, err.outcome, err.status, rpcError(-32001, err.message), headers);
    }

    if (limiter) {
      const decision = limiter.hit(`${principal.kind}:${principal.id}`);
      // Advertised on every answer so a well-behaved client can pace itself (IETF RateLimit headers).
      res.setHeader('RateLimit-Limit', String(decision.limit));
      res.setHeader('RateLimit-Remaining', String(decision.remaining));
      res.setHeader('RateLimit-Reset', String(decision.resetSeconds));
      if (!decision.allowed) {
        return refuse(res, 'rate_limited', 429, rpcError(-32002, 'Too many requests.'), {
          'Retry-After': String(decision.resetSeconds),
        });
      }
    }

    if (req.method !== 'POST') {
      return refuse(
        res,
        'method_not_allowed',
        405,
        rpcError(-32000, 'Method not allowed: use POST.'),
        { Allow: 'POST' },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, maxBodyBytes));
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        return refuse(res, 'too_large', 413, rpcError(-32000, 'Request body too large.'), {
          Connection: 'close',
        });
      }
      return refuse(res, 'bad_json', 400, rpcError(-32700, 'Parse error: body is not valid JSON.'));
    }

    recordMcpRequest('ok');
    const server = createMcpServer(tools);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer: Server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    const respond = async () => {
      // Liveness probe: unauthenticated and reveals nothing beyond what --version prints.
      if (pathname === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', name: APP.name, version: APP.version });
      }
      // RFC 9728: how a client learns which authorization server protects this resource. It must
      // be public — the client has no token yet, that is the point of asking.
      if (auth.metadata?.paths.includes(pathname) && req.method === 'GET') {
        return sendJson(res, 200, auth.metadata.document, {
          'Cache-Control': 'public, max-age=300',
        });
      }
      if (pathname !== '/mcp') return sendJson(res, 404, rpcError(-32000, 'Not found.'));
      return handleMcp(req, res);
    };

    respond().catch((err) => {
      console.error(`[mcp-http] request failed: ${describeError(err)}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal error.'));
      else res.end();
    });
  });
  httpServer.requestTimeout = 30_000;

  return {
    server: httpServer,

    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          resolve({ host, port: typeof address === 'object' && address ? address.port : port });
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections(); // do not wait for idle keep-alive sockets
      });
    },
  };
}

/** Runs the HTTP server until `signal` aborts, then shuts it down. */
export async function serveHttp(options: McpHttpOptions, signal?: AbortSignal): Promise<void> {
  const http = createMcpHttpServer(options);
  const { host, port } = await http.listen();

  console.error(
    `MCP server listening on http://${host}:${port}/mcp (Ctrl+C stops it). Authentication: ${
      options.oauth ? `OAuth 2.1 access tokens from ${options.oauth.issuer}` : 'shared bearer token'
    }.`,
  );
  if (!isLoopback(host)) {
    console.error(
      'Warning: bound to a non-loopback address. Bearer tokens over plain HTTP are readable on the ' +
        'network — put a TLS-terminating reverse proxy in front.',
    );
  }

  if (signal && !signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
  await http.close();
}
