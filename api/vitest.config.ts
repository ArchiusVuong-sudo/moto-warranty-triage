import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Each spec boots its own in-memory Postgres; two at a time keeps memory modest.
    maxWorkers: 2,
  },
});
