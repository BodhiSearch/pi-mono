import { Page, expect, type Locator } from '@playwright/test';

export class ChatPage {
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly modelSelector: Locator;
  private readonly stopButton: Locator;
  private readonly chatArea: Locator;

  constructor(private page: Page) {
    this.input = page.locator('[data-testid="chat-input"]');
    this.sendButton = page.locator('[data-testid="send-button"]');
    this.modelSelector = page.locator('[data-testid="model-selector"]');
    this.stopButton = page.locator('[data-testid="btn-stop"]');
    this.chatArea = page.locator('[data-testid="chat-area"]');
  }

  private readonly selectors = {
    modelSelector: '[data-testid="model-selector"]',
    modelSearchInput: '[data-testid="model-search-input"]',
    chatInput: '[data-testid="chat-input"]',
    sendButton: '[data-testid="send-button"]',
    chatProcessing: '[data-testid="chat-processing"]',
    newChatButton: '[data-testid="btn-new-chat"]',
    message: (turn: number, role: string) =>
      `[data-testid="chat-message-turn-${turn}"][data-messagetype="${role}"]`,
  };

  async waitForModelsLoaded(): Promise<void> {
    await expect(this.page.locator(this.selectors.modelSelector)).toHaveAttribute(
      'data-test-state',
      'loaded'
    );
  }

  async selectModel(modelId: string): Promise<void> {
    const trigger = this.page.locator(this.selectors.modelSelector);
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await this.page.locator(this.selectors.modelSearchInput).fill(modelId);
    await this.page.getByTestId(`model-option-${modelId}`).click();
    await expect(trigger).toContainText(modelId);
  }

  async send(prompt: string): Promise<void> {
    const input = this.page.locator(this.selectors.chatInput);
    await input.fill(prompt);
    // A bare slash token (e.g. `/copy`) keeps the command picker open,
    // and ChatInput.handleSubmit guards against submitting while the
    // picker has focus. Dismiss it so the click goes through.
    if (/^\/\S*$/.test(prompt)) {
      await input.press('Escape');
    }
    await this.page.locator(this.selectors.sendButton).click();
  }

  async waitForAssistantTurn(turn: number): Promise<void> {
    await this.page.locator(this.selectors.message(turn, 'assistant')).waitFor();
    await this.page.locator(this.selectors.chatProcessing).waitFor({ state: 'hidden' });
  }

  async newChat(): Promise<void> {
    await this.page.locator(this.selectors.newChatButton).click();
  }

  async fillRaw(text: string): Promise<void> {
    await this.input.fill(text);
  }

  async waitForStreaming(): Promise<void> {
    await expect(this.chatArea).toHaveAttribute('data-test-state', 'streaming');
  }

  async waitForIdle(): Promise<void> {
    await expect(this.chatArea).toHaveAttribute('data-test-state', 'idle');
  }

  async expectStopVisible(): Promise<void> {
    await expect(this.stopButton).toBeVisible();
  }

  async expectStopHidden(): Promise<void> {
    await expect(this.stopButton).toBeHidden();
  }

  async stop(): Promise<void> {
    await this.stopButton.click();
  }

  async expectInputDisabled(): Promise<void> {
    await expect(this.input).toBeDisabled();
  }
}
