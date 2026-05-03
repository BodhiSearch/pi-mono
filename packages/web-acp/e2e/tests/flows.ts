import type { Page } from '@playwright/test';
import { installVolumes, type VolumeSeedSpec } from '../helpers/install-volumes';
import { getTestState } from './global-setup';
import type { AppFixtures } from './fixtures';

export interface AppReadyOptions {
  selectModel?: string;
  acceptMcps?: string[];
}

type ReadyDeps = { page: Page } & Pick<AppFixtures, 'setup' | 'status' | 'auth' | 'chat'>;
type VolumesReadyDeps = ReadyDeps & Pick<AppFixtures, 'volumes'>;

/**
 * Boot the app to "ready + authenticated + (optionally) model selected".
 * Walks the setup overlay if it shows up, waits for client/server badges,
 * runs OAuth, optionally accepts MCP scopes, waits for the model picker
 * to finish loading, and selects one. Replaces the per-spec login
 * boilerplate.
 */
export async function appReady(
  deps: ReadyDeps,
  opts: AppReadyOptions = {}
): Promise<{ bodhiServerUrl: string }> {
  const state = getTestState();
  await deps.page.goto('/');
  await deps.setup.walkIfPresent(state.bodhiServerUrl);
  await deps.status.waitReady();
  await deps.auth.login(
    { username: state.username, password: state.password },
    { acceptMcps: opts.acceptMcps }
  );
  await deps.chat.waitForModelsLoaded();
  if (opts.selectModel) {
    await deps.chat.selectModel(opts.selectModel);
  }
  return { bodhiServerUrl: state.bodhiServerUrl };
}

export async function appReadyWithVolumes(
  deps: VolumesReadyDeps,
  seeds: VolumeSeedSpec[],
  opts: AppReadyOptions = {}
): Promise<{ bodhiServerUrl: string }> {
  await installVolumes(deps.page, seeds);
  const ready = await appReady(deps, opts);
  await deps.volumes.waitForCount(seeds.length);
  return ready;
}

/**
 * Boot the app authenticated WITHOUT any MCP scopes; tests that drive
 * `/mcp add <url>` use this and walk re-auth themselves to assert the
 * full add path through the UI.
 */
export async function appReadyWithoutMcps(
  deps: ReadyDeps,
  opts: AppReadyOptions = {}
): Promise<{ bodhiServerUrl: string }> {
  return appReady(deps, { ...opts, acceptMcps: [] });
}

/**
 * After reload, the user remains logged in (Bodhi tokens persist). Wait
 * for the badges and authenticated section without re-running OAuth.
 */
export async function appReloadReady(
  deps: Pick<ReadyDeps, 'page' | 'setup' | 'status'>
): Promise<void> {
  const state = getTestState();
  await deps.setup.walkIfPresent(state.bodhiServerUrl);
  await deps.status.waitReady();
  await deps.status.expectAuthenticated();
}
