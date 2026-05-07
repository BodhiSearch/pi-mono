import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const STATE_FILE = path.resolve(__dirname, '..', '.test-state.json');

export interface TestState {
  bodhiServerUrl: string;
  username: string;
  password: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  modelId: string;
  modelName: string;
}

export function loadTestState(): TestState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      `[e2e] .test-state.json not found at ${STATE_FILE}. ` +
        `Did vitest globalSetup run? Try \`npm run test:e2e\` from packages/web-acp-agent/.`
    );
  }
  const raw = readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(raw) as TestState;
}
