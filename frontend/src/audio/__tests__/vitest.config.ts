/**
 * Audio unit tests (Node, no Web Audio). Run with:
 *   npx vitest run -c src/audio/__tests__/vitest.config.ts
 * (Kept inside src/audio so the audio module stays self-contained; the project-wide config only scans tests/.)
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: new URL('../../..', import.meta.url).pathname,
    include: ['src/audio/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
