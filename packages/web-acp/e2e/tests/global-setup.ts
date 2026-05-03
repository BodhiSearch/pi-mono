import { chromium, FullConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { readFileSync, unlinkSync, writeFileSync, existsSync, rmSync } from 'fs';
import { createConnection } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BodhiServerManager } from './utils/bodhi-server-manager';
import {
  EverythingMcpManager,
  EVERYTHING_MCP_PORT,
  EVERYTHING_MCP_URL,
} from './utils/everything-mcp-manager';
import { LoginPage } from './pages/admin/LoginPage';
import { ApiModelsPage } from './pages/admin/ApiModelsPage';
import { McpsPage } from './pages/admin/McpsPage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const E2E_DIR = path.resolve(__dirname, '..');
export const STATE_FILE = path.join(E2E_DIR, '.test-state.json');

export interface TestState {
  bodhiServerUrl: string;
  username: string;
  password: string;
  mcpEverythingSlug: string;
  mcpEverythingUrl: string;
}

export function getTestState(): TestState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

export const isHeadless =
  process.env.HEADLESS === 'false'
    ? false
    : process.env.HEADLESS === 'true' || process.env.CI === 'true';

export const BODHI_SERVER_PORT = 51135;
export const BODHI_DEFAULT_PORT = 1135;
export const BODHI_SERVER_URL = `http://localhost:${BODHI_SERVER_PORT}`;
export const API_MODEL_PREFIX = 'oai/';
export const API_MODEL_NAME = 'gpt-5.4-mini';
export const FULL_MODEL_ID = `${API_MODEL_PREFIX}${API_MODEL_NAME}`;

export const ANTHROPIC_API_MODEL_PREFIX = 'anthropic/';
export const ANTHROPIC_API_MODEL_NAME = 'claude-haiku-4-5-20251001';
export const SECOND_FULL_MODEL_ID = `${ANTHROPIC_API_MODEL_PREFIX}${ANTHROPIC_API_MODEL_NAME}`;

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
  const portsToCheck = [BODHI_SERVER_PORT, BODHI_DEFAULT_PORT, EVERYTHING_MCP_PORT];
  for (const port of portsToCheck) {
    if (await isPortInUse(port)) {
      throw new Error(
        `Port ${port} is already in use. Stop the server running on port ${port} before running the tests.`
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
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
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
      `e2e/bin directory not found. Create it with a platform stub: e2e/bin/{arch}-{os}/{variant}/`
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
let everythingMcp: EverythingMcpManager | null = null;

export const MCP_EVERYTHING_SERVER_NAME = 'web-acp-everything';
export const MCP_EVERYTHING_INSTANCE_NAME = 'Everything MCP';
export const MCP_EVERYTHING_INSTANCE_SLUG = 'everything';

async function globalSetup(_: FullConfig) {
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

  everythingMcp = new EverythingMcpManager({ logToStdout: !!process.env.CI });
  await everythingMcp.start();

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

    const apiModelsPage = new ApiModelsPage(page, serverUrl);
    await apiModelsPage.configureApiModel(
      getEnv('OPENAI_API_KEY'),
      API_MODEL_PREFIX,
      API_MODEL_NAME
    );
    await apiModelsPage.configureApiModel(
      getEnv('ANTHROPIC_API_KEY'),
      ANTHROPIC_API_MODEL_PREFIX,
      ANTHROPIC_API_MODEL_NAME,
      'anthropic'
    );

    // MCP bootstrap for M3 Phase A: register the local "everything"
    // reference server on the Bodhi side so the user-facing app gets a
    // live instance with a real upstream when the web-acp login flow
    // runs `LoginOptionsBuilder.addMcpServer(...)` against it.
    const mcpsPage = new McpsPage(page, serverUrl);
    await mcpsPage.createMcpServer(
      everythingMcp!.getUrl(),
      MCP_EVERYTHING_SERVER_NAME,
      'everything MCP reference server (e2e fixture)'
    );
    await mcpsPage.createMcpInstance(
      MCP_EVERYTHING_SERVER_NAME,
      MCP_EVERYTHING_INSTANCE_NAME,
      MCP_EVERYTHING_INSTANCE_SLUG,
      'Public everything MCP instance — seeded by web-acp global-setup'
    );
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
      mcpEverythingSlug: MCP_EVERYTHING_INSTANCE_SLUG,
      mcpEverythingUrl: EVERYTHING_MCP_URL,
    } satisfies TestState)
  );
  console.log(`[global-setup] Ready. Bodhi server at ${serverUrl}`);

  return async () => {
    if (bodhiServer) {
      await bodhiServer.stop();
      bodhiServer = null;
    }
    if (everythingMcp) {
      await everythingMcp.stop();
      everythingMcp = null;
    }
    try {
      unlinkSync(STATE_FILE);
    } catch {
      // ignore
    }
  };
}

export default globalSetup;
