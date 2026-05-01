import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workaround for `@zenfs/core`'s `"./*": "./dist/*"` exports pattern:
      // Node ESM resolver requires the consumer to spell `index.js`, but
      // the agent package's source uses the directory form. Vite's
      // resolver is happy with the directory form when an alias short-
      // circuits the lookup, so we route both `@zenfs/core/vfs` and any
      // friend subpath through their concrete entry files here.
      '@zenfs/core/vfs': path.resolve(
        __dirname,
        '../../node_modules/@zenfs/core/dist/vfs/index.js'
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
