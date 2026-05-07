import type { BrowserContext } from 'playwright';
import { runLoginFlow } from './auth/login-flow';
import type { TokenBundle } from './auth/types';
import { driveOAuthFlow } from './auth-driver';

export interface AcquireTokenOptions {
  bodhiUrl: string;
  authServerUrl: string;
  context: BrowserContext;
  credentials: { username: string; password: string };
  log?: (message: string) => void;
}

export async function acquireToken(opts: AcquireTokenOptions): Promise<TokenBundle> {
  const log = opts.log ?? (() => {});

  // The Playwright walk runs in parallel with runLoginFlow: opener.open
  // returns immediately so the callback server's awaitNext can read
  // each Phase 1/2 hit while the browser is still navigating.
  let driverPromise: Promise<void> = Promise.resolve();
  let driverError: unknown;

  const result = await runLoginFlow({
    bodhiUrl: opts.bodhiUrl,
    authServerUrl: opts.authServerUrl,
    log,
    opener: {
      open: async (url: string) => {
        driverPromise = driveOAuthFlow({
          context: opts.context,
          reviewUrl: url,
          credentials: opts.credentials,
          log: msg => log(`[auth-driver] ${msg}`),
        }).catch(err => {
          driverError = err;
          throw err;
        });
      },
    },
  });

  await driverPromise.catch(() => {});
  if (driverError && !result) {
    throw driverError;
  }

  return result.tokens;
}
