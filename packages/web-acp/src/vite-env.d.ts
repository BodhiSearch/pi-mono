/// <reference types="vite/client" />

/**
 * Build-time flag injected by Vite's `define` (see `vite.config.ts`).
 * `true` when running `npm run dev`, `false` for production builds.
 * Surfaces as a module-level constant inside the Web Worker bundle too
 * so worker-side code can gate DEV-only features without reaching for
 * the main-thread-only `import.meta.env.DEV`.
 */
declare const __WEB_ACP_DEV__: boolean;

/**
 * Build-time strings injected by Vite's `define` for the built-in
 * `/version` slash command. Sourced from this package's own
 * `package.json` and the resolved `@agentclientprotocol/sdk`
 * `package.json` at config-eval time.
 */
declare const __WEB_ACP_VERSION__: string;
declare const __ACP_SDK_VERSION__: string;

/**
 * File System Access API — `showDirectoryPicker` is a Chromium-only
 * surface not yet in `lib.dom.d.ts`. Declared minimally so the hook
 * that uses it typechecks; runtime existence is feature-detected
 * (`typeof window.showDirectoryPicker === 'function'`).
 */
interface Window {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
    id?: string;
    startIn?: string | FileSystemHandle;
  }) => Promise<FileSystemDirectoryHandle>;
}
