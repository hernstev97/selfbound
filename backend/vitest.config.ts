import { defineConfig } from 'vitest/config';

// convex-test needs the edge runtime (like Convex itself) and must be processed by Vite
// so that import.meta.glob works for the function modules.
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
