export default function claudeRulesExtension(pi) {
  let ruleEntries = [];

  pi.on('session_start', async () => {
    ruleEntries = [];
    for (const volume of pi.volumes.list()) {
      const rulesDir = `/mnt/${volume.mountName}/.claude/rules`;
      const found = await collectMarkdownFiles(pi.fs, rulesDir);
      for (const relPath of found) {
        ruleEntries.push(`/mnt/${volume.mountName}/.claude/rules/${relPath}`);
      }
    }
  });

  pi.on('before_agent_start', async (event) => {
    if (ruleEntries.length === 0) return undefined;
    const list = ruleEntries.map((path) => `- ${path}`).join('\n');
    return {
      systemPrompt:
        event.systemPrompt +
        `

## Project Rules

The following project rules are available:

${list}

When working on tasks related to these rules, use the bash tool to read the relevant rule files for guidance.
`,
    };
  });
}

async function collectMarkdownFiles(fs, root) {
  const out = [];
  await walk(fs, root, '', out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function walk(fs, dir, basePath, out) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await walk(fs, `${dir}/${entry.name}`, relPath, out);
      continue;
    }
    if (entry.isFile && entry.name.endsWith('.md')) {
      out.push(relPath);
    }
  }
}
