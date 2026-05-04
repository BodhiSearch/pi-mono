import { expect, type Locator, type Page } from '@playwright/test';

// POM for acp-ui's chat surface — the right-hand pane (welcome screen
// or active session ChatView) plus the sidebar controls that drive it.
//
// State lives entirely on `data-test-state` of the chat surface:
//   `disconnected | connecting | auth-required | reconnecting | ready
//    | streaming | idle | error`
//
// The agent picker lives in the sidebar (`[data-testid="select-agent"]`)
// alongside the cwd input + "New Session" button. The model picker
// (`data-testid="select-model"`) only mounts after `session/new`
// succeeds, so its locators must be addressed lazily.
export class ChatPage {
  readonly section: Locator;
  readonly agentSelect: Locator;
  readonly cwdInput: Locator;
  readonly newSessionButton: Locator;
  readonly disconnectButton: Locator;
  readonly welcome: Locator;
  readonly modelPicker: Locator;
  readonly modelToggle: Locator;
  readonly modelList: Locator;
  readonly promptInput: Locator;
  readonly sendButton: Locator;
  readonly cancelButton: Locator;
  readonly messages: Locator;

  constructor(private page: Page) {
    this.section = page.locator('[data-testid="div-chat"]');
    this.agentSelect = page.locator('[data-testid="select-agent"]');
    this.cwdInput = page.locator('[data-testid="input-cwd"]');
    this.newSessionButton = page.locator('[data-testid="btn-new-session"]');
    this.disconnectButton = page.getByRole('button', { name: 'Disconnect' });
    this.welcome = page.locator('[data-testid="div-welcome"]');
    this.modelPicker = page.locator('[data-testid="select-model"]');
    this.modelToggle = page.locator('[data-testid="btn-model-toggle"]');
    this.modelList = page.locator('[data-testid="list-model-options"]');
    this.promptInput = page.locator('[data-testid="input-prompt"]');
    this.sendButton = page.locator('[data-testid="btn-send-prompt"]');
    this.cancelButton = page.locator('[data-testid="btn-cancel-prompt"]');
    this.messages = page.locator('[data-testid^="bubble-message-"]');
  }

  async state(): Promise<string | null> {
    return this.section.getAttribute('data-test-state');
  }

  async expectState(state: string): Promise<void> {
    await expect(this.section).toHaveAttribute('data-test-state', state);
  }

  async selectAgent(name: string): Promise<void> {
    await this.agentSelect.selectOption(name);
    await expect(this.agentSelect).toHaveValue(name);
  }

  async setCwd(cwd: string): Promise<void> {
    await this.cwdInput.fill(cwd);
  }

  async newSession(): Promise<void> {
    await this.newSessionButton.click();
  }

  /** Open the model dropdown and click the option whose `data-test-model-id`
   * equals the supplied model id. Idempotent — no-op when the desired
   * model is already current. */
  async selectModel(modelId: string): Promise<void> {
    const current = await this.modelPicker.getAttribute('data-test-current');
    if (current === modelId) return;
    await this.modelToggle.click();
    await expect(this.modelList).toBeVisible();
    await this.page.locator(`[data-test-model-id="${modelId}"]`).click();
    await expect(this.modelPicker).toHaveAttribute(
      'data-test-current',
      modelId
    );
  }

  /** Type the prompt and click Send. The caller asserts the resulting
   * `data-test-state` transition (streaming → idle, or error). */
  async send(prompt: string): Promise<void> {
    await this.promptInput.fill(prompt);
    await this.sendButton.click();
  }

  /** Returns the bubble locator for an assistant message at index `idx`
   * within all rendered bubbles. acp-ui renders user and assistant
   * messages alternately, so e.g. the first assistant reply is bubble #1
   * (user prompt is bubble #0). The role attribute is enforced via a
   * test-id selector so the wait-for-stable shape is automatic. */
  bubble(idx: number, role: 'user' | 'assistant'): Locator {
    return this.page
      .locator(`[data-testid="bubble-message-${idx}"][data-test-role="${role}"]`);
  }

  /** Convenience: assistant content body for the i-th rendered bubble. */
  bubbleContent(idx: number, role: 'user' | 'assistant'): Locator {
    return this.bubble(idx, role).locator('[data-testid="text-message-content"]');
  }
}
