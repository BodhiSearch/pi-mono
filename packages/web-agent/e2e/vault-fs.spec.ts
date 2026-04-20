import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('Vault mount — M2', () => {
  test('seeded vault mounts and lists its files in the side panel', async ({ page }) => {
    const { bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);

    await test.step('install seeded vault before page load', async () => {
      await installVault(page, 'sample');
    });

    await test.step('load app and dismiss the Bodhi setup overlay', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
    });

    await test.step('vault status badge reports mounted', async () => {
      await vault.waitForMounted();
    });

    await test.step('vault name reflects the seeded fixture', async () => {
      await vault.expectName('sample');
    });

    await test.step('seeded files appear in the file tree', async () => {
      await vault.waitForFile('/vault/README.md');
      await vault.waitForFile('/vault/src/hello.ts');
      await vault.waitForFile('/vault/docs/note.txt');
    });

    await test.step('opening a seeded file shows its contents in the viewer', async () => {
      await vault.openFile('/vault/README.md');
      // README.md renders through Milkdown — `# Sample vault` in source
      // becomes a rendered <h1>Sample vault</h1>, so the visible text is
      // just the heading without the `#` prefix.
      expect((await vault.currentFileContent()).trim()).toBe('Sample vault');
    });
  });
});

test.describe('FS tools round-trip — M3', () => {
  test('agent uses read and write tools against the seeded vault', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);

    await test.step('install seeded vault', async () => {
      await installVault(page, 'sample');
    });

    await test.step('load app and wait for server + vault', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
      await vault.waitForMounted();
    });

    await test.step('authenticate and select a model', async () => {
      await chat.login({ username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
    });

    await test.step('ask the agent to read a vault file and write a derived one', async () => {
      await chat.send(
        'Use the read tool to read the file at /vault/README.md. ' +
          'Then use the write tool to create /vault/summary.txt containing exactly ' +
          'the four characters: ok!!. Do not add any other content to that file. ' +
          'When both tool calls are done, reply with just the word "done".'
      );
      await chat.waitForAssistantTurn(0);
    });

    await test.step('both tool-call bubbles rendered', async () => {
      await expect(chat.toolCall('read')).toBeVisible();
      await expect(chat.toolCall('write')).toBeVisible();
    });

    await test.step('the new file shows up in the side panel', async () => {
      await vault.waitForFile('/vault/summary.txt');
    });

    await test.step('opening it in the viewer reveals the expected content', async () => {
      await vault.openFile('/vault/summary.txt');
      expect(await vault.currentFileContent()).toBe('ok!!');
    });
  });
});
