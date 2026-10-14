// Custom node views in the editor: tasks with a clickable checkbox, code blocks with a language
// picker, images (a note instead of a broken image while uploading).
import { t } from '@selfbound/core/i18n';
import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from 'prosemirror-view';
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
}

export function nodeViews(hooks: ViewHooks): Record<string, NodeViewConstructor> {
  return {
    list_item: (node, view, getPos) => new ItemView(node, view, getPos),
    code_block: (node, _view, getPos) => new CodeView(node, getPos, hooks.openLang),
    image: (node) => new ImageView(node),
  };
}
