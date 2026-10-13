// Load the editor (its own chunk with ProseMirror, editor/RichEditor.svelte) only when editing
// starts: click into the description, focus in the comment field, "Edit" on a comment. Until then
// (and if loading fails) the Markdown textarea stays.
type EditorModule = typeof import('./editor/RichEditor.svelte');

let loaded: EditorModule | null = null;
let loading: Promise<EditorModule> | null = null;

export function loadEditor(): Promise<EditorModule> {
  loading ??= import('./editor/RichEditor.svelte').then(
    (mod) => (loaded = mod),
    (error) => {
      loading = null; // retry next time
      throw error;
    },
  );
  return loading;
}

/** Already loaded? Then skip the textarea. */
export function editorModule(): EditorModule | null {
  return loaded;
}
