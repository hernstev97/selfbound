<script lang="ts" module>
  import type { ImageField } from '../imageInput.ts';

  /** What an editor offers to its surroundings (image button, focus, report now). */
  export interface EditorApi extends ImageField {
    focus(): void;
    /** Pass a pending change to `onchange` right away. */
    flush(): void;
  }
</script>

<script lang="ts">
  // Editor for descriptions and comments: edits the formatted text directly, stores Markdown.
  // Loaded as its own chunk, only when editing starts (lib/richtext.ts).
  //
  // Text flows both ways: changes go to `onchange` (long texts batched, 120 ms); if `value` brings in
  // a different text than the one last reported (another version adopted, an image finished
  // elsewhere, comment sent), the document is replaced.
  import { Fragment, Slice, type Node } from 'prosemirror-model';
  import { EditorState, TextSelection } from 'prosemirror-state';
  import { EditorView } from 'prosemirror-view';
  import { onDestroy, untrack } from 'svelte';
  import { imageFiles, insertImages, pickImages, type ImageRef, type UploadTarget } from '../imageInput.ts';
  import LangPicker from '../../components/LangPicker.svelte';
  import { CALLOUT_KINDS, calloutLabel, type CalloutKind } from '../blocks/callout.ts';
  import { codeToText, insertCallout, insertRule, insertTable, quote, setBlock, setCalloutKind, toggleList, unwrapCallout } from './commands.ts';
  import { markdownFragment, parseMarkdown, type Source } from './parse.ts';
  import { closeSlash, plugins, slashKey } from './plugins.ts';
  import { app } from '../../app-instance.ts';
  import { t } from '@selfbound/core/i18n';
  import { schema } from './schema.ts';
  import { serializeMarkdown } from './serialize.ts';
  import { alignColumn, canDeleteColumn, canDeleteRow, columnAlign, isInTable, tableCommands, type Align } from './table.ts';
  import { nodeViews } from './views.ts';

  interface Props {
    value: string;
    onchange: (markdown: string) => void;
    placeholder?: string;
    /** Image insertion allowed (Ctrl V, drag and drop, "/" menu) */
    upload?: UploadTarget;
    /** Ctrl Enter; true = handled */
    onsubmit?: () => boolean | void;
    /** Esc; true = handled (otherwise Esc only leaves the field) */
    onescape?: () => boolean | void;
    onblur?: () => void;
    onfocus?: () => void;
    /** Focus on mount: at a screen position (click into the rendered text) or at the end */
    focusAt?: { x: number; y: number } | 'end' | null;
    testid?: string;
    class?: string;
    label?: string;
    /** Where uploaded images go (default: this editor) */
    imageField?: ImageField;
    onready?: (api: EditorApi | null) => void;
  }

  let { value, onchange, placeholder = '', upload, onsubmit, onescape, onblur, onfocus, focusAt = null, testid, class: cls = '', label, imageField, onready }: Props = $props();

  const n = schema.nodes;
  let view: EditorView | null = null;
  let source: Source | null = null;
  // Read the Svelte prop once: the editor takes over from here (value is watched below).
  // svelte-ignore state_referenced_locally
  let lastEmitted = value;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** From this document size (characters) on, reports are batched. */
  const LONG_DOC = 20_000;

  // ---------------------------------------------------------------- "/" menu

  interface Item {
    id: string;
    label: string;
    hint: string;
    words: string;
    run: () => void;
  }

  const cmd = (fn: (state: EditorState, dispatch: EditorView['dispatch']) => boolean) => () => {
    if (view) fn(view.state, view.dispatch);
  };

  // German search words per panel kind
  const CALLOUT_WORDS: Record<CalloutKind, string> = { info: 'info', note: 'hinweis notiz', success: 'erfolg', warning: 'warnung achtung', error: 'fehler' };

  // Labels are translated here (component script, runs at mount); `words` are search synonyms in
  // English and German.
  const ITEMS: Item[] = [
    { id: 'text', label: t('Text'), hint: '', words: 'text paragraph absatz', run: cmd(setBlock(n.paragraph)) },
    { id: 'h1', label: t('Heading 1'), hint: '#', words: 'heading h1 title überschrift titel', run: cmd(setBlock(n.heading, { level: 1 })) },
    { id: 'h2', label: t('Heading 2'), hint: '##', words: 'heading h2 überschrift', run: cmd(setBlock(n.heading, { level: 2 })) },
    { id: 'h3', label: t('Heading 3'), hint: '###', words: 'heading h3 überschrift', run: cmd(setBlock(n.heading, { level: 3 })) },
    { id: 'bullet', label: t('Bulleted list'), hint: '-', words: 'bullet list ul aufzählung liste punkte', run: cmd(toggleList(n.bullet_list)) },
    { id: 'ordered', label: t('Numbered list'), hint: '1.', words: 'ordered numbered list ol nummeriert liste', run: cmd(toggleList(n.ordered_list)) },
    { id: 'task', label: t('Checklist'), hint: '[ ]', words: 'checklist todo task checkbox checkliste aufgaben', run: cmd(toggleList(n.bullet_list, true)) },
    { id: 'quote', label: t('Quote'), hint: '>', words: 'quote blockquote zitat', run: cmd(quote) },
    { id: 'code', label: t('Code block'), hint: '```', words: 'code codeblock snippet', run: cmd(setBlock(n.code_block)) },
    ...CALLOUT_KINDS.map((kind): Item => ({
      id: `callout-${kind}`,
      label: t('Panel: {kind}', { kind: calloutLabel(kind) }),
      hint: `[!${kind.toUpperCase()}]`,
      words: `panel callout alert box infobox ${kind} ${CALLOUT_WORDS[kind]}`,
      run: cmd(insertCallout(kind)),
    })),
    { id: 'table', label: t('Table'), hint: '', words: 'table tabelle', run: cmd(insertTable) },
    { id: 'rule', label: t('Divider'), hint: '---', words: 'divider rule line hr trennlinie linie', run: cmd(insertRule) },
  ];
  const IMAGE_ITEM: Item = { id: 'image', label: t('Image'), hint: '', words: 'image photo screenshot picture bild foto', run: () => pickImages(imageField ?? api, upload!) };
  // Wiki: link to a wiki page, only offered when some team has a wiki.
  const PAGE_ITEM: Item = { id: 'page', label: t('Link wiki page'), hint: '[[', words: 'wiki page link docs wissen seite verlinken doku', run: () => linkPage() };
  const wikiOn = () => app.store.meta.get()?.teams.some((t) => t.wiki) ?? false;

  /** Pick a page (palette), then insert `[Title](<app>/wiki/<id>)` at the cursor. */
  function linkPage() {
    const v = view;
    if (!v) return;
    app.palette.pickArticle((page) => {
      if (!v.dom.isConnected) return;
      v.focus();
      const mark = schema.marks.link.create({ href: `${location.origin}/wiki/${page.id}` });
      const { from, to } = v.state.selection;
      v.dispatch(v.state.tr.replaceWith(from, to, schema.text(page.title, [mark])).insertText(' ', from + page.title.length).scrollIntoView());
    });
  }

  let slash = $state<{ query: string; x: number; y: number; below: boolean } | null>(null);
  let slashIndex = $state(0);
  const items = $derived.by(() => {
    if (!slash) return [];
    // A panel does not fit everywhere (list items, table cells): then the entries are not offered.
    const panels = view ? insertCallout('info')(view.state) : true;
    const all = [...ITEMS.filter((i) => panels || !i.id.startsWith('callout-')), ...(upload ? [IMAGE_ITEM] : []), ...(wikiOn() ? [PAGE_ITEM] : [])];
    const q = slash.query.toLowerCase();
    return q ? all.filter((i) => i.label.toLowerCase().includes(q) || i.words.includes(q)) : all;
  });

  function chooseSlash(item: Item | undefined) {
    if (!view || !item) return;
    const state = slashKey.getState(view.state);
    if (state?.from != null) {
      // Remove "/abc", then apply the block
      view.dispatch(view.state.tr.delete(state.from, view.state.selection.from).setMeta(slashKey, { close: true }));
    }
    item.run();
    view.focus();
  }

  function slashKeyDown(event: KeyboardEvent): boolean {
    if (!view || !slash) return false;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    if (event.key === 'ArrowDown') {
      slashIndex = (slashIndex + 1) % Math.max(1, items.length);
      return stop();
    }
    if (event.key === 'ArrowUp') {
      slashIndex = (slashIndex - 1 + items.length) % Math.max(1, items.length);
      return stop();
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && items.length) {
      chooseSlash(items[slashIndex]);
      return stop();
    }
    if (event.key === 'Escape') {
      closeSlash(view);
      return stop();
    }
    return false;
  }

  function syncSlash() {
    const state = view ? slashKey.getState(view.state) : null;
    if (!view || !state || state.from === null) {
      slash = null;
      return;
    }
    const prevQuery = slash?.query;
    const at = view.coordsAtPos(state.from);
    const below = at.bottom + 320 < innerHeight;
    slash = { query: state.query, x: Math.min(at.left, innerWidth - 260), y: below ? at.bottom + 4 : at.top - 4, below };
    if (prevQuery !== state.query) slashIndex = 0;
  }

  // ---------------------------------------------------------------- Code block language

  let langPick = $state<{ pos: number; current: string; anchor: DOMRect; button: HTMLElement } | null>(null);

  function openLang(pos: number, anchor: HTMLElement) {
    const node = view?.state.doc.nodeAt(pos);
    if (!view || node?.type !== n.code_block) return;
    langPick = { pos, current: String(node.attrs.lang ?? ''), anchor: anchor.getBoundingClientRect(), button: anchor };
    anchor.setAttribute('aria-expanded', 'true');
  }

  function closeLang(refocus = true) {
    langPick?.button.removeAttribute('aria-expanded');
    langPick = null;
    if (refocus) view?.focus();
  }

  function pickLang(lang: string) {
    if (!view || !langPick) return;
    const node = view.state.doc.nodeAt(langPick.pos);
    if (node?.type === n.code_block && node.attrs.lang !== lang) view.dispatch(view.state.tr.setNodeMarkup(langPick.pos, null, { ...node.attrs, lang }));
    closeLang();
  }

  const LANG_ACTIONS = [
    {
      id: 'to-text',
      label: t('Convert to text'),
      run: () => {
        if (!view || !langPick) return;
        const pos = langPick.pos;
        closeLang();
        codeToText(pos)(view.state, view.dispatch);
      },
    },
  ];

  // ---------------------------------------------------------------- Tables

  /** Button at the edge of the current cell (relative to the editor), and the open menu */
  let tableHandle = $state<{ x: number; y: number } | null>(null);
  let tableMenu = $state<{ x: number; y: number; cell: number; align: Align; deleteRow: boolean; deleteColumn: boolean } | null>(null);
  let host = $state<HTMLElement>();

  interface TableItem {
    id: string;
    label: string;
    keys?: string;
    run: () => void;
    disabled?: boolean;
    checked?: boolean;
    danger?: boolean;
  }

  const tcmd = (fn: (state: EditorState, dispatch: EditorView['dispatch']) => boolean) => () => {
    if (!view) return;
    fn(view.state, view.dispatch);
    tableMenu = null;
    view.focus();
  };

  const tableItems = $derived.by((): TableItem[][] => {
    const m = tableMenu;
    if (!m) return [];
    return [
      [
        { id: 'row-before', label: t('Insert row above'), keys: t('Ctrl Alt ↑'), run: tcmd(tableCommands.rowBefore) },
        { id: 'row-after', label: t('Insert row below'), keys: t('Ctrl Alt ↓'), run: tcmd(tableCommands.rowAfter) },
        { id: 'col-before', label: t('Insert column left'), keys: t('Ctrl Alt ←'), run: tcmd(tableCommands.columnBefore) },
        { id: 'col-after', label: t('Insert column right'), keys: t('Ctrl Alt →'), run: tcmd(tableCommands.columnAfter) },
      ],
      [
        { id: 'align-left', label: t('Align column left'), run: tcmd(alignColumn(m.align === 'left' ? null : 'left')), checked: m.align === 'left' },
        { id: 'align-center', label: t('Center column'), run: tcmd(alignColumn(m.align === 'center' ? null : 'center')), checked: m.align === 'center' },
        { id: 'align-right', label: t('Align column right'), run: tcmd(alignColumn(m.align === 'right' ? null : 'right')), checked: m.align === 'right' },
      ],
      [
        { id: 'row-delete', label: t('Delete row'), keys: t('Ctrl Alt ⌫'), run: tcmd(tableCommands.deleteRow), disabled: !m.deleteRow, danger: true },
        { id: 'col-delete', label: t('Delete column'), keys: t('Ctrl Alt ⇧ ⌫'), run: tcmd(tableCommands.deleteColumn), disabled: !m.deleteColumn, danger: true },
        { id: 'table-delete', label: t('Delete table'), run: tcmd(tableCommands.deleteTable), danger: true },
      ],
    ];
  });

  /** Position of the cell at the cursor, or -1 */
  function cellPos(state: EditorState): number {
    const head = state.selection.$head;
    for (let d = head.depth; d > 0; d--) {
      const role = head.node(d).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') return head.before(d);
    }
    return -1;
  }

  /** Current cell (DOM) or null */
  function currentCell(): HTMLElement | null {
    if (!view || !isInTable(view.state)) return null;
    const pos = cellPos(view.state);
    return pos < 0 ? null : (view.nodeDOM(pos) as HTMLElement | null);
  }

  function syncTable() {
    const cell = view?.hasFocus() || tableMenu ? currentCell() : null;
    if (!cell || !host) {
      tableHandle = null;
      tableMenu = null;
      return;
    }
    const c = cell.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    tableHandle = { x: c.right - h.left - 20, y: c.top - h.top + 4 };
  }

  function openTableMenu(at?: { x: number; y: number }) {
    if (!view || !isInTable(view.state)) return;
    const state = view.state;
    let x = at?.x ?? 0;
    let y = at?.y ?? 0;
    if (!at) {
      const cell = currentCell()?.getBoundingClientRect();
      if (!cell) return;
      x = cell.right - 20;
      y = cell.top + 26;
    }
    tableMenu = {
      x: Math.max(8, Math.min(x, innerWidth - 268)),
      y: Math.min(y, innerHeight - 380),
      cell: cellPos(state),
      align: columnAlign(state),
      deleteRow: canDeleteRow(state),
      deleteColumn: canDeleteColumn(state),
    };
  }

  // ---------------------------------------------------------------- Info panel kind

  let kindMenu = $state<{ pos: number; kind: CalloutKind; x: number; y: number } | null>(null);

  function openKind(pos: number, anchor: HTMLElement) {
    const node = view?.state.doc.nodeAt(pos);
    if (!view || node?.type !== n.callout) return;
    const box = anchor.getBoundingClientRect();
    kindMenu = { pos, kind: node.attrs.kind as CalloutKind, x: Math.max(8, Math.min(box.left, innerWidth - 268)), y: Math.min(box.bottom + 4, innerHeight - 260) };
  }

  const kindItems = $derived(
    kindMenu
      ? CALLOUT_KINDS.map((kind) => ({ id: kind, label: calloutLabel(kind), checked: kindMenu!.kind === kind, run: () => applyKind(setCalloutKind(kindMenu!.pos, kind)) }))
      : [],
  );

  function applyKind(fn: (state: EditorState, dispatch: EditorView['dispatch']) => boolean) {
    if (!view) return;
    fn(view.state, view.dispatch);
    kindMenu = null;
    view.focus();
  }

  // ---------------------------------------------------------------- Link (Ctrl K)

  let link = $state<{ from: number; to: number; href: string; x: number; y: number } | null>(null);
  let linkInput = $state<HTMLInputElement | null>(null);

  function openLink(): boolean {
    if (!view) return false;
    const { state } = view;
    let { from, to } = state.selection;
    const type = schema.marks.link;
    // Code blocks and raw source blocks have no links; still swallow the key
    // (otherwise the browser jumps to its search bar).
    if (!state.selection.$from.parent.type.allowsMarkType(type)) return true;
    let href = '';
    // Cursor inside a link: edit the whole link
    const at = state.doc.resolve(from);
    const mark = type.isInSet(at.marks()) ?? (from < to && state.doc.rangeHasMark(from, to, type) ? type.isInSet(state.doc.resolve(from + 1).marks()) : undefined);
    if (mark) {
      href = String(mark.attrs.href);
      if (from === to) {
        const parent = at.parent;
        const start = at.start();
        let a = from;
        let b = from;
        parent.forEach((child, offset) => {
          const s = start + offset;
          const e = s + child.nodeSize;
          if (mark.isInSet(child.marks) && s <= from && e >= from) {
            a = s;
            b = e;
          }
        });
        from = a;
        to = b;
      }
    }
    const coords = view.coordsAtPos(from);
    link = { from, to, href, x: Math.min(coords.left, innerWidth - 340), y: coords.bottom + 6 };
    queueMicrotask(() => linkInput?.focus());
    return true;
  }

  function applyLink(href: string) {
    if (!view || !link) return;
    const { from, to } = link;
    const type = schema.marks.link;
    const tr = view.state.tr;
    const url = href.trim();
    if (!url) tr.removeMark(from, to, type);
    else if (from === to) {
      tr.insert(from, schema.text(url, [type.create({ href: url })]));
      tr.setSelection(TextSelection.create(tr.doc, from + url.length));
    } else {
      tr.removeMark(from, to, type).addMark(from, to, type.create({ href: url }));
    }
    view.dispatch(tr);
    closeLink();
  }

  function closeLink() {
    link = null;
    view?.focus();
  }

  // ---------------------------------------------------------------- Images

  function imageNodes(images: ImageRef[], inCell: boolean): Node[] {
    const out: Node[] = [];
    images.forEach((img, i) => {
      if (i) out.push(inCell ? schema.text(' ') : n.hard_break.create());
      out.push(n.image.create({ src: img.src, alt: img.alt }));
    });
    return out;
  }

  const api: EditorApi = {
    insertImages(images) {
      if (!view) return;
      const { state } = view;
      const { $from: start, $to: end } = state.selection;
      const tr = state.tr;
      if (start.parent.type.spec.code || !start.parent.inlineContent) {
        // In a code block or on a block node: as a new paragraph after it
        const pos = start.parent.inlineContent ? start.after() : end.pos;
        tr.insert(pos, n.paragraph.create(null, imageNodes(images, false)));
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1));
      } else {
        const inCell = start.parent.type.spec.tableRole !== undefined;
        const nodes = imageNodes(images, inCell);
        // Each image on its own line (as in the Markdown text field)
        if (start.parentOffset > 0) nodes.unshift(inCell ? schema.text(' ') : n.hard_break.create());
        if (end.parentOffset < end.parent.content.size) nodes.push(inCell ? schema.text(' ') : n.hard_break.create());
        tr.replaceWith(start.pos, end.pos, nodes);
      }
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
    replaceImage(id, next) {
      if (!view) return false;
      let found = -1;
      view.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.type === n.image && node.attrs.src === `#upload-${id}`) found = pos;
        return true;
      });
      if (found < 0) return false;
      const node = view.state.doc.nodeAt(found)!;
      // Not added to history: undo must not turn the finished image back into the placeholder.
      view.dispatch(view.state.tr.setNodeMarkup(found, null, { ...node.attrs, src: next.src, alt: next.alt }).setMeta('addToHistory', false));
      return true;
    },
    get connected() {
      return !!view && !view.isDestroyed && view.dom.isConnected;
    },
    focus() {
      view?.focus();
    },
    flush,
  };

  // ---------------------------------------------------------------- Text in and out

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!view) return;
    const markdown = serializeMarkdown(view.state.doc, source);
    if (markdown === lastEmitted) return;
    lastEmitted = markdown;
    onchange(markdown);
  }

  function createState(markdown: string) {
    const parsed = parseMarkdown(markdown);
    source = parsed.source;
    return EditorState.create({
      doc: parsed.doc,
      plugins: plugins({
        placeholder: () => placeholder,
        slashKey: slashKeyDown,
        flush,
        escape: () => {
          if (tableMenu || kindMenu) {
            tableMenu = null;
            kindMenu = null;
            return true;
          }
          if (onescape?.() === true) return true;
          return false;
        },
        submit: () => onsubmit?.() === true,
        link: openLink,
      }),
    });
  }

  $effect(() => {
    const next = value;
    if (!view || next === lastEmitted) return;
    // Changed from outside: replace the document, cursor to the end
    if (timer) clearTimeout(timer);
    timer = null;
    lastEmitted = next;
    const state = createState(next);
    view.updateState(state);
    if (view.hasFocus()) view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  });

  function mount(el: HTMLElement) {
    const editor = new EditorView(
      { mount: el },
      {
        state: createState(lastEmitted),
        nodeViews: nodeViews({ openLang, openKind }),
        attributes: {
          class: `md rich ${cls}`.trim(),
          role: 'textbox',
          'aria-multiline': 'true',
          ...(label || placeholder ? { 'aria-label': label ?? placeholder } : {}),
          ...(testid ? { 'data-testid': testid } : {}),
          spellcheck: 'true',
        },
        dispatchTransaction(tr) {
          const state = editor.state.apply(tr);
          editor.updateState(state);
          if (tr.docChanged) {
            if (timer) clearTimeout(timer);
            timer = null;
            // Report short texts at once (no window in which typed text has not reached the
            // draft yet); batch long ones so typing stays smooth.
            if (state.doc.content.size < LONG_DOC) flush();
            else timer = setTimeout(flush, 120);
          }
          syncSlash();
          // Close the menu as soon as the text changes or the cursor leaves the cell
          if (tableMenu && (tr.docChanged || cellPos(state) !== tableMenu.cell)) tableMenu = null;
          if (kindMenu && (tr.docChanged || tr.selectionSet)) kindMenu = null;
          syncTable();
        },
        // "[[" opens the wiki page picker (as in many wikis).
        handleTextInput(v, from, to, text) {
          if (text !== '[' || !wikiOn() || from < 1 || v.state.doc.textBetween(from - 1, from) !== '[') return false;
          if (v.state.selection.$from.parent.type.spec.code) return false;
          v.dispatch(v.state.tr.delete(from - 1, to));
          linkPage();
          return true;
        },
        handlePaste(v, event) {
          const data = event.clipboardData;
          if (!data) return false;
          const text = data.getData('text/plain');
          if (!text && upload) {
            const files = imageFiles(data.files);
            if (files.length) {
              insertImages(imageField ?? api, files, upload);
              return true;
            }
          }
          // URL pasted over selected text: becomes a link
          const { from, to } = v.state.selection;
          if (from < to && /^https?:\/\/\S+$/.test(text.trim()) && !v.state.selection.$from.parent.type.spec.code) {
            v.dispatch(v.state.tr.addMark(from, to, schema.marks.link.create({ href: text.trim() })));
            return true;
          }
          return false;
        },
        handleDrop(v, event, _slice, moved) {
          if (moved || !upload) return false;
          const files = imageFiles((event as DragEvent).dataTransfer?.files);
          if (!files.length) return false;
          const pos = v.posAtCoords({ left: event.clientX, top: event.clientY });
          if (pos) v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos.pos))));
          insertImages(imageField ?? api, files, upload);
          return true;
        },
        // Pasted text is Markdown (agents, GitHub, other editors); inside code it stays plain text.
        clipboardTextParser(text, $context) {
          if ($context.parent.type.spec.code) return new Slice(Fragment.from(schema.text(text.replace(/\r\n?/g, '\n'))), 0, 0);
          return Slice.maxOpen(markdownFragment(text.replace(/\r\n?/g, '\n')));
        },
        clipboardTextSerializer(slice) {
          try {
            const content = slice.content.firstChild?.isInline ? Fragment.from(n.paragraph.create(null, slice.content)) : slice.content;
            return serializeMarkdown(n.doc.create(null, content));
          } catch {
            return slice.content.textBetween(0, slice.content.size, '\n\n');
          }
        },
        handleClick(_v, _pos, event) {
          // Ctrl/Cmd + click opens a link
          const a = (event.target as HTMLElement).closest('a');
          if (!a || !(event.ctrlKey || event.metaKey)) return false;
          window.open(a.href, '_blank', 'noopener,noreferrer');
          return true;
        },
        handleDOMEvents: {
          blur: () => {
            flush();
            onblur?.();
            tableMenu = null;
            kindMenu = null;
            queueMicrotask(syncTable);
            return false;
          },
          focus: () => {
            onfocus?.();
            queueMicrotask(syncTable);
            return false;
          },
          // Right click in a table: table menu instead of the browser menu
          contextmenu: (v, event) => {
            const pos = v.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!pos) return false;
            const at = v.state.doc.resolve(pos.pos);
            let inCell = false;
            for (let d = at.depth; d > 0; d--) if (at.node(d).type.spec.tableRole) inCell = true;
            if (!inCell) return false;
            event.preventDefault();
            if (!isInTable(v.state) || !v.state.selection.$head.sameParent(at)) v.dispatch(v.state.tr.setSelection(TextSelection.near(at)));
            openTableMenu({ x: event.clientX, y: event.clientY });
            return true;
          },
        },
      },
    );
    view = editor;
    // For tests and tools: the current text as Markdown (computed only when read).
    Object.defineProperty(el, 'markdown', { configurable: true, get: () => serializeMarkdown(editor.state.doc, source) });
    onready?.(api);
    if (focusAt) {
      let selection = TextSelection.atEnd(editor.state.doc);
      if (focusAt !== 'end') {
        const hit = editor.posAtCoords({ left: focusAt.x, top: focusAt.y });
        if (hit) selection = TextSelection.near(editor.state.doc.resolve(hit.pos));
      }
      editor.dispatch(editor.state.tr.setSelection(selection));
      editor.focus();
    }
    return () => {
      flush();
      onready?.(null);
      editor.destroy();
      view = null;
    };
  }

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });
</script>

