import { expect, type Locator, type Page } from '@playwright/test';

export type AgentTransport = 'stdio' | 'websocket' | 'http';

export interface AddAgentSpec {
  name: string;
  transport: AgentTransport;
  /** Required for `websocket` / `http` transports. */
  url?: string;
  /** Required for `stdio` transport. */
  command?: string;
  args?: string;
}

// POM for acp-ui's settings dialog. Covers the Bodhi server panel
// AND the agent CRUD form. Tests compose these atomic methods rather
// than reaching into selectors directly.
export class SettingsPage {
  readonly openButton: Locator;
  readonly closeButton: Locator;
  readonly dialog: Locator;

  // Bodhi server URL panel (Phase 1)
  readonly bodhiSection: Locator;
  readonly bodhiServerUrlInput: Locator;
  readonly bodhiServerSaveButton: Locator;
  readonly bodhiServerCurrent: Locator;
  readonly bodhiServerError: Locator;
  readonly bodhiServerSaved: Locator;

  // Agents panel (Phase 2)
  readonly agentsSection: Locator;
  readonly agentsList: Locator;
  readonly addAgentButton: Locator;
  readonly agentForm: Locator;
  readonly agentNameInput: Locator;
  readonly agentTransportSelect: Locator;
  readonly agentUrlInput: Locator;
  readonly agentCommandInput: Locator;
  readonly agentArgsInput: Locator;
  readonly agentFormSaveButton: Locator;
  readonly agentFormCancelButton: Locator;
  readonly agentFormError: Locator;

  constructor(private page: Page) {
    this.openButton = page.locator('[data-testid="btn-settings"]');
    this.closeButton = page.locator('[data-testid="btn-settings-close"]');
    this.dialog = page.locator('[data-testid="dialog-settings"]');

    this.bodhiSection = page.locator('[data-testid="section-bodhi-server"]');
    this.bodhiServerUrlInput = page.locator('[data-testid="input-bodhi-server-url"]');
    this.bodhiServerSaveButton = page.locator('[data-testid="btn-bodhi-server-save"]');
    this.bodhiServerCurrent = page.locator('[data-testid="text-bodhi-server-current"]');
    this.bodhiServerError = page.locator('[data-testid="text-bodhi-server-error"]');
    this.bodhiServerSaved = page.locator('[data-testid="text-bodhi-server-saved"]');

    this.agentsSection = page.locator('[data-testid="section-agents"]');
    this.agentsList = page.locator('[data-testid="list-agents"]');
    this.addAgentButton = page.locator('[data-testid="btn-settings-add-agent"]');
    this.agentForm = page.locator('[data-testid="form-agent"]');
    this.agentNameInput = page.locator('[data-testid="input-agent-name"]');
    this.agentTransportSelect = page.locator('[data-testid="select-agent-transport"]');
    this.agentUrlInput = page.locator('[data-testid="input-agent-url"]');
    this.agentCommandInput = page.locator('[data-testid="input-agent-command"]');
    this.agentArgsInput = page.locator('[data-testid="input-agent-args"]');
    this.agentFormSaveButton = page.locator('[data-testid="btn-agent-save"]');
    this.agentFormCancelButton = page.locator('[data-testid="btn-agent-cancel"]');
    this.agentFormError = page.locator('[data-testid="text-agent-form-error"]');
  }

  async open(): Promise<void> {
    await this.openButton.click();
    await expect(this.dialog).toBeVisible();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.dialog).toBeHidden();
  }

  async setBodhiServerUrl(url: string): Promise<void> {
    await this.bodhiServerUrlInput.fill(url);
    await this.bodhiServerSaveButton.click();
    await expect(this.bodhiSection).toHaveAttribute(
      'data-test-state',
      /(configured|error)/
    );
  }

  async bodhiServerStatus(): Promise<string | null> {
    return this.bodhiSection.getAttribute('data-test-state');
  }

  /**
   * Drive the "Add Agent" form. Caller is responsible for opening the
   * dialog first (`open()`). Resolves once the new row is rendered.
   */
  async addAgent(spec: AddAgentSpec): Promise<void> {
    await this.addAgentButton.click();
    await expect(this.agentForm).toBeVisible();
    await expect(this.agentForm).toHaveAttribute('data-test-state', 'adding');

    await this.agentNameInput.fill(spec.name);
    await this.agentTransportSelect.selectOption(spec.transport);

    if (spec.transport === 'stdio') {
      if (!spec.command) {
        throw new Error('addAgent: stdio transport requires `command`');
      }
      await this.agentCommandInput.fill(spec.command);
      if (spec.args) await this.agentArgsInput.fill(spec.args);
    } else {
      if (!spec.url) {
        throw new Error(`addAgent: ${spec.transport} transport requires \`url\``);
      }
      await this.agentUrlInput.fill(spec.url);
    }

    await this.agentFormSaveButton.click();
    await expect(this.agentForm).toBeHidden();
    await expect(this.row(spec.name)).toBeVisible();
  }

  /**
   * Locator for an agent row. Useful for asserting visibility / transport
   * kind without reaching into the dialog internals.
   */
  row(name: string): Locator {
    return this.page.locator(`[data-testid="row-agent-${name}"]`);
  }

  async deleteAgent(name: string): Promise<void> {
    // The settings view uses a native window.confirm to gate deletes;
    // accept it once the click fires. Caller MUST set up the dialog
    // listener before calling this on a clean test (Playwright auto-
    // dismisses by default which would cancel the delete).
    this.page.once('dialog', dialog => void dialog.accept());
    await this.page.locator(`[data-testid="btn-agent-delete-${name}"]`).click();
    await expect(this.row(name)).toBeHidden();
  }
}
