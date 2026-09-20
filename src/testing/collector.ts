// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { createServer, type IncomingMessage, type Server } from 'node:http';

export type Received = { path: string; contentType: string; body: string };

/** A tiny OTLP/HTTP collector: records whatever an exporter posts to it. */
export async function startCollector() {
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
