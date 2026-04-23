import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

/**
 * Extensions (M8 — Phase 2b).
 *
 * The `sample-with-extensions` vault ships six Phase 2b fixtures on top
 * of the Phase 2a set:
 *
 *   - title-marker     — `pi.ui.setTitle` on session_loaded + slash cmds.
 *   - progress-widget  — `pi.ui.setWidget` for the three widget kinds.
 *   - note-editor      — `pi.ui.editor` + `pi.ui.setEditorText`.
 *   - echo-provider    — `pi.registerProvider` adds a fake provider.
 *   - compaction-nudger— `on('before_compact')` / `on('after_compact')`.
 *   - skill-nudge      — `pi.registerSkill` contributes two skills.
 *
 * Every assertion hits DOM (`data-testid` + `data-*` attributes), RPC-
 * visible state (model picker catalog, slash palette), or sonner toasts
 * that the extensions drive directly. Zero LLM-text assertions.
 */
test.describe('Extensions — Phase 2b (UI verbs + providers + skills + compaction)', () => {
  test('title / widget / editor / provider / skill / compaction hooks all wire up', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);

    const toast = (substr: string) =>
      page.locator('[data-sonner-toast]').filter({ hasText: substr });

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

    await test.step('Phase 2b fixtures are discovered and enabled', async () => {
      await page.locator('[data-testid="extensions-popover-trigger"]').click();
      for (const name of [
        'title-marker',
        'progress-widget',
        'note-editor',
        'echo-provider',
        'compaction-nudger',
        'skill-nudge',
      ]) {
        const row = page.locator(`[data-testid="extensions-row-${name}"]`);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute('data-test-state', 'enabled');
      }
      await page.keyboard.press('Escape');
    });

    // ------------------------------------------------------------------
    // `pi.ui.setTitle` — slash-driven mutation surfaces in the header
    // slot. We avoid asserting on session_loaded because initial-mount
    // timing races the `page.goto()`.
    // ------------------------------------------------------------------
    await test.step('setTitle toggles the chat-header slot via slash commands', async () => {
      await chat.send('/title-set hello-2b');
      const titleChip = page.locator(
        '[data-testid="extension-title"][data-extension-path*="title-marker"]'
      );
      await expect(titleChip).toBeVisible();
      await expect(titleChip).toContainText('hello-2b');

      await chat.send('/title-clear');
      await expect(titleChip).toHaveCount(0);
    });

    // ------------------------------------------------------------------
    // `pi.ui.setWidget` — three widget kinds in the transcript area.
    // The bubble carries `data-widget-kind` so the test never reads
    // the LLM-facing text.
    // ------------------------------------------------------------------
    await test.step('setWidget renders progress | info | choice widgets and clears', async () => {
      const widget = page.locator(
        '[data-testid="extension-widget"][data-extension-path*="progress-widget"]'
      );

      await chat.send('/progress-show progress');
      await expect(widget).toHaveAttribute('data-widget-kind', 'progress');
      await expect(widget.locator('[data-testid="extension-widget-progress-bar"]')).toHaveAttribute(
        'data-ratio',
        '0.42'
      );

      await chat.send('/progress-show info');
      await expect(widget).toHaveAttribute('data-widget-kind', 'info');
      await expect(widget.locator('[data-testid="extension-widget-info-title"]')).toContainText(
        'progress-widget info'
      );

      await chat.send('/progress-show choice');
      await expect(widget).toHaveAttribute('data-widget-kind', 'choice');
      await expect(widget.locator('[data-testid="extension-widget-choice-option"]')).toHaveCount(2);

      await chat.send('/progress-clear');
      await expect(widget).toHaveCount(0);
    });

    // ------------------------------------------------------------------
    // `pi.ui.editor` — modal dialog with textarea, accept path returns
    // the edited text and the extension surfaces it via status chip +
    // title for assertion.
    // ------------------------------------------------------------------
    await test.step('editor accept returns the edited string', async () => {
      await chat.send('/edit-note seed');
      const editor = page.locator(
        '[data-testid="extension-editor"][data-extension-path*="note-editor"]'
      );
      await expect(editor).toBeVisible();
      await expect(editor).toHaveValue('seed');
      await editor.fill('my notes');
      await page.locator('[data-testid="extension-dialog-submit"]').click();
      await expect(editor).toHaveCount(0);

      const titleChip = page.locator(
        '[data-testid="extension-title"][data-extension-path*="note-editor"]'
      );
      await expect(titleChip).toContainText('edit-note: my notes');
      await expect(toast('note-editor: saved my notes').first()).toBeVisible();
    });

    // ------------------------------------------------------------------
    // Editor cancel — the worker promise resolves to undefined; the
    // extension branches into the 'cancelled' title so we can tell.
    // ------------------------------------------------------------------
    await test.step('editor cancel resolves to undefined', async () => {
      await chat.send('/edit-note');
      const editor = page.locator(
        '[data-testid="extension-editor"][data-extension-path*="note-editor"]'
      );
      await expect(editor).toBeVisible();
      await page.locator('[data-testid="extension-dialog-cancel"]').click();
      await expect(editor).toHaveCount(0);
      const titleChip = page.locator(
        '[data-testid="extension-title"][data-extension-path*="note-editor"]'
      );
      await expect(titleChip).toContainText('edit-note: cancelled');
    });

    // ------------------------------------------------------------------
    // `pi.ui.setEditorText` — the buffer mutates while the dialog is
    // open so the user sees the late-bound text when they hit Save.
    // ------------------------------------------------------------------
    await test.step('setEditorText mutates the open editor buffer', async () => {
      await chat.send('/edit-note-async');
      const editor = page.locator(
        '[data-testid="extension-editor"][data-extension-path*="note-editor"]'
      );
      await expect(editor).toBeVisible();
      await expect(editor).toHaveValue('after');
      await page.locator('[data-testid="extension-dialog-submit"]').click();
      const titleChip = page.locator(
        '[data-testid="extension-title"][data-extension-path*="note-editor"]'
      );
      await expect(titleChip).toContainText('edit-note-async: after');
    });

    // ------------------------------------------------------------------
    // `pi.registerProvider` — extension-contributed models appear in the
    // model picker. We refresh and assert on the option ids; we never
    // select the echo provider (its auth path throws by design).
    // ------------------------------------------------------------------
    await test.step('registered provider surfaces models in the picker', async () => {
      await chat.loadModels();
      await page.locator('[data-testid="model-selector"]').click();
      await page.locator('[data-testid="model-search-input"]').fill('echo');
      await expect(page.locator('[data-testid="model-option-echo-small"]')).toBeVisible();
      await expect(page.locator('[data-testid="model-option-echo-large"]')).toBeVisible();
      await page.keyboard.press('Escape');
    });

    // ------------------------------------------------------------------
    // `pi.registerSkill` — the extension-contributed skill shows up in
    // the slash palette with `data-command-source="extension-skill"`.
    // ------------------------------------------------------------------
    await test.step('registered skill appears in the slash palette', async () => {
      await page.locator('[data-testid="chat-input"]').fill('/skill:nudge');
      const nudge = page.locator('[data-testid="command-option-skill:nudge"]');
      const disabled = page.locator('[data-testid="command-option-skill:nudge-disabled"]');
      await expect(nudge).toBeVisible();
      await expect(disabled).toBeVisible();
      await expect(nudge).toHaveAttribute('data-command-source', 'extension-skill');
      await expect(disabled).toHaveAttribute('data-command-source', 'extension-skill');
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="chat-input"]').fill('');
    });

    // ------------------------------------------------------------------
    // `on('before_compact')` / `on('after_compact')` — the counters are
    // zero before any compaction has fired. We assert via the chip the
    // `/compact-stats` command installs so the test is independent of
    // the LLM. Full compaction round-trips are covered by the dedicated
    // compaction.spec.ts suite (pre-existing flake tracked separately).
    // ------------------------------------------------------------------
    await test.step('compaction hook counters surface via slash command', async () => {
      await chat.send('/compact-stats');
      const chip = page.locator(
        '[data-testid="extension-status-chip"][data-extension-path*="compaction-nudger"]'
      );
      await expect(chip).toContainText('before=0');
      await expect(chip).toContainText('after=0');
    });
  });
});
