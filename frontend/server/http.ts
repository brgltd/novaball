/** Node http ⇄ Fetch API adapter for the relayer's `handle(Request) → Response`. */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CLIENT_IP_HEADER } from './relayer.ts';

/** Behind a reverse proxy (Render, Railway, Fly, nginx…) set TRUST_PROXY=1 to rate-limit by X-Forwarded-For. */
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export type FetchHandler = (req: Request) => Promise<Response>;

export async function toRequest(req: IncomingMessage, url: string): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  headers.set(CLIENT_IP_HEADER, clientIp(req)); // overrides anything the client sent
  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(new URL(url, `http://${req.headers.host ?? 'localhost'}`), { method: req.method, headers, body: body ? new Uint8Array(body) : undefined });
}

export async function sendResponse(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** Serve `handler` for a Node request; `url` is the full original URL (path + query). */
export async function serveFetch(handler: FetchHandler, req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  try {
    await sendResponse(res, await handler(await toRequest(req, url)));
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'bad_request', message: err instanceof Error ? err.message : 'Bad request' }));
  }
}
