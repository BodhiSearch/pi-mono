import openModule from 'open';

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

/**
 * Default opener: spawns the user's default browser via the `open` package.
 * Returns once the OS reports the launch was issued (does not wait for the
 * tab to actually load).
 */
export const defaultBrowserOpener: BrowserOpener = {
  async open(url: string): Promise<void> {
    await openModule(url);
  },
};

/**
 * Opener that prints the URL but does not actually launch a browser. Used
 * when `--no-browser` is set or the runtime cannot spawn a GUI app
 * (headless server, stdin-piped CI). The harness can override the opener
 * with a Playwright-driven one in e2e.
 */
export function createPrintOnlyOpener(write: (line: string) => void): BrowserOpener {
  return {
    async open(url: string): Promise<void> {
      write(`Open this URL in your browser to continue:\n${url}\n`);
    },
  };
}
