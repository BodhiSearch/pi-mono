import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, devices } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isCI = !!process.env.CI;
const isHeadless =
  process.env.HEADLESS === 'false' ? false : process.env.HEADLESS === 'true' || isCI;
const baseURL = 'http://localhost:5173/';
const reuseExistingServer = process.env.PW_TEST_REUSE_EXISTING_SERVER === 'true';

// Path to the acp-ui submodule's package root, relative to this file.
// Playwright's `webServer.command` runs inside `webServer.cwd`, so we
// chdir into acp-ui and ask it to build + preview the static web bundle.
const ACP_UI_DIR = path.resolve(__dirname, '..', '..', 'acp-ui');

function buildUserAgent(): string {
  const platform = os.platform();
  const chromeVersion = '141.0.0.0';
  const osToken =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/utils/**', '**/pages/**', '**/global-setup.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    headless: isHeadless,
    trace: 'retain-on-failure',
    screenshot: { mode: 'only-on-failure', fullPage: true },
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    ...(isHeadless && { userAgent: buildUserAgent() }),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], headless: isHeadless },
    },
  ],
  webServer: {
    command: 'npm run test-preview:web',
    cwd: ACP_UI_DIR,
    url: baseURL,
    reuseExistingServer,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
