/// <reference types="vitest/config" />
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    strictPort: true,
  },
  // M2 phase B: surface the dev flag both on the main thread (via
  // `import.meta.env.DEV`) and inside the Web Worker bundle via a
  // replaced global so `agent-adapter` can gate DEV-only features
  // (e.g. `forceToolCall`) without importing the Vite-only meta.
  define: {
    __WEB_ACP_DEV__: JSON.stringify(mode === 'development'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
}));
