import { defineConfig } from 'vitest/config';
import { seo } from './vite.seo.ts';

/** Local chain: the browser reaches anvil through the dev server, so the game also works from another device on the LAN. */
const anvilProxy = { target: 'http://127.0.0.1:8545', changeOrigin: true, rewrite: () => '/' };

export default defineConfig({
  // Relative asset URLs: the production build works from any path (site root, a GitHub Pages project subpath such
  // as /novaball/, an IPFS gateway, ...). The dev server is unaffected.
  base: './',
  // canonical / Open Graph URLs, structured data, robots.txt and sitemap.xml (see vite.seo.ts)
  plugins: [seo()],
  server: { port: 5173, host: true, proxy: { '/rpc': anvilProxy } },
  preview: { port: 4173, host: true, proxy: { '/rpc': anvilProxy } },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    // project tests + module-local unit tests (e.g. src/audio/__tests__, which also has its own config)
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
