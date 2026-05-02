/**
 * `/mcp` user-facing surface for the CLI host.
 *
 * Subcommands:
 *   - `list` (default): merge the requested-URL wishlist with the live
 *     Bodhi instance catalog and the agent's per-server lifecycle
 *     state to print a single status table.
 *   - `add <url>`: append to sqlite kv `requestedMcps`; nudge the user
 *     to re-login so Keycloak picks up the new resource.
 *   - `remove <url>`: drop from sqlite kv `requestedMcps`.
 *   - `on <slug>` / `off <slug>` — per-server toggle via
 *     `_bodhi/mcp/toggles/set`.
 *   - `on <slug>:<tool1>,<tool2>` / `off <slug>:<tool1>,<tool2>` —
 *     per-tool toggle.
 *
 * The agent-side `/mcp` built-in handles the same operations during
 * a turn (`add`/`remove` emit a `_meta.bodhi.builtin.action`, picked
 * up by the host dispatcher). This CLI command is the parallel
 * out-of-turn surface so users can manage MCPs without a model.
 */

import type { SlashCommand } from '../shell/registry';
import type { AppContext } from '../shell/context';
import { canonicalizeMcpUrl } from '@bodhiapp/web-acp-agent';
import type { McpConnectionMeta } from '../acp/streaming-reducer';
import { KV_REQUESTED_MCPS } from '../storage/kv-keys';
import { refreshMcpCatalog } from '../mcp/catalog';

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Inspect MCP catalog, manage wishlist, toggle servers/tools.',
  usage: '/mcp [list|add <url>|remove <url>|on <slug>[:<tool,...>]|off <slug>[:<tool,...>]]',
  async handler(ctx, args) {
    const [sub, ...rest] = args;
    const action = (sub ?? 'list').toLowerCase();
    switch (action) {
      case 'list':
      case 'ls':
        return renderList(ctx);
      case 'add':
        return addUrl(ctx, rest[0]);
      case 'remove':
      case 'rm':
        return removeUrl(ctx, rest[0]);
      case 'on':
        return setToggle(ctx, rest[0], true);
      case 'off':
        return setToggle(ctx, rest[0], false);
      default:
        ctx.renderer.emit({
          kind: 'error',
          text: `Unknown /mcp action '${action}'. Try list|add|remove|on|off.`,
        });
    }
  },
};

async function renderList(ctx: AppContext): Promise<void> {
  // Refresh the catalog opportunistically when authenticated; never
  // throws (already swallowed by refreshMcpCatalog) — we render
  // whatever is currently cached on `ctx`.
  if (ctx.status.kind === 'authenticated') {
    await refreshMcpCatalog(ctx);
  }

  const requested = ctx.host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];
  ctx.requestedMcps = requested;
  const instances = ctx.mcpInstances;
  const liveStates = ctx.stream.getState().mcpStates;

  if (requested.length === 0 && instances.length === 0) {
    ctx.renderer.emit({
      kind: 'info',
      text: 'No MCP servers configured. Use `/mcp add <url>` then `/login`.',
    });
    return;
  }

  const lines: string[] = [];
  if (instances.length > 0) {
    const connected = Object.values(liveStates).filter(m => m.state === 'connected').length;
    lines.push(`Instances (${connected}/${instances.length} connected):`);
    for (const inst of instances) {
      const live = liveStates[inst.slug];
      const state = live?.state ?? 'disconnected';
      const tools = live?.tools?.length ?? 0;
      const errSuffix = live?.error ? ` — ${live.error}` : '';
      const toolsSuffix = tools > 0 ? ` [${tools} tools]` : '';
      lines.push(
        `  ${stateMarker(state)} ${inst.slug.padEnd(20)} ${state}${toolsSuffix}${errSuffix}`
      );
    }
  }
  const pending = requested.filter(url => {
    const slug = inferSlugFromUrl(url);
    return !instances.some(i => i.slug === slug);
  });
  if (pending.length > 0) {
    lines.push('');
    lines.push(`Pending or denied (${pending.length}):`);
    for (const url of pending) {
      lines.push(`  • ${url}`);
    }
  }
  ctx.renderer.emit({ kind: 'info', text: lines.join('\n') });
}

async function addUrl(ctx: AppContext, raw: string | undefined): Promise<void> {
  if (!raw) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /mcp add <url>' });
    return;
  }
  const canonical = canonicalizeMcpUrl(raw);
  if (!canonical) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Not a valid MCP URL: ${raw}`,
    });
    return;
  }
  const current = ctx.host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];
  if (current.includes(canonical)) {
    ctx.renderer.emit({ kind: 'info', text: `Already in list: ${canonical}` });
    return;
  }
  const next = [...current, canonical];
  ctx.host.kv.set(KV_REQUESTED_MCPS, next);
  ctx.requestedMcps = next;
  ctx.renderer.emit({
    kind: 'info',
    text: `Added ${canonical}. Run /login to refresh the access-request scope.`,
  });
}

async function removeUrl(ctx: AppContext, raw: string | undefined): Promise<void> {
  if (!raw) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /mcp remove <url>' });
    return;
  }
  // canonicalizeMcpUrl returns null for unparseable input; fall back to
  // the raw string so users can still drop a typo'd entry from kv.
  const canonical = canonicalizeMcpUrl(raw) ?? raw;
  const current = ctx.host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];
  if (!current.includes(canonical)) {
    ctx.renderer.emit({ kind: 'info', text: `Not in list: ${canonical}` });
    return;
  }
  const next = current.filter(entry => entry !== canonical);
  ctx.host.kv.set(KV_REQUESTED_MCPS, next);
  ctx.requestedMcps = next;
  ctx.renderer.emit({ kind: 'info', text: `Removed ${canonical}. Run /login to refresh.` });
}

async function setToggle(
  ctx: AppContext,
  target: string | undefined,
  value: boolean
): Promise<void> {
  if (!target) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Usage: /mcp ${value ? 'on' : 'off'} <slug>[:<tool1,tool2,...>]`,
    });
    return;
  }
  if (!ctx.sessionId) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'No active session. Open one first by sending a prompt or running /session new.',
    });
    return;
  }
  const colonIdx = target.indexOf(':');
  const slug = colonIdx === -1 ? target : target.slice(0, colonIdx);
  const toolList = colonIdx === -1 ? undefined : target.slice(colonIdx + 1);
  if (!slug) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /mcp on|off <slug>[:<tools>]' });
    return;
  }
  if (toolList === undefined) {
    await ctx.client.setMcpToggle(ctx.sessionId, slug, value);
    ctx.renderer.emit({
      kind: 'info',
      text: `Server '${slug}' set to ${value ? 'on' : 'off'} for session ${ctx.sessionId}.`,
    });
    return;
  }
  const tools = toolList
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (tools.length === 0) {
    ctx.renderer.emit({ kind: 'error', text: "No tools specified after ':'." });
    return;
  }
  for (const tool of tools) {
    await ctx.client.setMcpToggle(ctx.sessionId, slug, value, tool);
  }
  ctx.renderer.emit({
    kind: 'info',
    text: `${slug}: ${tools.length} tool(s) set to ${value ? 'on' : 'off'}.`,
  });
}

function stateMarker(state: McpConnectionMeta['state']): string {
  switch (state) {
    case 'connected':
      return '●';
    case 'connecting':
      return '◌';
    case 'disconnected':
      return '◯';
    case 'error':
      return '✗';
  }
}

function inferSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}