<div class="rich-host" bind:this={host}>
  <!-- untrack: what mount reads on first focus (menus) must not rebuild the editor. -->
  <div {@attach (el) => untrack(() => mount(el))}></div>
  {#if tableHandle}
    <button
      type="button"
      class="table-handle"
      class:open={!!tableMenu}
      style:left="{tableHandle.x}px"
      style:top="{tableHandle.y}px"
      title={t('Table: rows and columns')}
      aria-label={t('Table menu')}
      aria-haspopup="menu"
      data-testid="table-handle"
      tabindex="-1"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => (tableMenu ? (tableMenu = null) : openTableMenu())}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
  {/if}
</div>

{#if tableMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="table-menu" role="menu" tabindex="-1" aria-label={t('Table')} data-testid="table-menu" style:left="{tableMenu.x}px" style:top="{tableMenu.y}px" onmousedown={(e) => e.preventDefault()}>
    {#each tableItems as group, g (g)}
      {#if g > 0}<div class="table-sep"></div>{/if}
      {#each group as item (item.id)}
        <button
          type="button"
          class={['table-item', item.danger && 'danger']}
          role="menuitem"
          data-testid="table-item"
          data-id={item.id}
          disabled={item.disabled}
          onclick={item.run}
        >
          <span class="table-check">{item.checked ? '✓' : ''}</span>
          <span class="grow">{item.label}</span>
          {#if item.keys}<kbd>{item.keys}</kbd>{/if}
        </button>
      {/each}
    {/each}
  </div>
{/if}

{#if kindMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="table-menu" role="menu" tabindex="-1" aria-label={t('Panel type')} data-testid="callout-menu" style:left="{kindMenu.x}px" style:top="{kindMenu.y}px" onmousedown={(e) => e.preventDefault()}>
    {#each kindItems as item (item.id)}
      <button type="button" class="table-item" role="menuitemradio" aria-checked={item.checked} data-testid="callout-menu-item" data-id={item.id} onclick={item.run}>
        <span class="table-check">{item.checked ? '✓' : ''}</span>
        <span class="grow">{item.label}</span>
      </button>
    {/each}
    <div class="table-sep"></div>
    <button type="button" class="table-item" role="menuitem" data-testid="callout-menu-item" data-id="to-quote" onclick={() => applyKind(unwrapCallout(kindMenu!.pos, true))}>
      <span class="table-check"></span>
      <span class="grow">{t('Turn into quote')}</span>
    </button>
    <button type="button" class="table-item" role="menuitem" data-testid="callout-menu-item" data-id="to-text" onclick={() => applyKind(unwrapCallout(kindMenu!.pos))}>
      <span class="table-check"></span>
      <span class="grow">{t('Turn into text')}</span>
    </button>
  </div>
{/if}

{#if langPick}
  <LangPicker current={langPick.current} anchor={langPick.anchor} onpick={pickLang} onclose={() => closeLang(false)} actions={LANG_ACTIONS} />
{/if}

{#if slash && items.length}
  <div class="slash-menu" role="listbox" aria-label={t('Insert block')} data-testid="slash-menu" style:left="{slash.x}px" style:top="{slash.y}px" class:above={!slash.below}>
    {#each items as item, i (item.id)}
      <button
        type="button"
        class={['slash-item', i === slashIndex && 'active']}
        role="option"
        aria-selected={i === slashIndex}
        data-testid="slash-item"
        data-id={item.id}
        onmousedown={(e) => e.preventDefault()}
        onmouseenter={() => (slashIndex = i)}
        onclick={() => chooseSlash(item)}
      >
        <span>{item.label}</span>
        {#if item.hint}<kbd>{item.hint}</kbd>{/if}
      </button>
    {/each}
  </div>
{/if}

{#if link}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="link-pop" style:left="{link.x}px" style:top="{link.y}px" data-testid="link-popover" onfocusout={(e) => !e.currentTarget.contains(e.relatedTarget as HTMLElement | null) && (link = null)}>
    <input
      bind:this={linkInput}
      value={link.href}
      placeholder="https://…"
      aria-label={t('Link URL')}
      data-testid="link-input"
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyLink(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeLink();
        }
      }}
    />
    {#if link.href}<button type="button" class="btn ghost small" onmousedown={(e) => e.preventDefault()} onclick={() => applyLink('')}>{t('Remove')}</button>{/if}
  </div>
{/if}

<style>
  :global(.rich) {
    outline: none;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-variant-ligatures: none;
    position: relative;
  }
  :global(.rich .is-empty::before) {
    content: attr(data-placeholder);
    color: var(--text-subtle);
    float: left;
    height: 0;
    pointer-events: none;
  }
  /* Tight list items as in the rendered view: no paragraph spacing */
  :global(.rich li > p),
  :global(.rich li > .task-body > p) {
    margin: 0;
  }
  :global(.rich li > :not(:first-child)) {
    margin-top: 0.35em;
  }
  :global(.rich li > .task-body > :not(:first-child)) {
    margin-top: 0.35em;
  }
  :global(.rich li > ul),
  :global(.rich li > ol),
  :global(.rich li > .task-body > ul),
  :global(.rich li > .task-body > ol) {
    margin-bottom: 0;
  }
  /* The checkbox itself: md.css (as in the rendered view) */
  :global(.rich li.task) {
    display: flex;
    align-items: flex-start;
  }
  :global(.rich li.task > .task-body) {
    flex: 1;
    min-width: 0;
    /* Text sits next to the checkbox, not below it (overrides `li > :not(:first-child)` above) */
    margin-top: 0;
  }
  :global(.rich li.task.done > .task-body > p) {
    color: var(--text-muted);
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklch, var(--text-muted) 60%, transparent);
  }
  :global(.rich pre) {
    position: relative;
    white-space: pre;
  }
  /* Language and copy: md.css (.codebar); room for the button at the top right */
  :global(.rich .codeblock pre) {
    padding-right: 96px;
  }
  /* Info panel: shared look in md.css (.callout); here the symbol is a button next to the title. */
  :global(.rich .callout) {
    position: relative;
  }
  :global(.rich .callout > button.callout-icon) {
    position: absolute;
    left: 12px;
    top: 13px;
    padding: 0;
    border: 0;
    cursor: pointer;
    border-radius: 4px;
  }
  :global(.rich .callout > button.callout-icon:hover) {
    filter: brightness(1.2);
  }
  :global(.rich .callout > button.callout-icon:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  :global(.rich .callout-title) {
    display: block;
    padding-left: 26px;
    min-height: 24px;
  }
  /* No title: the kind's name as a hint (set by CalloutView) */
  :global(.rich .callout.untitled .callout-title::before) {
    content: var(--label);
    float: left;
    height: 0;
    color: var(--text-subtle);
    font-weight: 400;
    pointer-events: none;
  }
  :global(.rich .callout-inner > :not(.callout-title)) {
    margin-left: 26px;
  }
  :global(.rich .callout-inner > :last-child) {
    margin-bottom: 0;
  }
  :global(.rich pre.raw-md) {
    border: 1px dashed var(--border-strong);
    background: none;
    color: var(--text-muted);
  }
  :global(.rich code.raw-inline) {
    color: var(--text-muted);
  }
  :global(.rich img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    vertical-align: top;
    box-shadow: 0 0 0 1px var(--border);
  }
  :global(.rich img.ProseMirror-selectednode),
  :global(.rich .upload-note.ProseMirror-selectednode) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  :global(.rich .upload-note) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    font-size: 0.92em;
  }
  :global(.rich .upload-note.failed) {
    color: var(--danger-text);
  }
  /* As in the rendered view (compact); empty cells stay wide enough to click. */
  :global(.rich table) {
    border-collapse: collapse;
    margin: 0 0 0.75em;
  }
  :global(.rich td),
  :global(.rich th) {
    vertical-align: top;
    min-width: 4em;
    position: relative;
  }
  :global(.rich th) {
    font-weight: 590;
    text-align: left;
  }
  :global(.rich .selectedCell::after) {
    content: '';
    position: absolute;
    inset: 0;
    background: color-mix(in oklch, var(--accent) 18%, transparent);
    pointer-events: none;
  }
  :global(.rich hr.ProseMirror-selectednode) {
    border-top-color: var(--accent);
  }
  :global(.rich .ProseMirror-gapcursor) {
    display: none;
    pointer-events: none;
    position: absolute;
  }
  :global(.rich .ProseMirror-gapcursor::after) {
    content: '';
    display: block;
    position: absolute;
    top: -2px;
    width: 20px;
    border-top: 1px solid var(--text);
    animation: gapcursor-blink 1.1s steps(2, start) infinite;
  }
  :global(.rich.ProseMirror-focused .ProseMirror-gapcursor) {
    display: block;
  }
  @keyframes gapcursor-blink {
    to {
      visibility: hidden;
    }
  }
  :global(.rich .ProseMirror-hideselection *::selection) {
    background: transparent;
  }
  .rich-host {
    position: relative;
  }
  .table-handle {
    position: absolute;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: var(--bg-control);
    color: var(--text-muted);
    box-shadow: 0 0 0 0.5px var(--border-strong);
    cursor: pointer;
  }
  .table-handle:hover,
  .table-handle.open {
    background: var(--bg-control-on);
    color: var(--text-strong);
  }
  .table-menu {
    position: fixed;
    z-index: 60;
    width: 260px;
    padding: 4px;
    border-radius: 12px;
    background: var(--bg-popover);
    box-shadow: var(--shadow-popover);
  }
  .table-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 30px;
    padding: 0 8px 0 4px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
    text-align: left;
    cursor: pointer;
  }
  .table-item:hover:not(:disabled) {
    background: var(--bg-row-hover);
    color: var(--text-strong);
  }
  .table-item.danger:hover:not(:disabled) {
    color: var(--danger-text);
  }
  .table-item:disabled {
    color: var(--text-faint);
    cursor: default;
  }
  .table-item .grow {
    flex: 1;
  }
  .table-check {
    width: 14px;
    flex: none;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }
  .table-item kbd {
    font-family: var(--font);
    font-size: 11px;
    color: var(--text-muted);
  }
  .table-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--border);
  }
  .slash-menu {
    position: fixed;
    z-index: 60;
    width: 240px;
    max-height: 312px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 12px;
    background: var(--bg-popover);
    box-shadow: var(--shadow-popover);
  }
  .slash-menu.above {
    transform: translateY(-100%);
  }
  .slash-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
    text-align: left;
    cursor: pointer;
  }
  .slash-item.active {
    background: var(--bg-row-hover);
    color: var(--text-strong);
  }
  .slash-item kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .link-pop {
    position: fixed;
    z-index: 60;
    display: flex;
    gap: 6px;
    align-items: center;
    width: 320px;
    padding: 6px;
    border-radius: 10px;
    background: var(--bg-popover);
    box-shadow: var(--shadow-popover);
  }
  .link-pop input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    outline: none;
    background: var(--bg-control);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-small);
  }
  @media (max-width: 768px) {
    :global(.rich) {
      font-size: 16px;
    }
    .slash-item,
    .table-item {
      height: 40px;
      font-size: 15px;
    }
    .link-pop input {
      font-size: 16px;
    }
  }
</style>
