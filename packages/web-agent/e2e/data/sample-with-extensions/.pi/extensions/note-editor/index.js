// Note-editor extension — exercises `pi.ui.editor` end to end.
//
// `/edit-note [prefill]` opens the modal editor; the result flows
// back through the promise returned by `ctx.ui.editor`. The extension
// surfaces the accepted text via a status chip + title so the spec
// can assert on DOM state (`data-testid="extension-status-chip"` and
// `data-testid="extension-title"`) without depending on filesystem
// writes (extensions have no direct vault-write API in 2b).
//
// `/edit-note-async` opens the editor and then calls `setEditorText`
// after a tiny delay to verify the buffer-mutation verb. The spec
// asserts by clicking "Save" and seeing the late-bound text surface.
export default function noteEditorExtension(pi) {
  pi.registerCommand('edit-note', {
    description: 'Open the editor dialog and surface the result via status chip + title.',
    handler: async (args, ctx) => {
      const prefill = args.trim();
      ctx.ui.setStatus('editing…');
      const result = await ctx.ui.editor('Edit note', prefill.length === 0 ? 'initial' : prefill, {
        language: 'markdown',
        placeholder: 'type notes here',
      });
      ctx.ui.setStatus(null);
      if (result === undefined) {
        ctx.ui.setTitle('edit-note: cancelled');
        ctx.ui.notify('note-editor: cancelled', 'warning');
        return;
      }
      ctx.ui.setTitle(`edit-note: ${result}`);
      ctx.ui.notify(`note-editor: saved ${result}`, 'info');
    },
  });

  pi.registerCommand('edit-note-async', {
    description: 'Open editor and then call setEditorText to replace the buffer.',
    handler: async (_args, ctx) => {
      const editorPromise = ctx.ui.editor('Edit note (async)', 'before', {
        language: 'markdown',
      });
      // Allow the dialog to mount before we update the buffer. The
      // worker-side controller treats `setEditorText` as fire-and-
      // forget; when no editor is open (spec races) it becomes a no-op.
      await new Promise(resolve => setTimeout(resolve, 50));
      ctx.ui.setEditorText('after');
      const result = await editorPromise;
      if (result === undefined) {
        ctx.ui.setTitle('edit-note-async: cancelled');
      } else {
        ctx.ui.setTitle(`edit-note-async: ${result}`);
      }
    },
  });
}
