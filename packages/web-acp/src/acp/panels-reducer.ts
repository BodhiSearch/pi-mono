import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  EMPTY_AVAILABLE_COMMANDS,
  EMPTY_CONFIG_OPTIONS,
  EMPTY_MCP_STATES,
} from '@/acp/empty-sentinels';
import type { McpConnectionMeta } from '@/mcp/types';
import type { AcpAction } from '@/acp/streaming-reducer';

/**
 * Panel slice — surfaces that survive prompt-turn boundaries.
 * `mcpStates` and `configOptions` are preserved across `reset`;
 * `availableCommands` is dropped because the agent re-emits on every
 * `session/new` / `session/load`.
 */
export interface PanelsState {
  availableCommands: readonly AvailableCommand[];
  mcpStates: Record<string, McpConnectionMeta>;
  configOptions: readonly SessionConfigOption[];
}

export const initialPanelsState: PanelsState = Object.freeze({
  availableCommands: EMPTY_AVAILABLE_COMMANDS,
  mcpStates: EMPTY_MCP_STATES,
  configOptions: EMPTY_CONFIG_OPTIONS,
});

/**
 * Shares {@link AcpAction} with `streamingReducer`; non-panel actions
 * return the same instance so React's `===` bail-out elides re-renders.
 */
export function panelsReducer(state: PanelsState, action: AcpAction): PanelsState {
  switch (action.type) {
    case 'reset':
      if (state.availableCommands === EMPTY_AVAILABLE_COMMANDS) return state;
      return { ...state, availableCommands: EMPTY_AVAILABLE_COMMANDS };
    case 'config-options-init':
      return { ...state, configOptions: action.configOptions };
    case 'mcp-state':
      return {
        ...state,
        mcpStates: { ...state.mcpStates, [action.meta.server]: action.meta },
      };
    case 'session-update': {
      const update = action.notif.update;
      // These two kinds bypass the streaming reducer's replay guard so
      // panels stay in sync during `session/load` rehydration.
      if (update.sessionUpdate === 'available_commands_update') {
        const list = update.availableCommands ?? [];
        return {
          ...state,
          availableCommands: list.length > 0 ? list : EMPTY_AVAILABLE_COMMANDS,
        };
      }
      if (update.sessionUpdate === 'config_option_update') {
        const list = update.configOptions ?? [];
        return {
          ...state,
          configOptions: list.length > 0 ? list : EMPTY_CONFIG_OPTIONS,
        };
      }
      return state;
    }
    default:
      return state;
  }
}
