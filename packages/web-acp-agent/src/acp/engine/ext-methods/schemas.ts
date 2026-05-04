import { z } from 'zod';
import {
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
} from '../../../wire';

const sessionIdParam = z.object({ sessionId: z.string().min(1) }).passthrough();

const mcpTogglesSetParams = z
  .object({
    sessionId: z.string().min(1),
    serverSlug: z.string().min(1),
    toolName: z.string().min(1).optional(),
    value: z.boolean(),
  })
  .passthrough();

const empty = z.object({}).passthrough();

// Wire-shape only; handlers own authorisation. Unlisted methods pass through.
export const EXT_METHOD_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  [BODHI_VOLUMES_LIST_METHOD]: empty,
  [BODHI_MCP_TOGGLES_SET_METHOD]: mcpTogglesSetParams,
  [BODHI_SESSIONS_DELETE_METHOD]: sessionIdParam,
};
