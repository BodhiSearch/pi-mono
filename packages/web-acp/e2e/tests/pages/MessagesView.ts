import { expect, type Page, type Locator } from '@playwright/test';

export type Role = 'user' | 'assistant';

export class MessagesView {
  constructor(private page: Page) {}

  bubble(turn: number, role: Role): Locator {
    return this.page.locator(
      `[data-testid="chat-message-turn-${turn}"][data-messagetype="${role}"]`
    );
  }

  async expectBuiltin(turn: number, role: Role): Promise<void> {
    await expect(this.bubble(turn, role)).toHaveAttribute('data-test-state', 'builtin');
  }

  async expectNotBuiltin(turn: number, role: Role): Promise<void> {
    await expect(this.bubble(turn, role)).not.toHaveAttribute('data-test-state', 'builtin');
  }

  async expectBuiltinBadge(turn: number): Promise<void> {
    await expect(
      this.bubble(turn, 'assistant').locator('[data-testid="builtin-badge"]')
    ).toContainText(/not sent to LLM/i);
  }

  toolCalls(): Locator {
    return this.page.locator('[data-testid^="tool-call-"]');
  }

  toolCallByName(toolName: string): Locator {
    return this.page.locator(`[data-testid^="tool-call-"][data-toolname="${toolName}"]`);
  }

  async waitForToolCallCompleted(): Promise<void> {
    await this.page
      .locator('[data-testid^="tool-call-"][data-test-state="completed"]')
      .first()
      .waitFor();
  }

  async waitForToolCallByName(toolName: string, status = 'completed'): Promise<void> {
    await this.page
      .locator(
        `[data-testid^="tool-call-"][data-toolname="${toolName}"][data-test-state="${status}"]`
      )
      .first()
      .waitFor();
  }

  async toolCallExitCode(): Promise<string> {
    const exit = this.page.locator('[data-testid^="tool-call-exit-"]').first();
    return (await exit.textContent())?.trim() ?? '';
  }

  async expectNoToolCalls(): Promise<void> {
    await expect(this.toolCalls()).toHaveCount(0);
  }

  async readClipboard(): Promise<string> {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }
}
