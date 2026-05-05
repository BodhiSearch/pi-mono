import { test as baseTest } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { CommandPickerComponent } from './pages/CommandPickerComponent';
import { ExtensionsPanelComponent } from './pages/ExtensionsPanelComponent';
import { FeaturePanelComponent } from './pages/FeaturePanelComponent';
import { McpPanelComponent } from './pages/McpPanelComponent';
import { MessagesView } from './pages/MessagesView';
import { SessionPickerComponent } from './pages/SessionPickerComponent';
import { SetupOverlayPage } from './pages/SetupOverlayPage';
import { StatusBar } from './pages/StatusBar';
import { VolumesPanelComponent } from './pages/VolumesPanelComponent';

export interface AppFixtures {
  setup: SetupOverlayPage;
  status: StatusBar;
  auth: AuthPage;
  chat: ChatPage;
  messages: MessagesView;
  sessions: SessionPickerComponent;
  volumes: VolumesPanelComponent;
  extensions: ExtensionsPanelComponent;
  features: FeaturePanelComponent;
  mcp: McpPanelComponent;
  picker: CommandPickerComponent;
}

export const test = baseTest.extend<AppFixtures>({
  setup: async ({ page }, use) => use(new SetupOverlayPage(page)),
  status: async ({ page }, use) => use(new StatusBar(page)),
  auth: async ({ page }, use) => use(new AuthPage(page)),
  chat: async ({ page }, use) => use(new ChatPage(page)),
  messages: async ({ page }, use) => use(new MessagesView(page)),
  sessions: async ({ page }, use) => use(new SessionPickerComponent(page)),
  volumes: async ({ page }, use) => use(new VolumesPanelComponent(page)),
  extensions: async ({ page }, use) => use(new ExtensionsPanelComponent(page)),
  features: async ({ page }, use) => use(new FeaturePanelComponent(page)),
  mcp: async ({ page }, use) => use(new McpPanelComponent(page)),
  picker: async ({ page }, use) => use(new CommandPickerComponent(page)),
});

export { expect } from '@playwright/test';
