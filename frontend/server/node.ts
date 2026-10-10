/**
 * Production server: the built game (dist/) + the relayer at /api, in one process.
 *
 *   npm run build && npm start        (PORT, RELAYER_PRIVATE_KEY, VITE_CHAIN_ID / CHAIN_ID, RPC_URL)
 *
 * Also works as a relayer-only service for a frontend hosted elsewhere (build it with VITE_RELAYER_URL=<this>/api).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveFetch } from './http.ts';
import { lazyRelayer } from './lazy.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const port = Number(process.env.PORT || 8787);
const relay = lazyRelayer(process.env, 421614, join(root, 'src/chain/deployments'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/api' || url.startsWith('/api/')) {
    void serveFetch(relay, req, res, url);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  const path = normalize(decodeURIComponent(url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  if (!existsSync(file)) {
    res.statusCode = 404;
    return res.end('dist/ not found — run `npm run build` first (the relayer is still served at /api)');
  }
  res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
  if (file.includes(`${join(dist, 'assets')}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`NOVABALL on http://localhost:${port}  (relayer at /api)`));
