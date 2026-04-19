import { Page } from '@playwright/test';

export class ApiModelsPage {
  constructor(
    private page: Page,
    private serverUrl: string
  ) {}

  selectors = {
    useApiKeyCheckbox: '[data-testid="api-key-input-checkbox"]',
    apiKeyInput: '[data-testid="api-key-input"]',
    usePrefixCheckbox: '[data-testid="prefix-input-checkbox"]',
    prefixInput: '[data-testid="prefix-input"]',
    fetchModelsButton: '[data-testid="fetch-models-button"]',
    fetchModelsContainer: '[data-testid="fetch-models-container"]',
    modelSearchInput: '[data-testid="model-search-input"]',
    modelOption: (model: string) => `[data-testid="available-model-${model}"]`,
    createButton: '[data-testid="create-api-model-button"]',
  };

  async configureApiModel(apiKey: string, prefix: string, modelName: string): Promise<void> {
    await this.page.goto(`${this.serverUrl}/ui/models/api/new/`);
    await this.page.waitForLoadState('networkidle');

    const isApiKeyChecked = await this.page.locator(this.selectors.useApiKeyCheckbox).isChecked();
    if (!isApiKeyChecked) {
      await this.page.check(this.selectors.useApiKeyCheckbox);
    }
    await this.page.fill(this.selectors.apiKeyInput, apiKey);

    const isPrefixChecked = await this.page.locator(this.selectors.usePrefixCheckbox).isChecked();
    if (!isPrefixChecked) {
      await this.page.check(this.selectors.usePrefixCheckbox);
    }
    await this.page.fill(this.selectors.prefixInput, prefix);

    await this.page.click(this.selectors.fetchModelsButton);
    await this.page.waitForSelector(
      `${this.selectors.fetchModelsContainer}[data-fetch-state="success"]`,
      { timeout: 30000 }
    );

    await this.page.fill(this.selectors.modelSearchInput, modelName);
    await this.page.waitForSelector(this.selectors.modelOption(modelName), { state: 'visible' });
    await this.page.click(this.selectors.modelOption(modelName));

    const createButton = this.page.locator(this.selectors.createButton);
    await createButton.scrollIntoViewIfNeeded();
    await createButton.click();
    await this.page.waitForURL(/\/ui\/models(?!\/api\/new)/);
    await this.page.waitForLoadState('networkidle');
  }
}
