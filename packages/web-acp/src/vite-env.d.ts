/// <reference types="vite/client" />

/**
 * Build-time flag injected by Vite's `define` (see `vite.config.ts`).
 * `true` when running `npm run dev`, `false` for production builds.
 * Surfaces as a module-level constant inside the Web Worker bundle too
 * so worker-side code can gate DEV-only features without reaching for
 * the main-thread-only `import.meta.env.DEV`.
 */
declare const __WEB_ACP_DEV__: boolean;
