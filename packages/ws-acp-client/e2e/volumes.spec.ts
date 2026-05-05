import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 7 gate. Validates the multi-volume CLI flag end-to-end:
//
//   1. ws-acp-client spawned with `--volume code=<tmp>` exposes a
//      second mount alongside the auto-mounted `/mnt/cwd`.
//   2. acp-ui's VolumesPanel calls `_bodhi/volumes/list` on session
//      ready and renders both rows (sorted by host order: `cwd` then
//      `code`). `data-test-state="2"` on the panel root.
//   3. A real prompt that asks the bash tool to `cat /mnt/code/<file>`
//      reads the seeded beacon — proves the mount is wired all the
//      way through PassthroughFS, not just listed cosmetically.
//
// We spawn a per-spec ws-acp-client (the global one has no extra
// volumes) so this test is self-contained. ~1 LLM call,
// ~25-45s on a warm laptop.
test.describe('acp-ui ↔ ws-acp-client multi-volume mounts', () => {
  const BEACON = 'PHASE7_VOLUME_BEACON_Q73';
  let extraVolumeDir = '';
  let ws: ReturnType<typeof createPerSpecWsServer> | null = null;

  test.beforeAll(async () => {
    // Pre-mkdtemp the host-side directory we'll expose as `code`
    // BEFORE the per-spec ws-acp-client starts so the path is
    // available for the `--volume` flag.
    extraVolumeDir = mkdtempSync(path.join(tmpdir(), 'ws-acp-vol-code-'));
    mkdirSync(extraVolumeDir, { recursive: true });
    writeFileSync(path.join(extraVolumeDir, 'beacon.txt'), `${BEACON}\n`, 'utf8');

    ws = createPerSpecWsServer({
      volumes: [{ name: 'code', path: extraVolumeDir }],
    });
    await ws.start();
  });

  test.afterAll(async () => {
    if (ws) {
      await ws.stop();
      ws = null;
    }
    if (extraVolumeDir) {
      try {
        rmSync(extraVolumeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      extraVolumeDir = '';
    }
  });

  test('VolumesPanel lists cwd + code, bash reads /mnt/code beacon', async ({ page }) => {
    if (!ws) throw new Error('per-spec ws-acp-client not initialised');
    const wsServer = ws;
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);

    const AGENT_NAME = 'E2E-WS-VOL';

    await test.step('Setup: login, configure Bodhi server, add volumes-aware WS agent', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();

      await settings.open();
      await settings.setBodhiServerUrl(state.bodhiServerUrl);
      await settings.close();

      await auth.login({ username: state.username, password: state.password });
      await auth.expectAuthenticated();

      await settings.open();
      await settings.addAgent({
        name: AGENT_NAME,
        transport: 'websocket',
        url: wsServer.url,
      });
      await settings.close();

      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(wsServer.cwd);
    });

    await test.step('New session — VolumesPanel shows /mnt/cwd + /mnt/code', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);

      const panel = page.locator('[data-testid="section-volumes"]');
      // The panel only mounts after a successful connect. data-test-state
      // is the count of mounts (cwd + code = 2).
      await expect(panel).toHaveAttribute('data-test-state', '2');

      // Both rows present, by mount name. Order is host-defined (cwd
      // first because it's auto-mounted before extras).
      await expect(page.locator('[data-testid="row-volume-cwd"]')).toBeVisible();
      await expect(page.locator('[data-testid="row-volume-code"]')).toBeVisible();
      await expect(page.locator('[data-testid="row-volume-code"]')).toHaveAttribute(
        'data-test-mount',
        'code'
      );
    });

    await test.step('Bash tool reads /mnt/code/beacon.txt — beacon visible in transcript', async () => {
      await chat.send(
        `Use the bash tool to read the file /mnt/code/beacon.txt and output its exact contents.`
      );
      await chat.expectState('idle');
      // The agent either echoes the file contents in an assistant
      // bubble or surfaces them via a tool-call summary; either way
      // the beacon must appear somewhere in the rendered messages.
      await expect(chat.messages.last()).toContainText(BEACON);
    });
  });
});
