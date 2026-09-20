// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { APP } from '../config/meta.js';
import { describeError } from '../core/errors.js';
import type { Tool } from '../tools/define.js';
import { TOOLS } from '../tools/registry.js';
import { createMcpServer } from './server.js';

export type McpHttpOptions = {
  /** Shared secret clients must present as `Authorization: Bearer <token>`. */
  token: string;
  host?: string;
  port?: number;
  /** Browser origins allowed to call the server. Non-browser clients send no Origin and are unaffected. */
  allowedOrigins?: readonly string[];
  tools?: readonly Tool[];
  maxBodyBytes?: number;
};

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB: MCP requests are small JSON-RPC messages

export const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || host.startsWith('127.');

/**
 * Compares tokens in constant time. Hashing both sides first gives equal-length inputs (which
 * timingSafeEqual requires) and keeps the token's length from leaking through timing.
 */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

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
 * MCP over streamable HTTP, for clients that are not on the same machine.
 *
 * Security posture, in the order requests are checked:
 * 1. `Host` must be a loopback name when bound to loopback, and `Origin` (if sent) must be
 *    allow-listed — the MCP spec's defence against DNS-rebinding attacks from a web page.
 * 2. Bearer token, compared in constant time, *before* the body is read.
 * 3. POST only, JSON body capped in size.
 *
 * It is stateless: every request gets its own server and transport, so there are no sessions
 * to hijack, nothing to clean up, and it scales horizontally. The tools are read-only, so
 * statelessness costs nothing. Bearer tokens on plain HTTP are readable on the network —
 * terminate TLS in front of any non-loopback deployment.
 */
export function createMcpHttpServer(options: McpHttpOptions) {
  const {
    token,
    host = '127.0.0.1',
    port = 8787,
    allowedOrigins = [],
    tools = TOOLS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = options;

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isLoopback(host)) {
      const requestHost = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.includes(requestHost)) {
        return sendJson(res, 403, rpcError(-32000, 'Forbidden: unexpected Host header.'));
      }
    }

    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return sendJson(res, 403, rpcError(-32000, 'Forbidden: origin not allowed.'));
    }

    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!tokensMatch(bearer, token)) {
      return sendJson(res, 401, rpcError(-32001, 'Unauthorized.'), {
        'WWW-Authenticate': 'Bearer realm="mcp"',
      });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, rpcError(-32000, 'Method not allowed: use POST.'), {
        Allow: 'POST',
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, maxBodyBytes));
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        return sendJson(res, 413, rpcError(-32000, 'Request body too large.'), {
          Connection: 'close',
        });
      }
      return sendJson(res, 400, rpcError(-32700, 'Parse error: body is not valid JSON.'));
    }

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

  console.error(`MCP server listening on http://${host}:${port}/mcp (Ctrl+C stops it).`);
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
