import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { BodhiServerManager } from '../utils/bodhi-server-manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const E2E_DIR = path.resolve(__dirname, '../..');

loadEnv({ path: path.join(E2E_DIR, '.env.test'), quiet: true });

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
}

const server = new BodhiServerManager({
  port: 51135,
  host: 'localhost',
  appStatus: 'ready',
  createdBy: need('BODHIAPP_USERID'),
  authUrl: need('BODHIAPP_AUTH_URL'),
  authRealm: need('BODHIAPP_AUTH_REALM'),
  clientId: need('BODHIAPP_CLIENT_ID'),
  clientSecret: need('BODHIAPP_CLIENT_SECRET'),
  binPath: path.resolve(E2E_DIR, 'bin'),
  logLevel: 'debug',
  logToStdout: true,
});

const url = await server.start();
console.log(`[start-server] ${url}`);
// Keep the process alive until SIGINT / SIGTERM.
setInterval(() => {}, 1 << 30);

async function shutdown() {
  console.log('[start-server] stopping...');
  await server.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
