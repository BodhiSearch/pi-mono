/**
 * Per-extension `pi: ExtensionAPI` factory.
 *
 * Each load gets a fresh API bound to its own extension name. The
 * API is "factory-arg only" — extensions never import from
 * `@bodhiapp/web-acp-agent` directly; everything they need
 * (TypeBox via `pi.types`, fs, volumes) flows through this object.
 */

import { Type } from '@sinclair/typebox';
import type { ExtensionsFs } from './extensions-fs';
import type {
  Disposable,
  ExtensionAPI,
  ExtensionCommandDefinition,
  ExtensionEvent,
  ExtensionEventHandler,
  ExtensionEventsView,
  ExtensionSessionView,
  ExtensionTool,
  ExtensionVolumesView,
  ProviderConfig,
} from './types';

export interface CapabilityRecorder {
  recordEvent(name: ExtensionEvent): void;
  recordTool(name: string): void;
  recordCommand(name: string): void;
  recordProvider(name: string): void;
}

export interface ToolRegistrar {
  /**
   * Returns true when the tool was accepted, false when an
   * already-registered owner kept the slot under last-write-wins
   * semantics or when the call was rejected outright.
   */
  register(extensionName: string, tool: ExtensionTool): boolean;
  unregister(extensionName: string, toolName: string): void;
}

export interface CommandRegistrar {
  register(extensionName: string, name: string, def: ExtensionCommandDefinition): boolean;
  unregister(extensionName: string, name: string): void;
}

export interface ProviderRegistrar {
  register(extensionName: string, name: string, config: ProviderConfig): boolean;
  unregister(extensionName: string, name: string): void;
}

export interface CreateExtensionAPIInput {
  extensionName: string;
  recorder: CapabilityRecorder;
  subscriptions: ExtensionSubscription[];
  fs: ExtensionsFs;
  volumes: ExtensionVolumesView;
  tools: ToolRegistrar;
  commands: CommandRegistrar;
  providers: ProviderRegistrar;
  session: ExtensionSessionView;
  events: ExtensionEventsView;
}

export function createExtensionAPI(input: CreateExtensionAPIInput): ExtensionAPI {
  const {
    extensionName,
    recorder,
    subscriptions,
    fs,
    volumes,
    tools,
    commands,
    providers,
    session,
    events,
  } = input;
  return {
    extensionName,
    fs,
    volumes,
    types: Type,
    session,
    events,
    on(event: ExtensionEvent, handler: ExtensionEventHandler) {
      const sub: ExtensionSubscription = { event, handler, disposed: false };
      subscriptions.push(sub);
      recorder.recordEvent(event);
      const disposable: Disposable = {
        dispose() {
          sub.disposed = true;
        },
      };
      return disposable;
    },
    registerTool(tool: ExtensionTool) {
      const accepted = tools.register(extensionName, tool);
      if (accepted) recorder.recordTool(tool.name);
      const disposable: Disposable = {
        dispose() {
          tools.unregister(extensionName, tool.name);
        },
      };
      return disposable;
    },
    registerCommand(name: string, def: ExtensionCommandDefinition) {
      const accepted = commands.register(extensionName, name, def);
      if (accepted) recorder.recordCommand(name);
      const disposable: Disposable = {
        dispose() {
          commands.unregister(extensionName, name);
        },
      };
      return disposable;
    },
    registerProvider(name: string, config: ProviderConfig) {
      const accepted = providers.register(extensionName, name, config);
      if (accepted) recorder.recordProvider(name);
      const disposable: Disposable = {
        dispose() {
          providers.unregister(extensionName, name);
        },
      };
      return disposable;
    },
  } as ExtensionAPI;
}

export interface ExtensionSubscription {
  event: ExtensionEvent;
  handler: ExtensionEventHandler;
  disposed: boolean;
}
