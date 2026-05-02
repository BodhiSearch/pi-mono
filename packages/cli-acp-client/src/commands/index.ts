export { handlePrompt } from './prompt';
export { hostCommand } from './host';
export { loginCommand, runLogin } from './login';
export { logoutCommand } from './logout';
export { modelsCommand, modelCommand } from './models';
export { mcpCommand } from './mcp';
export { sessionCommand } from './session';
export { volumeCommand } from './volume';
export { featureCommand } from './feature';
export { buildHelpCommand } from './help';
export { buildQuitCommand, createQuitController, type QuitController } from './quit';

import { CommandRegistry } from '../shell/registry';
import { hostCommand } from './host';
import { loginCommand } from './login';
import { logoutCommand } from './logout';
import { modelsCommand, modelCommand } from './models';
import { mcpCommand } from './mcp';
import { sessionCommand } from './session';
import { volumeCommand } from './volume';
import { featureCommand } from './feature';
import { buildHelpCommand } from './help';
import { buildQuitCommand, type QuitController } from './quit';

export interface BuildRegistryOptions {
  quitController: QuitController;
}

export function buildDefaultRegistry(opts: BuildRegistryOptions): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll([
    hostCommand,
    loginCommand,
    logoutCommand,
    modelsCommand,
    modelCommand,
    mcpCommand,
    sessionCommand,
    volumeCommand,
    featureCommand,
    buildQuitCommand(opts.quitController),
  ]);
  // Help needs the registry itself, so register it last.
  registry.register(buildHelpCommand(registry));
  return registry;
}
