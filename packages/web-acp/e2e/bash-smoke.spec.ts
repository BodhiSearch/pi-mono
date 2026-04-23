import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installVolumes } from './helpers/install-volumes';

test.describe('bash tool smoke', () => {
  test.setTimeout(90_000);
  test('agent issues a bash tool call that reads from /mnt/wiki', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    await installVolumes(page, [
      {
        name: 'wiki',
        description: 'knowledge base',
        files: {
          '/marker.txt': 'BODHI-M2-SMOKE',
        },
      },
    ]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await page.locator('[data-testid="volumes-panel"][data-teststate="1"]').waitFor();
    // forceToolCall is DEV-only and on-by-default only when the user
    // flips it. Turn it on so the smoke test doesn't depend on the
    // model choosing to call the tool.
    const forceToggle = page.locator('[data-testid="feature-toggle-forceToolCall"]');
    if (await forceToggle.isVisible()) {
      await forceToggle.click();
      await page
        .locator('[data-testid="feature-row-forceToolCall"][data-teststate="on"]')
        .waitFor();
    }

    await chat.send(
      'Use the bash tool. Run `cat /mnt/wiki/marker.txt` and respond with the file contents.'
    );

    await page.locator('[data-testid^="tool-call-"]').first().waitFor({ timeout: 30000 });
    await page
      .locator('[data-testid^="tool-call-"][data-teststate="completed"]')
      .first()
      .waitFor({ timeout: 30000 });

    await chat.waitForAssistantTurn(0);
    const reply = await chat.getAssistantText(0);
    expect(reply).toContain('BODHI-M2-SMOKE');
  });
});
