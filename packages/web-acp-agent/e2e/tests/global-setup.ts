import { existsSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { chromium } from 'playwright';
import { BodhiServerManager } from './utils/bodhi-server-manager';
import { LoginPage } from './utils/pages/admin/LoginPage';
import { ApiModelsPage } from './utils/pages/admin/ApiModelsPage';
import { acquireToken } from './utils/token-acquire';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const E2E_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(E2E_DIR, '.test-state.json');

// Distinct port from web-acp/e2e (51135) and cli-acp-client/e2e (31135).
const BODHI_SERVER_PORT = 41135;
// Must match Keycloak's registered redirect_uri for `bodhi-app-...`.
const CLI_CALLBACK_PORT = 5173;

const API_MODEL_PREFIX = 'oai/';
const API_MODEL_NAME = 'gpt-4.1-nano';
const FULL_MODEL_ID = `${API_MODEL_PREFIX}${API_MODEL_NAME}`;

const REQUIRED_ENV_VARS = [
  'BODHIAPP_CLIENT_ID',
  'BODHIAPP_CLIENT_SECRET',
  'BODHIAPP_USERNAME',
  'BODHIAPP_USERID',
  'BODHIAPP_PASSWORD',
  'BODHIAPP_AUTH_URL',
  'BODHIAPP_AUTH_REALM',
  'OPENAI_API_KEY',
];

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

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
        `Port ${port} is already in use. Stop the process bound to ${port} ` +
          `before running web-acp-agent e2e tests.`
      );
    }
  }
}

const isHeadless =
  process.env.HEADLESS === 'false'
    ? false
    : process.env.HEADLESS === 'true' || process.env.CI === 'true';

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

export async function setup(): Promise<void> {
  loadEnv({ path: path.join(E2E_DIR, '.env.test'), quiet: true });

  const missing = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables in e2e/.env.test: ${missing.join(', ')}`
    );
  }

  await assertPortsFree();

  const binPath = path.resolve(E2E_DIR, 'bin');
  if (!existsSync(binPath)) {
    throw new Error(
      `e2e/bin directory not found at ${binPath}. ` +
        `Create platform stub directories: e2e/bin/{aarch64-apple-darwin,x86_64-unknown-linux-gnu}/cpu/`
    );
  }

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

  const videoDir = path.join(E2E_DIR, 'test-results', 'global-setup');
  const browser = await chromium.launch({ headless: isHeadless });

  let setupFailed = false;
  let tokens: { accessToken: string; refreshToken?: string; expiresAt: number };

  // Step 1: admin OAuth login + register one API model. Throwaway
  // context — admin cookies collide with the access-request flow.
  const adminContext = await browser.newContext({
    recordVideo: { dir: videoDir },
    ...(isHeadless && { userAgent: buildUserAgent() }),
  });
  const adminPage = await adminContext.newPage();
  try {
    const loginPage = new LoginPage(adminPage, serverUrl, {
      username: getEnv('BODHIAPP_USERNAME'),
      password: getEnv('BODHIAPP_PASSWORD'),
    });
    await loginPage.performOAuthLogin('/ui/chat/');

    const apiModelsPage = new ApiModelsPage(adminPage, serverUrl);
    await apiModelsPage.configureApiModel(
      getEnv('OPENAI_API_KEY'),
      API_MODEL_PREFIX,
      API_MODEL_NAME
    );
  } catch (err) {
    setupFailed = true;
    const shotPath = path.join(E2E_DIR, 'test-results', 'global-setup-admin-failure.png');
    try {
      await adminPage.screenshot({ path: shotPath, fullPage: true });
      console.error(`[global-setup] admin step failure screenshot: ${shotPath}`);
      console.error(`[global-setup] admin step failure URL: ${adminPage.url()}`);
    } catch {
      // ignore
    }
    await adminContext.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
  await adminContext.close();

  // Step 2: capture a JWT via the access-request + Keycloak PKCE flow.
  const tokenContext = await browser.newContext({
    recordVideo: { dir: videoDir },
    ...(isHeadless && { userAgent: buildUserAgent() }),
  });
  try {
    const authServerUrl = `${stripTrailingSlash(getEnv('BODHIAPP_AUTH_URL'))}/realms/${getEnv('BODHIAPP_AUTH_REALM')}`;
    const bundle = await acquireToken({
      bodhiUrl: serverUrl,
      authServerUrl,
      context: tokenContext,
      credentials: {
        username: getEnv('BODHIAPP_USERNAME'),
        password: getEnv('BODHIAPP_PASSWORD'),
      },
      log: msg => console.log(`[token-acquire] ${msg}`),
    });
    tokens = {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt: bundle.expiresAt,
    };
  } catch (err) {
    setupFailed = true;
    const shotPath = path.join(E2E_DIR, 'test-results', 'global-setup-token-failure.png');
    try {
      const pages = tokenContext.pages();
      const last = pages[pages.length - 1];
      if (last) {
        await last.screenshot({ path: shotPath, fullPage: true });
        console.error(`[global-setup] token step failure screenshot: ${shotPath}`);
        console.error(`[global-setup] token step failure URL: ${last.url()}`);
      }
    } catch {
      // ignore
    }
    await tokenContext.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
  await tokenContext.close();
  await browser.close();
  if (!setupFailed && existsSync(videoDir)) {
    rmSync(videoDir, { recursive: true, force: true });
  }

  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        bodhiServerUrl: serverUrl,
        username: getEnv('BODHIAPP_USERNAME'),
        password: getEnv('BODHIAPP_PASSWORD'),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        modelId: FULL_MODEL_ID,
        modelName: API_MODEL_NAME,
      },
      null,
      2
    )
  );
  console.log(`[global-setup] Ready. Bodhi server at ${serverUrl}, model=${FULL_MODEL_ID}`);
}

export async function teardown(): Promise<void> {
  if (bodhiServer) {
    try {
      await bodhiServer.stop();
    } catch (err) {
      console.warn('[global-setup] BodhiServerManager.stop() failed:', err);
    }
    bodhiServer = null;
  }
  try {
    unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
  // BodhiApp's NAPI binding leaves native-owned file handles open
  // after `stop()` resolves; force exit so vitest doesn't sit on the
  // 10 s teardown watchdog.
  setImmediate(() => process.exit(process.exitCode ?? 0));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}
