// Custom node views in the editor: tasks with a clickable checkbox, code blocks with a language
// picker, info panels with a kind menu, images (a note instead of a broken image while uploading).
import { t } from '@selfbound/core/i18n';
import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from 'prosemirror-view';
import { calloutLabel } from '../blocks/callout.ts';
import { blockFor, type BlockRenderer } from '../blocks/registry.ts';
import { languageLabel } from '../languages.ts';
import { uploadNote } from '../uploadNote.ts';

class ItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLElement;
  box: HTMLInputElement | null = null;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('li');
    if (node.attrs.checked === null) {
      this.contentDOM = this.dom;
      return;
    }
    this.dom.className = 'task';
    const box = (this.box = document.createElement('input'));
    box.type = 'checkbox';
    box.contentEditable = 'false';
    box.tabIndex = -1;
    box.dataset.testid = 'editor-task';
    box.setAttribute('aria-label', t('Done'));
    // No focus change on tap; the cursor stays where it was.
    box.addEventListener('mousedown', (e) => e.preventDefault());
    // No preventDefault on click: the browser would reset the check mark afterwards.
    box.addEventListener('click', () => {
      const pos = this.getPos();
      if (pos === undefined || !this.view.editable) return this.sync();
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { checked: !this.node.attrs.checked }));
    });
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'task-body';
    this.dom.append(box, this.contentDOM);
    this.sync();
  }

  private sync() {
    if (!this.box) return;
    const done = this.node.attrs.checked === true;
    this.box.checked = done;
    this.dom.classList.toggle('done', done);
  }

  update(node: Node) {
    if (node.type !== this.node.type || (node.attrs.checked === null) !== (this.node.attrs.checked === null)) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event) {
    return event.target === this.box;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return mutation.target === this.box;
  }
}

