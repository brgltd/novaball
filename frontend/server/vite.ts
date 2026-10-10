/** Vite plugin: serves the relayer at /api on the dev server and `vite preview`, so `npm run dev` is the whole stack. */
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { loadEnv } from 'vite';

import { serveFetch } from './http.ts';
import { lazyRelayer } from './lazy.ts';

export function relayerPlugin(): Plugin {
  let handler: ReturnType<typeof lazyRelayer> | null = null;
  const mount = (middlewares: Connect.Server) => {
    middlewares.use('/api', (req, res) => {
      if (!handler) return res.end();
      void serveFetch(handler, req, res, (req as Connect.IncomingMessage).originalUrl ?? req.url ?? '/');
    });
  };
  return {
    name: 'novaball-relayer',
    configResolved(config) {
      // .env, .env.local, .env.[mode] — all keys (RELAYER_PRIVATE_KEY is never exposed to the client: no VITE_ prefix)
      const env = { ...loadEnv(config.mode, config.root, ''), ...process.env };
      const fallbackChain = config.command === 'serve' && config.mode === 'development' ? 31337 : 421614;
      handler = lazyRelayer(env, Number(env.VITE_CHAIN_ID || fallbackChain), join(config.root, 'src/chain/deployments'), (m) => config.logger.info(m));
    },
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
