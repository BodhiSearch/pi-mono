import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installVolumes } from './helpers/install-volumes';

test.describe('Multi-volume mount', () => {
  test('seeds show up in the panel and reach the LLM system prompt', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    await installVolumes(page, [
      {
        name: 'wiki',
        description: 'knowledge base',
        files: {
          '/hello.md': '# hello\nknowledge base content',
          '/notes/a.md': '# notes\nentry a',
        },
      },
      {
        name: 'code',
        files: { '/readme.txt': 'code readme' },
      },
    ]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await page.locator('[data-testid="volumes-panel"][data-test-state="2"]').waitFor();
    await page.locator('[data-testid="volume-row-wiki"][data-test-state="mounted"]').waitFor();
    await page.locator('[data-testid="volume-row-code"][data-test-state="mounted"]').waitFor();

    // Remove the 'code' volume — panel should drop to 1.
    await page.locator('[data-testid="btn-remove-volume-code"]').click();
    await page.locator('[data-testid="volumes-panel"][data-test-state="1"]').waitFor();

    // Reload — seeds are injected before page boot so volumes come back.
    await page.reload();
    await chat.waitServerReady(bodhiServerUrl);
    await page.locator('[data-testid="section-auth"][data-test-state="authenticated"]').waitFor();
    await page.locator('[data-testid="volumes-panel"][data-test-state="2"]').waitFor();

    await chat.selectModel(FULL_MODEL_ID);
    await chat.send(
      'The system prompt lists the volumes mounted on this agent. Reply with the single mount name that holds the knowledge base.'
    );
    await chat.waitForAssistantTurn(0);
    const reply = await chat.getAssistantText(0);
    expect(reply.toLowerCase()).toMatch(/wiki|knowledge/);
  });
});
