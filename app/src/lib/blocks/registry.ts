// Visual blocks with their own renderer: a fenced block whose language a renderer claims
// (```mermaid) is drawn instead of shown as code. This is the extension point: add a renderer to
// `BLOCKS` and write its module; nothing else changes (markdownRender.ts claims the fence,
// mount.ts draws it, the editor shows a live preview under the source).
//
// A renderer module is loaded with a dynamic import, only when a text contains such a block and the
// block becomes visible, so none of it is in the start bundle. Until then, and whenever drawing
// fails, the block stays readable as source.

export interface BlockContext {
  /** Aborted when the block leaves the page or is drawn again; stop work then. */
  signal: AbortSignal;
}

export interface BlockModule {
  /**
   * Replace the content of `host` with the drawing of `source`. Throw an `Error` with a readable
   * message if the text is invalid (it is shown below the source). The output must be safe: build
   * DOM nodes, or pass markup through `sanitizeSvg` / DOMPurify. `host` is empty and connected.
   */
  render(source: string, host: HTMLElement, ctx: BlockContext): void | Promise<void>;
}

export interface BlockRenderer {
  id: string;
  /** Fence languages (lower case) this renderer claims */
  langs: readonly string[];
  /** Short name for the accessible label ("Diagram"); translated when called */
  label: () => string;
  /** Does the drawing contain fixed colors? Then it is drawn again when the theme changes. Drawings that use the app's CSS variables need no redraw. */
  themed?: boolean;
  load: () => Promise<BlockModule>;
}

/** Registered renderers. Add one line per renderer. */
export const BLOCKS: BlockRenderer[] = [];

/** Renderer that claims the code block's info string (`mermaid`, `mermaid title=…`), or null. */
export function blockFor(info: string | undefined, blocks: readonly BlockRenderer[] = BLOCKS): BlockRenderer | null {
  const lang = (info ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!lang) return null;
  return blocks.find((b) => b.langs.includes(lang)) ?? null;
}

const loaded = new Map<string, Promise<BlockModule>>();

/** Loads a renderer's module once; a failed load is forgotten so the next attempt retries. */
export function loadBlock(renderer: BlockRenderer): Promise<BlockModule> {
  let promise = loaded.get(renderer.id);
  if (!promise) {
    promise = renderer.load();
    loaded.set(renderer.id, promise);
    promise.catch(() => loaded.delete(renderer.id));
  }
  return promise;
}
