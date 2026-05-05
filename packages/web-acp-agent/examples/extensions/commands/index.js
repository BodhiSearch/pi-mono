export default function commandsExtension(pi) {
  pi.registerCommand('volumes', {
    description: 'List currently mounted volumes',
    handler: async () => {
      const list = pi.volumes.list();
      if (list.length === 0) return 'No volumes are currently mounted.';
      const lines = list.map((vol) => {
        const tags = Array.isArray(vol.tags) && vol.tags.length > 0 ? ` [${vol.tags.join(', ')}]` : '';
        const desc = vol.description ? ` — ${vol.description}` : '';
        return `- /mnt/${vol.mountName}${tags}${desc}`;
      });
      return `Mounted volumes:\n${lines.join('\n')}`;
    },
  });
}
