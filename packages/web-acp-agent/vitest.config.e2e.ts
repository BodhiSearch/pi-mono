import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['e2e/**/*.spec.ts'],
    globalSetup: ['./e2e/tests/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
