// Progress-widget extension — exercises `pi.ui.setWidget` with the
// three closed-enum widget kinds.
//
// `/progress-show <kind>` drops a widget of the requested kind into the
// transcript, keyed by `widgetId`. `/progress-clear` removes it. The
// spec asserts via `data-testid="extension-widget"` and the matching
// `data-widget-kind` attribute without asking the LLM to generate any
// content.
export default function progressWidgetExtension(pi) {
  const WIDGET_ID = 'progress-main';

  function renderKind(kind) {
    if (kind === 'info') {
      return {
        kind: 'info',
        props: {
          title: 'progress-widget info',
          message: 'Deterministic info message for e2e assertions.',
        },
      };
    }
    if (kind === 'choice') {
      return {
        kind: 'choice',
        props: {
          title: 'Pick one',
          options: [
            { id: 'apple', label: 'Apple' },
            { id: 'pear', label: 'Pear' },
          ],
        },
      };
    }
    return {
      kind: 'progress',
      props: {
        label: 'Crunching',
        ratio: 0.42,
        note: 'deterministic ratio for tests',
      },
    };
  }

  pi.registerCommand('progress-show', {
    description: 'Show a widget of kind progress | info | choice.',
    handler: (args, ctx) => {
      const raw = args.trim();
      const kind = raw === 'info' || raw === 'choice' ? raw : 'progress';
      ctx.ui.setWidget(WIDGET_ID, renderKind(kind));
    },
  });

  pi.registerCommand('progress-clear', {
    description: 'Clear the extension widget.',
    handler: (_args, ctx) => {
      ctx.ui.setWidget(WIDGET_ID, null);
    },
  });

  pi.on('turn_start', () => {
    pi.ui.setWidget(WIDGET_ID, null);
  });
}
