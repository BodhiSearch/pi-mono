import type { FullConfig } from '@playwright/test';
import { chromium } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// We deliberately reach across packages here: web-acp/e2e already has a
// battle-tested NAPI BodhiApp boot flow. Re-implementing it here would
// drift; this is the same pattern packages/cli-acp-client/e2e uses.
import { BodhiServerManager } from '../../../web-acp/e2e/tests/utils/bodhi-server-manager';
import { LoginPage } from '../../../web-acp/e2e/tests/pages/admin/LoginPage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const E2E_DIR = path.resolve(__dirname, '..');
export const STATE_FILE = path.join(E2E_DIR, '.test-state.json');

export interface TestState {
  bodhiServerUrl: string;
  username: string;
  password: string;
}

export function getTestState(): TestState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

const isHeadless =
  process.env.HEADLESS === 'false'
    ? false
    : process.env.HEADLESS === 'true' || process.env.CI === 'true';

// Distinct from web-acp/e2e (51135) and cli-acp-client/e2e (31135) so the
// three suites don't trip on each other when run side by side.
const BODHI_SERVER_PORT = 41135;
// Local OAuth callback port the CLI binds during the access-request flow.
// Must match DEFAULT_CALLBACK_PORT in src/auth/config.ts; Keycloak's public
// client only accepts this exact redirect_uri.
const CLI_CALLBACK_PORT = 5173;
export const BODHI_SERVER_URL = `http://localhost:${BODHI_SERVER_PORT}`;

function isPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function assertPortsFree(): Promise<void> {
  for (const port of [BODHI_SERVER_PORT, CLI_CALLBACK_PORT]) {
    if (await isPortInUse(port)) {
      throw new Error(
        `Port ${port} is already in use. Stop the conflicting process before running the e2e suite.`
      );
    }
  }
}

const REQUIRED_ENV_VARS = [
  'BODHIAPP_CLIENT_ID',
  'BODHIAPP_CLIENT_SECRET',
  'BODHIAPP_USERNAME',
  'BODHIAPP_USERID',
  'BODHIAPP_PASSWORD',
  'BODHIAPP_AUTH_URL',
  'BODHIAPP_AUTH_REALM',
];

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function resolveBinPath(): string {
  const binDir = path.resolve(E2E_DIR, 'bin');
  if (!existsSync(binDir)) {
    throw new Error(
      `e2e/bin directory not found. Symlink it from web-acp/e2e/bin: ` +
        `ln -s ../../web-acp/e2e/bin packages/tutorial-cli-client/e2e/bin`
    );
  }
  return binDir;
}

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

let bodhiServer: BodhiServerManager | null = null;

async function globalSetup(_: FullConfig): Promise<() => Promise<void>> {
  loadEnv({ path: path.join(E2E_DIR, '.env.test'), quiet: true });

  const missing = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables in e2e/.env.test: ${missing.join(', ')}`
    );
  }

  await assertPortsFree();
  const binPath = resolveBinPath();

  bodhiServer = new BodhiServerManager({
    port: BODHI_SERVER_PORT,
    host: 'localhost',
    appStatus: 'ready',
    createdBy: getEnv('BODHIAPP_USERID'),
    authUrl: getEnv('BODHIAPP_AUTH_URL'),
    authRealm: getEnv('BODHIAPP_AUTH_REALM'),
    clientId: getEnv('BODHIAPP_CLIENT_ID'),
    clientSecret: getEnv('BODHIAPP_CLIENT_SECRET'),
    binPath,
    logLevel: 'debug',
    logToStdout: true,
  });

  const serverUrl = await bodhiServer.start();

  const headless = isHeadless;
  const videoDir = path.join(E2E_DIR, 'test-results', 'global-setup');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    recordVideo: { dir: videoDir },
    ...(headless && { userAgent: buildUserAgent() }),
  });
  const page = await context.newPage();
  let setupFailed = false;
  try {
    const loginPage = new LoginPage(page, serverUrl, {
      username: getEnv('BODHIAPP_USERNAME'),
      password: getEnv('BODHIAPP_PASSWORD'),
    });
    await loginPage.performOAuthLogin('/ui/chat/');
  } catch (err) {
    setupFailed = true;
    const shotPath = path.join(E2E_DIR, 'test-results', 'global-setup-failure.png');
    try {
      await page.screenshot({ path: shotPath, fullPage: true });
      console.error(`[global-setup] failure screenshot saved: ${shotPath}`);
      console.error(`[global-setup] failure page URL: ${page.url()}`);
    } catch {
      // ignore
    }
    throw err;
  } finally {
    await context.close();
    await browser.close();
    if (!setupFailed && existsSync(videoDir)) {
      rmSync(videoDir, { recursive: true, force: true });
    }
  }

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      bodhiServerUrl: serverUrl,
      username: getEnv('BODHIAPP_USERNAME'),
      password: getEnv('BODHIAPP_PASSWORD'),
    } satisfies TestState)
  );
  console.log(`[global-setup] Ready. Bodhi server at ${serverUrl}`);

  return async () => {
    if (bodhiServer) {
      await bodhiServer.stop();
      bodhiServer = null;
    }
    try {
      unlinkSync(STATE_FILE);
    } catch {
      // ignore
    }
  };
}

export default globalSetup;
