import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs: the production build works from any path (site root, a GitHub Pages project subpath such
  // as /novaball/, an IPFS gateway, ...). The dev server is unaffected.
  base: './',
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
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
