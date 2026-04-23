import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installVolumes } from './helpers/install-volumes';

test.describe('Feature toggles', () => {
  test('bashEnabled off suppresses tool registration for the next turn', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    await installVolumes(page, [
      {
        name: 'wiki',
        files: { '/marker.txt': 'BODHI-M2-FEATURES' },
      },
    ]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await page.locator('[data-testid="volumes-panel"][data-teststate="1"]').waitFor();
    // Turning bashEnabled off should drop the tool from the next
    // `prompt` turn; we assert no tool-call DOM node appears.
    const bashToggle = page.locator('[data-testid="feature-toggle-bashEnabled"]');
    await bashToggle.waitFor();
    await bashToggle.click();
    await page.locator('[data-testid="feature-row-bashEnabled"][data-teststate="off"]').waitFor();

    await chat.send('Reply with the single word "noop".');
    await chat.waitForAssistantTurn(0);
    const toolCalls = await page.locator('[data-testid^="tool-call-"]').count();
    expect(toolCalls).toBe(0);
  });

  test('forceToolCall is DEV-only and hidden in production builds', async ({ page }) => {
    // The vite build served by the dev server sets __WEB_ACP_DEV__
    // to true; `FeaturePanel` shows the DEV row. A production
    // serving would have it absent. We test the positive (DEV)
    // presence here so the ui/testid contract stays pinned; the
    // negative (prod) variant ships as a deferred check (the DEV
    // guard in `_bodhi/features/set` is covered by unit tests).
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();

    await page.locator('[data-testid="feature-row-forceToolCall"]').waitFor({ timeout: 10000 });
  });
});