/** Code block as in the rendered view (`.codeblock`), with the language as a button at the top right. */
class CodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private pre: HTMLPreElement;
  private bar: HTMLElement;
  private button: HTMLButtonElement;

  constructor(
    private node: Node,
    getPos: () => number | undefined,
    openLang: (pos: number, anchor: HTMLElement) => void,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'codeblock';
    this.pre = document.createElement('pre');
    this.pre.spellcheck = false;
    this.contentDOM = document.createElement('code');
    this.pre.append(this.contentDOM);
    this.bar = document.createElement('div');
    this.bar.className = 'codebar';
    this.bar.contentEditable = 'false';
    const button = (this.button = document.createElement('button'));
    button.type = 'button';
    button.tabIndex = -1;
    button.title = t('Choose language');
    button.dataset.testid = 'code-lang';
    button.setAttribute('aria-haspopup', 'listbox');
    // The cursor stays in the text until the picker opens.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      const pos = getPos();
      if (pos !== undefined) openLang(pos, button);
    });
    this.bar.append(button);
    this.dom.append(this.pre, this.bar);
    this.sync();
  }

  private sync() {
    const lang = String(this.node.attrs.lang ?? '');
    if (lang) this.pre.dataset.lang = lang;
    else delete this.pre.dataset.lang;
    this.button.className = lang ? 'codelang' : 'codelang empty';
    this.button.textContent = languageLabel(lang);
    this.syncPreview(blockFor(lang));
  }

  // Live preview under the source for languages a visual-block renderer claims (```mermaid).
  private preview: HTMLElement | null = null;
  private drawn = '';
  private renderer: BlockRenderer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private unTheme: (() => void) | null = null;

  private syncPreview(renderer: BlockRenderer | null) {
    if (!renderer) {
      this.stopPreview();
      return;
    }
    if (!this.preview) {
      this.preview = document.createElement('div');
      this.preview.className = 'vblock-preview';
      this.preview.contentEditable = 'false';
      this.dom.append(this.preview);
    }
    const source = this.node.textContent;
    const key = `${renderer.id}\u0000${source}`;
    this.renderer = renderer;
    this.dom.dataset.block = renderer.id;
    if (key === this.drawn && this.preview.firstChild) return;
    this.drawn = key;
    if (this.timer) clearTimeout(this.timer);
    // Debounced: the drawing must not slow typing down.
    this.timer = setTimeout(() => void this.draw(renderer, source), 250);
    if (renderer.themed && !this.unTheme) {
      void import('../blocks/theme.ts').then(({ onThemeChange }) => {
        if (this.preview && !this.unTheme) this.unTheme = onThemeChange(() => this.renderer && void this.draw(this.renderer, this.node.textContent));
      });
    }
  }

  private async draw(renderer: BlockRenderer, source: string) {
    const preview = this.preview;
    if (!preview) return;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const { drawBlock, failureText } = await import('../blocks/mount.ts');
    if (abort.signal.aborted) return;
    // The last good drawing stays while the text is incomplete; a note says what is wrong.
    const host = document.createElement('div');
    host.className = 'vblock-view';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', renderer.label());
    // Laid out but invisible until it is drawn, so the last good drawing does not jump.
    host.style.cssText = 'position: absolute; inset-inline: 0; visibility: hidden';
    preview.prepend(host);
    const error = await drawBlock(renderer, source, host, abort.signal);
    if (abort.signal.aborted) return host.remove();
    preview.querySelector(':scope > .vblock-error')?.remove();
    if (error === null) {
      for (const old of preview.querySelectorAll(':scope > .vblock-view')) if (old !== host) old.remove();
      host.style.cssText = '';
      return;
    }
    host.remove(); // the last good drawing stays
    const note = document.createElement('p');
    note.className = 'vblock-error';
    note.setAttribute('role', 'status');
    note.textContent = failureText(renderer, error);
    preview.append(note);
  }

  private stopPreview() {
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    this.unTheme?.();
    this.unTheme = null;
    this.timer = null;
    this.drawn = '';
    this.renderer = null;
    delete this.dom.dataset.block;
    this.preview?.remove();
    this.preview = null;
  }

  destroy() {
    this.stopPreview();
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event) {
    return this.bar.contains(event.target as globalThis.Node);
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

/**
 * Info panel as in the rendered view (`.callout`). The symbol is a button that opens the kind
 * menu; the title and the content are edited in place. Without a title, the kind's name shows as a hint.
 */
class CalloutView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private icon: HTMLButtonElement;

  constructor(
    private node: Node,
    getPos: () => number | undefined,
    openKind: (pos: number, anchor: HTMLElement) => void,
  ) {
    this.dom = document.createElement('div');
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'callout-inner';
    const icon = (this.icon = document.createElement('button'));
    icon.type = 'button';
    icon.tabIndex = -1;
    icon.contentEditable = 'false';
    icon.className = 'callout-icon';
    icon.title = t('Change panel type');
    icon.dataset.testid = 'callout-kind';
    icon.setAttribute('aria-label', t('Change panel type'));
    icon.setAttribute('aria-haspopup', 'menu');
    // The cursor stays in the text until the menu opens.
    icon.addEventListener('mousedown', (e) => e.preventDefault());
    icon.addEventListener('click', () => {
      const pos = getPos();
      if (pos !== undefined) openKind(pos, icon);
    });
    this.dom.append(icon, this.contentDOM);
    this.sync();
  }

  private sync() {
    const kind = String(this.node.attrs.kind);
    this.dom.className = this.node.child(0).content.size ? `callout callout-${kind}` : `callout callout-${kind} untitled`;
    this.dom.style.setProperty('--label', JSON.stringify(calloutLabel(kind as Parameters<typeof calloutLabel>[0])));
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event) {
    return event.target === this.icon;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

class ImageView implements NodeView {
  dom: HTMLElement;

  constructor(node: Node) {
    const src = String(node.attrs.src);
    const alt = String(node.attrs.alt ?? '');
    if (src.startsWith('#upload-')) {
      const note = document.createElement('span');
      const { text, failed } = uploadNote(alt);
      note.className = failed ? 'upload-note failed' : 'upload-note';
      note.textContent = text;
      this.dom = note;
      return;
    }
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    if (node.attrs.title) img.title = String(node.attrs.title);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.draggable = true;
    this.dom = img;
  }

  // Redraw as soon as the source changes (placeholder → finished image).
  update() {
    return false;
  }
}

export interface ViewHooks {
  /** Open the language picker for the code block at `pos` */
  openLang: (pos: number, anchor: HTMLElement) => void;
  /** Open the kind menu of the info panel at `pos` */
  openKind: (pos: number, anchor: HTMLElement) => void;
}

export function nodeViews(hooks: ViewHooks): Record<string, NodeViewConstructor> {
  return {
    list_item: (node, view, getPos) => new ItemView(node, view, getPos),
    code_block: (node, _view, getPos) => new CodeView(node, getPos, hooks.openLang),
    callout: (node, _view, getPos) => new CalloutView(node, getPos, hooks.openKind),
    image: (node) => new ImageView(node),
  };
}
