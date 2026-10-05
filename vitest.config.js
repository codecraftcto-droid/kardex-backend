import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.js'],
    setupFiles: ['./tests/env.js'],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
