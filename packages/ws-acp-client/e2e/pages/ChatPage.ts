import { expect, type Locator, type Page } from '@playwright/test';

// POM for acp-ui's chat surface — the right-hand pane (welcome screen
// or active session ChatView) plus the sidebar controls that drive it.
//
// State lives entirely on `data-test-state` of the chat surface:
//   `disconnected | connecting | auth-required | reconnecting | ready
//    | streaming | idle | error`
//
// The agent picker lives in the sidebar (`[data-testid="select-agent"]`)
// alongside the cwd input + "New Session" button.
export class ChatPage {
  readonly section: Locator;
  readonly agentSelect: Locator;
  readonly cwdInput: Locator;
  readonly newSessionButton: Locator;
  readonly disconnectButton: Locator;
  readonly welcome: Locator;

  constructor(private page: Page) {
    this.section = page.locator('[data-testid="div-chat"]');
    this.agentSelect = page.locator('[data-testid="select-agent"]');
    this.cwdInput = page.locator('[data-testid="input-cwd"]');
    this.newSessionButton = page.locator('[data-testid="btn-new-session"]');
    this.disconnectButton = page.getByRole('button', { name: 'Disconnect' });
    this.welcome = page.locator('[data-testid="div-welcome"]');
  }

  /** Read the current chat surface state. */
  async state(): Promise<string | null> {
    return this.section.getAttribute('data-test-state');
  }

  async expectState(state: string): Promise<void> {
    await expect(this.section).toHaveAttribute('data-test-state', state);
  }

  /** Pick an agent from the AgentSelector dropdown. */
  async selectAgent(name: string): Promise<void> {
    await this.agentSelect.selectOption(name);
    await expect(this.agentSelect).toHaveValue(name);
  }

  /** Set the working directory input (web platform — free-text). */
  async setCwd(cwd: string): Promise<void> {
    await this.cwdInput.fill(cwd);
  }

  /** Click "New Session". Caller is responsible for asserting the
   * resulting state (auth-required, ready, …). */
  async newSession(): Promise<void> {
    await this.newSessionButton.click();
  }
}
