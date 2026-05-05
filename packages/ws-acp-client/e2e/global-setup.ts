import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium, type FullConfig } from '@playwright/test';
import { BodhiServerManager } from './utils/bodhi-server-manager';
import {
  EverythingMcpManager,
  EVERYTHING_MCP_PORT,
  EVERYTHING_MCP_URL,
} from './utils/everything-mcp-manager';
import { startWsAcpServer, type WsServerHandle } from './utils/ws-server-manager';
import { LoginPage } from './pages/admin/LoginPage';
import { ApiModelsPage } from './pages/admin/ApiModelsPage';
import { McpsPage } from './pages/admin/McpsPage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const E2E_DIR = path.resolve(__dirname);
const PKG_DIR = path.resolve(E2E_DIR, '..');
export const STATE_FILE = path.join(E2E_DIR, '.test-state.json');

export interface TestState {
  bodhiServerUrl: string;
  username: string;
  password: string;
  /** ws://host:port for the spawned ws-acp-client server. */
  wsUrl: string;
  /** Agent working directory backing the cwd PassthroughFS volume. */
  cwd: string;
  /** Fully-qualified Bodhi API model id ("oai/<name>") provisioned in setup. */
  modelId: string;
  /** Display name (without prefix) — handy for ModelPicker option matching. */
  modelName: string;
  /**
   * User-facing slug for the seeded "everything" MCP instance on Bodhi.
   * acp-ui matches against this in `_bodhi/mcp/state` notifications and
   * the e2e asserts `mcp-server-<slug>` is rendered.
   */
  mcpEverythingSlug: string;
  /** Streamable-HTTP URL of the local everything-mcp fixture (for `/mcp add`). */
  mcpEverythingUrl: string;
}

export function getTestState(): TestState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as TestState;
}

export const isHeadless =
  process.env.HEADLESS === 'false'
    ? false
    : process.env.HEADLESS === 'true' || process.env.CI === 'true';

// Must match the redirect_uri whitelisted in Keycloak for the shared
// `bodhi-resource-…` client. web-acp uses 51135 too — change here only
// if you've updated Keycloak's client config.
export const BODHI_SERVER_PORT = 51135;
export const BODHI_DEFAULT_PORT = 1135;
export const BODHI_SERVER_URL = `http://localhost:${BODHI_SERVER_PORT}`;

// Single API model provisioned for Phase 3+ prompt round-trips. Matches
// web-acp's choice (small + cheap + reliable) so the same OpenAI key
// works for both packages.
export const API_MODEL_PREFIX = 'oai/';
export const API_MODEL_NAME = 'gpt-5.4-mini';
export const FULL_MODEL_ID = `${API_MODEL_PREFIX}${API_MODEL_NAME}`;

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
  const portsToCheck = [BODHI_SERVER_PORT, BODHI_DEFAULT_PORT, EVERYTHING_MCP_PORT];
  for (const port of portsToCheck) {
    if (await isPortInUse(port)) {
      throw new Error(
        `Port ${port} is already in use. Stop the server running on port ${port} before running the tests.`
      );
    }
  }
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
let wsServer: WsServerHandle | null = null;
let everythingMcp: EverythingMcpManager | null = null;

// Bodhi-side server + instance names for the seeded reference MCP.
// `MCP_EVERYTHING_INSTANCE_SLUG` is the slug the `/mcp add` flow + the
// agent's MCP pool surface back to acp-ui via `_bodhi/mcp/state`.
export const MCP_EVERYTHING_SERVER_NAME = 'ws-acp-everything';
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

  // Start the local "everything" MCP fixture before we attempt to
  // register it on the Bodhi side — Bodhi probes the server URL on
  // create. CI runs are noisier so we surface the child's stdout.
  everythingMcp = new EverythingMcpManager({ logToStdout: !!process.env.CI });
  await everythingMcp.start();

  // Provision the admin user against the booted server. Without this,
  // the server's `/bodhi/v1/info` reports "not in ready state" because
  // no resource-admin has authenticated yet — and bodhi-js refuses to
  // proceed with `requestAccess` until the server is ready.
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

    // Provision a single OpenAI-backed API model so the agent's
    // `bodhi/v1/models` endpoint returns at least one entry once
    // acp-ui pushes a token. Without this the model picker stays
    // empty and the prompt journey can't reach `streaming`.
    const apiModelsPage = new ApiModelsPage(page, serverUrl);
    await apiModelsPage.configureApiModel(
      getEnv('OPENAI_API_KEY'),
      API_MODEL_PREFIX,
      API_MODEL_NAME
    );

    // MCP bootstrap (Phase 10): register the local "everything" reference
    // server on the Bodhi side so that when acp-ui's `/mcp add <url>`
    // flow re-authenticates with the new scope, Bodhi already has a
    // matching server + public instance to surface as Connected.
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
      'Public everything MCP instance — seeded by ws-acp-client global-setup'
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

  // Boot the ws-acp-client process under test. We use a fresh temp dir
  // as its `$cwd` so tests see an empty PassthroughFS volume each run;
  // the dir (and its `.ws-acp-client/state.db`) are deleted at teardown.
  wsServer = await startWsAcpServer({
    packageDir: PKG_DIR,
    port: 0,
    host: '127.0.0.1',
    verbose: false,
  });
  console.log(`[global-setup] ws-acp-client at ${wsServer.url} (cwd=${wsServer.cwd})`);

  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        bodhiServerUrl: serverUrl,
        username: getEnv('BODHIAPP_USERNAME'),
        password: getEnv('BODHIAPP_PASSWORD'),
        wsUrl: wsServer.url,
        cwd: wsServer.cwd,
        modelId: FULL_MODEL_ID,
        modelName: API_MODEL_NAME,
        mcpEverythingSlug: MCP_EVERYTHING_INSTANCE_SLUG,
        mcpEverythingUrl: EVERYTHING_MCP_URL,
      } satisfies TestState,
      null,
      2
    )
  );
  console.log(`[global-setup] Ready. Bodhi server at ${serverUrl}`);

  return async () => {
    if (wsServer) {
      try {
        await wsServer.stop();
      } catch (err) {
        console.warn('[global-setup] ws-acp-client.stop() failed:', err);
      }
      wsServer = null;
    }
    if (everythingMcp) {
      try {
        await everythingMcp.stop();
      } catch (err) {
        console.warn('[global-setup] everything-mcp.stop() failed:', err);
      }
      everythingMcp = null;
    }
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
