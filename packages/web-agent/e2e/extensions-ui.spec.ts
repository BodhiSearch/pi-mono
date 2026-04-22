import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

/**
 * Extensions (M8 — Phase 2a).
 *
 * The `sample-with-extensions` vault seeds five additional extensions
 * under `/vault/.pi/extensions/` that cover the new Phase 2a surface:
 *
 *   - asker           — drives every `pi.ui.*` dialog kind + status chip.
 *   - notifier        — exercises `on('turn_start')` / `on('message_end')`
 *                       and `pi.ui.notify` mapping to info / warning / error.
 *   - context-injector— exercises `on('context')` + the `/ctx-show` command.
 *   - reload-observer — exercises `on('session_loaded')` on `/reload`.
 *
 * Every assertion targets DOM state (sonner toasts, dialog testids,
 * status chips) or the observable count exposed through a companion
 * slash command so we don't have to trust LLM output.
 */
test.describe('Extensions — Phase 2a (context + UI channel)', () => {
  test('pi.ui.* dialogs round-trip, status chips toggle, observer hooks fire', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);

    const toast = (substr: string) =>
      page.locator('[data-sonner-toast]').filter({ hasText: substr });
    const typedToast = (kind: 'info' | 'warning' | 'error', substr: string) =>
      page.locator(`[data-sonner-toast][data-type="${kind}"]`).filter({ hasText: substr });

    await test.step('install vault with seeded extensions', async () => {
      await installVault(page, 'sample-with-extensions');
    });

    await test.step('load app, authenticate, pick a model', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
      await vault.waitForMounted();
      await chat.login({ username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
    });

    // ------------------------------------------------------------------
    // All Phase 2a fixtures show up in the ExtensionsPanel. We verify
    // enablement once here so every following step can assume the
    // handlers are actually live.
    // ------------------------------------------------------------------
    await test.step('Phase 2a fixtures are discovered and enabled', async () => {
      await page.locator('[data-testid="extensions-popover-trigger"]').click();
      for (const name of ['asker', 'notifier', 'context-injector', 'reload-observer']) {
        const row = page.locator(`[data-testid="extensions-row-${name}"]`);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute('data-test-state', 'enabled');
      }
      await page.keyboard.press('Escape');
    });

    // ------------------------------------------------------------------
    // `pi.ui.notify` → sonner. The renderer maps info / warning / error
    // to sonner's typed toasts; `data-type` carries the discriminator.
    // ------------------------------------------------------------------
    await test.step('notify maps info / warning / error to sonner', async () => {
      for (const kind of ['info', 'warning', 'error'] as const) {
        await chat.send(`/notify-test ${kind}`);
        await expect(typedToast(kind, `notifier: ${kind} message`).first()).toBeVisible();
      }
    });

    // ------------------------------------------------------------------
    // `pi.ui.setStatus` → chip in the ChatInput footer. Text updates
    // replace the chip; `null` removes it entirely.
    // ------------------------------------------------------------------
    await test.step('setStatus adds and removes a status chip', async () => {
      await chat.send('/ask-status working');
      const chip = page.locator(
        '[data-testid="extension-status-chip"][data-extension-path*="asker"]'
      );
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('working');

      await chat.send('/ask-status clear');
      await expect(chip).toHaveCount(0);
    });

    // ------------------------------------------------------------------
    // `pi.ui.confirm` — dialog opens, user picks Confirm, extension
    // receives `true`, a follow-up toast verifies the value.
    // ------------------------------------------------------------------
    await test.step('confirm dialog round-trips true through the worker', async () => {
      await chat.send('/ask-confirm');
      const dialog = page.locator('[data-testid="extension-ui-dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-testid="extension-dialog-title"]')).toContainText(
        'Proceed?'
      );
      await dialog.locator('[data-testid="extension-dialog-confirm"]').click();
      await expect(dialog).toHaveCount(0);
      await expect(toast('asker: confirm returned true').first()).toBeVisible();
    });

    // ------------------------------------------------------------------
    // `pi.ui.confirm` cancel path — explicit Cancel click resolves with
    // false.
    // ------------------------------------------------------------------
    await test.step('confirm dialog cancel resolves with false', async () => {
      await chat.send('/ask-confirm');
      const dialog = page.locator('[data-testid="extension-ui-dialog"]');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-testid="extension-dialog-cancel"]').click();
      await expect(dialog).toHaveCount(0);
      await expect(toast('asker: confirm returned false').first()).toBeVisible();
    });

    // ------------------------------------------------------------------
    // `pi.ui.select` — each option carries an index-keyed testid so the
    // test can pick deterministically without reading labels.
    // ------------------------------------------------------------------
    await test.step('select dialog returns the chosen value', async () => {
      await chat.send('/ask-select');
      const dialog = page.locator('[data-testid="extension-ui-dialog"]');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-testid="extension-dialog-option-1"]').click();
      await expect(dialog).toHaveCount(0);
      await expect(toast('asker: select returned green').first()).toBeVisible();
    });

    // ------------------------------------------------------------------
    // `pi.ui.input` — typed text round-trips back through the worker.
    // ------------------------------------------------------------------
    await test.step('input dialog round-trips the typed value', async () => {
      await chat.send('/ask-input');
      const dialog = page.locator('[data-testid="extension-ui-dialog"]');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-testid="extension-dialog-input"]').fill('Alice');
      await dialog.locator('[data-testid="extension-dialog-submit"]').click();
      await expect(dialog).toHaveCount(0);
      await expect(toast('asker: input returned Alice').first()).toBeVisible();
    });

    // ------------------------------------------------------------------
    // `on('session_loaded')` — Phase 2a fires on `/reload` only. We
    // verify the count increments after a single reload invocation.
    // ------------------------------------------------------------------
    await test.step('session_loaded hook fires on /reload', async () => {
      await chat.send('/reload-count');
      await expect(toast('reload-observer: count=0').first()).toBeVisible();

      await chat.send('/reload');
      await chat.send('/reload-count');
      await expect(toast('reload-observer: count=1').first()).toBeVisible();
    });

    // ------------------------------------------------------------------
    // `/ctx-show` — the hook hasn't fired yet (no LLM turn has run), so
    // both counters stay at zero. The test mainly proves the command
    // surfaces the extension-internal state, i.e. the factory ran and
    // `on('context')` is live waiting to be dispatched.
    // ------------------------------------------------------------------
    await test.step('context hook command surfaces observer counters', async () => {
      await chat.send('/ctx-show');
      await expect(toast('context hook: in=0 out=0').first()).toBeVisible();
    });
  });
});
