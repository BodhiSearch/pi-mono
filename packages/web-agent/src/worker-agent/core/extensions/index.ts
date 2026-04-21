/**
 * Barrel for the worker-side extension runtime.
 *
 * Exports the types extension authors and the worker-host consume, plus
 * the loader/runner/wrapper implementations the `WorkerAgentHost`
 * composes. Main-thread descriptors (`ExtensionDescriptor`,
 * `ExtensionError`) are re-exported from the top-level `worker-agent`
 * barrel so React code doesn't need to reach into `core/extensions/`.
 */

export type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextSupplier,
  Extension,
  ExtensionAPI,
  ExtensionCommandHandler,
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionError,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
  RegisteredCommand,
  RegisteredTool,
  ToolDefinition,
  ToolResultEvent,
  ToolResultEventResult,
} from './types';

export { defineTool } from './types';

export { EXTENSIONS_DIR_SEGMENT, loadExtensionsFromVault, loadExtensionFromSource } from './loader';
export type {
  ExtensionLoaderOps,
  LoadExtensionsOptions,
  LoadExtensionsResult,
  ModuleImporter,
} from './loader';

export { ExtensionRunner } from './runner';
export type { ExtensionErrorListener, ToolResultOverride } from './runner';

export { wrapRegisteredTool, wrapRegisteredTools } from './wrapper';
