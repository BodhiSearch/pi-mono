import type { BuiltinCommand, BuiltinExtensionsHandle } from './types';

const USAGE = [
  '**Usage**',
  '',
  '- `/extension list` — show active and disabled extensions',
  '- `/extension off <name>` — disable an extension and reload',
  '- `/extension on <name>` — enable an extension and reload',
  '- `/extension add <pkg>[@<version>]` — install from npm into the `agent-wd` volume',
].join('\n');

export const extensionCommand: BuiltinCommand = {
  name: 'extension',
  description: 'List, enable, disable, or install vault-sourced extensions.',
  inputHint: '[list | on <name> | off <name> | add <pkg>]',
  handler: async (args, ctx) => {
    if (!ctx.extensions) {
      return { replyText: 'Extensions registry not configured for this session.' };
    }
    const trimmed = args.trim();
    if (trimmed === '' || trimmed === 'list') {
      return { replyText: renderList(ctx.extensions) };
    }
    const [verb, ...rest] = trimmed.split(/\s+/);
    const target = rest.join(' ').trim();
    if (verb === 'add') {
      const parsed = parseAddArgs(rest);
      if (!parsed.spec) {
        return { replyText: `\`/extension add\` requires a package spec.\n\n${USAGE}` };
      }
      try {
        const result = await ctx.extensions.add(
          parsed.spec,
          parsed.registryUrl ? { registryUrl: parsed.registryUrl } : undefined
        );
        return {
          replyText: [
            `Installed \`${result.name}@${result.version}\` as \`${result.extensionName}\`.`,
            `Wrote to \`${result.installPath}\`.`,
            '',
            renderListFromSnapshot(
              result.active.map(e => e.name),
              ctx.extensions.disabled(),
              ctx.extensions.known()
            ),
          ].join('\n'),
        };
      } catch (err) {
        return { replyText: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (verb !== 'on' && verb !== 'off') {
      return { replyText: `Unknown subcommand \`${verb}\`.\n\n${USAGE}` };
    }
    if (!target) {
      return { replyText: `\`/extension ${verb}\` requires an extension name.\n\n${USAGE}` };
    }
    const known = ctx.extensions.known();
    if (!known.includes(target)) {
      return {
        replyText: `Unknown extension \`${target}\`. Known: ${known.length ? known.join(', ') : '(none)'}.`,
      };
    }
    const current = new Set(ctx.extensions.disabled());
    if (verb === 'off') current.add(target);
    else current.delete(target);
    const next = await ctx.extensions.setDisabled([...current]);
    const disabledSet = new Set(next.disabled);
    return {
      replyText: [
        `Extension \`${target}\` is now ${disabledSet.has(target) ? 'disabled' : 'enabled'}.`,
        '',
        renderListFromSnapshot(
          next.active.map(e => e.name),
          next.disabled,
          known
        ),
      ].join('\n'),
    };
  },
};

// Strip a single `--registry <url>` (or `--registry=<url>`) flag from the
// argv, returning whatever's left as the package spec. Anything after the
// first non-flag token is treated as part of the spec for now (npm specs
// don't contain spaces, so this stays unambiguous).
function parseAddArgs(rest: readonly string[]): { spec: string; registryUrl?: string } {
  let spec = '';
  let registryUrl: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--registry') {
      registryUrl = rest[i + 1];
      i += 1;
      continue;
    }
    if (tok.startsWith('--registry=')) {
      registryUrl = tok.slice('--registry='.length);
      continue;
    }
    if (!spec) spec = tok;
  }
  return registryUrl ? { spec, registryUrl } : { spec };
}

function renderList(extensions: BuiltinExtensionsHandle): string {
  const active = extensions.active().map(e => e.name);
  return renderListFromSnapshot(active, [...extensions.disabled()], extensions.known());
}

function renderListFromSnapshot(
  active: readonly string[],
  disabled: readonly string[],
  known: readonly string[]
): string {
  const lines = ['**Extensions**', ''];
  if (active.length === 0) {
    lines.push('- Active: _none_');
  } else {
    lines.push('- Active:');
    for (const name of [...active].sort((a, b) => a.localeCompare(b))) {
      lines.push(`  - \`${name}\``);
    }
  }
  if (disabled.length > 0) {
    lines.push('- Disabled:');
    for (const name of [...disabled].sort((a, b) => a.localeCompare(b))) {
      lines.push(`  - \`${name}\``);
    }
  }
  if (known.length === 0) {
    lines.push(
      '',
      '_No extensions discovered. Drop a folder under `<mount>/.pi/extensions/` and reload._'
    );
  }
  return lines.join('\n');
}
