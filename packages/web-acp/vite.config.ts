/// <reference types="vitest/config" />
import { readFileSync } from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function readJsonVersion(rel: string): string {
  try {
    const raw = readFileSync(path.resolve(__dirname, rel), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const WEB_ACP_VERSION = readJsonVersion('./package.json');
const ACP_SDK_VERSION = readJsonVersion('./node_modules/@agentclientprotocol/sdk/package.json');

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
  //
  // M4 phase B: expose the package + ACP SDK versions for the
  // built-in `/version` slash command.
  define: {
    __WEB_ACP_DEV__: JSON.stringify(mode === 'development'),
    __WEB_ACP_VERSION__: JSON.stringify(WEB_ACP_VERSION),
    __ACP_SDK_VERSION__: JSON.stringify(ACP_SDK_VERSION),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
}));
