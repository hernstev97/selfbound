import { defineConfig } from 'vitest/config';

// Tests of the pure building blocks (GitHub parsing, MCP protocol, Linear import,
// backup helpers). Run in Node, without the Convex test environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/lib/**/*.test.ts'],
  },
});
