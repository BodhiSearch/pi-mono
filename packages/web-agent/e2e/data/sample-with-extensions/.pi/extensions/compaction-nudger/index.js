// Compaction-nudger extension — exercises `before_compact` and
// `after_compact` hooks.
//
// The `before_compact` handler bumps the cut index by 1 (or clamps to
// 0 if already at the head) so the spec can assert the override
// survived the reducer pipe. `after_compact` records the summary size
// and before/after counts. `/compact-stats` surfaces both counters via
// a toast for deterministic DOM assertions.
export default function compactionNudgerExtension(pi) {
  let beforeFires = 0;
  let afterFires = 0;
  let lastCutIndex = null;
  let lastAfter = null;

  pi.on('before_compact', event => {
    beforeFires += 1;
    lastCutIndex = event.cutIndex;
    const target = event.cutIndex > 0 ? event.cutIndex - 1 : 0;
    return { cutIndex: target };
  });

  pi.on('after_compact', event => {
    afterFires += 1;
    lastAfter = {
      beforeCount: event.beforeCount,
      afterCount: event.afterCount,
      summary: event.summary ? event.summary.slice(0, 32) : '',
    };
  });

  pi.registerCommand('compact-stats', {
    description: 'Surface before/after compaction counters as a status chip + toast.',
    handler: (_args, ctx) => {
      const chip = `before=${beforeFires} after=${afterFires}`;
      ctx.ui.setStatus(chip);
      ctx.ui.notify(
        `compaction-nudger: before=${beforeFires} after=${afterFires} cut=${
          lastCutIndex ?? 'n/a'
        } after=${lastAfter ? `${lastAfter.beforeCount}→${lastAfter.afterCount}` : 'n/a'}`,
        'info'
      );
    },
  });
}
