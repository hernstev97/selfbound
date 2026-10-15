// Editor plugins: Markdown shortcuts while typing, keys, placeholder, syntax colors, "/" menu.
import { baseKeymap, chainCommands } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { goToNextCell, tableEditing } from 'prosemirror-tables';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { calloutKind } from '../blocks/callout.ts';
import type { CodeRange } from '../highlight.ts';
import {
  backspaceToParagraph,
  codeToText,
  cycleCalloutKind,
  enterFromCalloutTitle,
  exitCodeOnEmptyLine,
  fenceToCode,
  hardBreak,
  leaveLastBlock,
  liftItem,
  makeTask,
  setBlock,
  sinkItem,
  splitItem,
  toggle,
  toggleList,
} from './commands.ts';
import { schema } from './schema.ts';
import { nextCellOrRow, tableCommands, tableShape } from './table.ts';

const n = schema.nodes;
const m = schema.marks;

// ---------------------------------------------------------------- Markdown shortcuts

/** `**bold**` etc.: remove the markers, apply the mark. Group 1 = with markers, group 2 = content. */
function markRule(re: RegExp, type: MarkType, attrs?: (match: RegExpMatchArray) => Record<string, unknown>) {
  return new InputRule(re, (state, match, start, end) => {
    const [full, wrapped, content] = match as unknown as [string, string, string];
    const wrappedStart = start + full.lastIndexOf(wrapped);
    const contentStart = wrappedStart + wrapped.indexOf(content);
    const contentEnd = contentStart + content.length;
    // The last typed character is not in the document yet; `end` is the position before it.
    const tr = state.tr.delete(contentEnd, end).delete(wrappedStart, contentStart);
    const markEnd = contentEnd - (contentStart - wrappedStart);
    tr.addMark(wrappedStart, markEnd, type.create(attrs?.(match)));
    tr.removeStoredMark(type);
    return tr;
  });
}

const taskRule = new InputRule(/^\[( |x|X)?\]\s$/, (state, match, start, end) => {
  const tr = state.tr.delete(start, end);
  return makeTask(tr, start, /x/i.test(match[1] ?? ''));
});

const ruleRule = new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== n.paragraph || $start.depth !== 1) return null;
  const tr = state.tr.delete(start, end);
  const pos = $start.before();
  tr.replaceWith(pos, pos + tr.doc.resolve(pos).nodeAfter!.nodeSize, [n.horizontal_rule.create(), n.paragraph.create()]);
  tr.setSelection(TextSelection.create(tr.doc, pos + 2));
  return tr;
});

/** URL + space: becomes a link (as in the rendered view). */
const autolinkRule = new InputRule(/(?:^|\s)((?:https?:\/\/|www\.)[^\s<]+?)([.,;:!?)]*)\s$/, (state, match, start, end) => {
  const url = match[1]!;
  const urlStart = start + match[0].indexOf(url);
  const urlEnd = urlStart + url.length;
  if (state.doc.rangeHasMark(urlStart, urlEnd, m.link)) return null;
  const href = url.startsWith('www.') ? `http://${url}` : url;
  const tr = state.tr.addMark(urlStart, urlEnd, m.link.create({ href, auto: 'bare' }));
  return tr.insertText(' ', end).removeStoredMark(m.link);
});

/** In a quote's first line: `[!warning] ` (after `> `) turns the quote into an info panel. */
const calloutRule = new InputRule(/^\[!([A-Za-z]+)\]\s$/, (state, match, start) => {
  const kind = calloutKind(match[1]!);
  const $start = state.doc.resolve(start);
  // Only when the line holds nothing else (the rule replaces the whole quote's first paragraph).
  if (!kind || $start.parent.type !== n.paragraph || $start.depth < 2 || $start.parent.textContent !== match[0].trimEnd()) return null;
  const quote = $start.node($start.depth - 1);
  if (quote.type !== n.blockquote || $start.index($start.depth - 1) !== 0) return null;
  const pos = $start.before($start.depth - 1);
  // The typed paragraph is dropped; the rest of the quote becomes the content.
  const rest: Node[] = [];
  quote.forEach((child, _o, i) => {
    if (i > 0) rest.push(child);
  });
  const tr = state.tr.replaceWith(pos, pos + quote.nodeSize, n.callout.create({ kind, word: match[1]! }, [n.callout_title.create(), ...(rest.length ? rest : [n.paragraph.create()])]));
  return tr.setSelection(TextSelection.create(tr.doc, pos + 2));
});

function rules() {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (match) => ({ level: match[1]!.length })),
      wrappingInputRule(/^\s*>\s$/, n.blockquote),
      calloutRule,
      wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list, (match) => ({ bullet: match[1] })),
      wrappingInputRule(
        /^(\d+)([.)])\s$/,
        n.ordered_list,
        (match) => ({ order: Number(match[1]), delim: match[2] }),
        (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
      ),
      taskRule,
      textblockTypeInputRule(/^(`{3,}|~{3,})([\w#+.-]*)\s$/, n.code_block, (match) => ({ lang: match[2], fence: match[1]![0] })),
      ruleRule,
      markRule(/(?:^|[^\w*])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/, m.strong, () => ({ markup: '**' })),
      markRule(/(?:^|[^\w_])(__([^_\s](?:[^_]*[^_\s])?)__)$/, m.strong, () => ({ markup: '__' })),
      markRule(/(?:^|[^\w*])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, m.em, () => ({ markup: '*' })),
      markRule(/(?:^|[^\w_])(_([^_\s](?:[^_]*[^_\s])?)_)$/, m.em, () => ({ markup: '_' })),
      markRule(/(?:^|[^~])(~~([^~\s](?:[^~]*[^~\s])?)~~)$/, m.strike),
      markRule(/(?:^|[^`])(`([^`]+)`)$/, m.code),
      autolinkRule,
    ],
  });
}

// ---------------------------------------------------------------- Keys

export interface KeyHooks {
  /** Ctrl Enter */
  submit?: () => boolean;
  /** Esc (when no menu is open) */
  escape: () => boolean;
  /** Ctrl K */
  link: () => boolean;
  /** Before Ctrl Enter and Esc: report pending text right away. */
  flush: () => void;
}

const inTable = (state: EditorState) => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.spec.tableRole === 'cell' || $from.node(d).type.spec.tableRole === 'header_cell') return true;
  return false;
};

const tab: Command = (state, dispatch) => (inTable(state) ? nextCellOrRow(state, dispatch) : sinkItem(state, dispatch));
/** Only in tables (otherwise the keys stay with the browser or the other commands). */
const inTableOnly = (cmd: Command): Command => (state, dispatch, view) => inTable(state) && cmd(state, dispatch, view);

/** Ctrl Shift \: toggle code block. */
const toggleCode: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type === n.code_block) return codeToText($from.before())(state, dispatch);
  return setBlock(n.code_block)(state, dispatch);
};

const shiftTab: Command = (state, dispatch) => (inTable(state) ? goToNextCell(-1)(state, dispatch) : liftItem(state, dispatch));

/**
 * The browser selection (Shift arrow, Ctrl End …) reaches ProseMirror only with the next
 * `selectionchange`. A shortcut that follows very quickly would otherwise act on the old selection.
 */
function syncSelection() {
  return new Plugin({
    props: {
      handleKeyDown(view) {
        (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
        return false;
      },
    },
  });
}

/**
 * Esc and Ctrl Enter: catch them before the window keys (keys.ts) when the editor uses them itself.
 * Otherwise they pass on (Esc leaves the field; in the create dialog: close or create).
 */
function exits(hooks: KeyHooks) {
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        const mod = event.ctrlKey || event.metaKey;
        const escape = event.key === 'Escape' && !mod && !event.shiftKey && !event.altKey;
        const submit = event.key === 'Enter' && mod && !event.altKey;
        if (!escape && !submit) return false;
        hooks.flush();
        if (!(escape ? hooks.escape() : (hooks.submit?.() ?? false))) return false;
        event.stopPropagation();
        return true;
      },
    },
  });
}

function keys(hooks: KeyHooks) {
  const run = (fn: () => boolean): Command => () => fn();
  return [
    keymap({
      'Mod-z': undo,
      'Mod-Shift-z': redo,
      'Mod-y': redo,
      'Mod-b': toggle(m.strong),
      'Mod-i': toggle(m.em),
      'Mod-e': toggle(m.code),
      'Mod-Shift-x': toggle(m.strike),
      'Mod-k': run(hooks.link),
      'Mod-Shift-7': toggleList(n.ordered_list),
      'Mod-Shift-8': toggleList(n.bullet_list),
      'Mod-Shift-9': toggleList(n.bullet_list, true),
      'Mod-Alt-0': setBlock(n.paragraph),
      'Mod-Alt-1': setBlock(n.heading, { level: 1 }),
      'Mod-Alt-2': setBlock(n.heading, { level: 2 }),
      'Mod-Alt-3': setBlock(n.heading, { level: 3 }),
      'Mod-Alt-p': cycleCalloutKind,
      'Mod-Shift-\\': toggleCode,
      'Mod-Shift-|': toggleCode,
      // Tables: insert and delete rows/columns (also in the table menu)
      'Mod-Alt-ArrowUp': inTableOnly(tableCommands.rowBefore),
      'Mod-Alt-ArrowDown': inTableOnly(tableCommands.rowAfter),
      'Mod-Alt-ArrowLeft': inTableOnly(tableCommands.columnBefore),
      'Mod-Alt-ArrowRight': inTableOnly(tableCommands.columnAfter),
      'Mod-Alt-Backspace': inTableOnly(tableCommands.deleteRow),
      'Mod-Alt-Shift-Backspace': inTableOnly(tableCommands.deleteColumn),
      Enter: chainCommands(enterFromCalloutTitle, fenceToCode, exitCodeOnEmptyLine, splitItem),
      'Shift-Enter': hardBreak,
      Backspace: backspaceToParagraph,
      Tab: tab,
      'Shift-Tab': shiftTab,
      ArrowDown: leaveLastBlock,
      ArrowRight: leaveLastBlock,
    }),
    keymap(baseKeymap),
  ];
}

// ---------------------------------------------------------------- Placeholder

function placeholder(text: () => string) {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = state.doc;
        const first = doc.firstChild;
        if (doc.childCount !== 1 || !first || first.type !== n.paragraph || first.content.size) return null;
        return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: 'is-empty', 'data-placeholder': text() })]);
      },
    },
  });
}

// ---------------------------------------------------------------- Syntax colors

type Highlighter = { codeRanges: (code: string, lang: string) => CodeRange[] | null };
let highlighter: Highlighter | null = null;
let highlighterLoading: Promise<void> | null = null;
const highlightKey = new PluginKey<DecorationSet>('highlight');

function loadHighlighter() {
  highlighterLoading ??= import('../highlight.ts').then(
    (mod) => {
      highlighter = mod;
    },
    () => {
      highlighterLoading = null;
    },
  );
  return highlighterLoading;
}

/** Ranges cached per code block node: typing only recolors the changed block. */
const rangeCache = new WeakMap<Node, CodeRange[]>();

function codeDecorations(doc: Node): { set: DecorationSet; missing: boolean } {
  const decos: Decoration[] = [];
  let missing = false;
  doc.descendants((node, pos) => {
    if (node.type !== n.code_block) return node.isBlock && !node.isTextblock;
    const lang = String(node.attrs.lang ?? '');
    if (!lang) return false;
    if (!highlighter) {
      missing = true;
      return false;
    }
    let ranges = rangeCache.get(node);
    if (!ranges) {
      ranges = highlighter.codeRanges(node.textContent, lang) ?? [];
      rangeCache.set(node, ranges);
    }
    for (const r of ranges) decos.push(Decoration.inline(pos + 1 + r.from, pos + 1 + r.to, { class: r.cls }));
    return false;
  });
  return { set: DecorationSet.create(doc, decos), missing };
}

function highlight() {
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_config, state) => codeDecorations(state.doc).set,
      apply: (tr, set, _old, state) => (tr.docChanged || tr.getMeta(highlightKey) ? codeDecorations(state.doc).set : set),
    },
    props: {
      decorations: (state) => highlightKey.getState(state),
    },
    view(view) {
      const check = () => {
        if (highlighter || !codeDecorations(view.state.doc).missing) return;
        void loadHighlighter().then(() => {
          if (highlighter && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(highlightKey, true));
        });
      };
      check();
      return { update: check };
    },
  });
}

// ---------------------------------------------------------------- "/" menu

export interface SlashState {
  /** Position of the "/", or null */
  from: number | null;
  query: string;
}

export const slashKey = new PluginKey<SlashState>('slash');
const CLOSED: SlashState = { from: null, query: '' };

/** "/" at the start of a line or after a space opens the menu; `onKey` drives it. */
function slash(onKey: (event: KeyboardEvent) => boolean) {
  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: () => CLOSED,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(slashKey) as { open?: number; close?: boolean } | undefined;
        if (meta?.close) return CLOSED;
        const from = meta?.open ?? (prev.from === null ? null : tr.mapping.map(prev.from));
        if (from === null) return CLOSED;
        const sel = state.selection;
        if (!sel.empty || sel.from <= from) return CLOSED;
        const $from = state.doc.resolve(from);
        if ($from.parent !== sel.$from.parent) return CLOSED;
        const text = state.doc.textBetween(from, sel.from, '\n');
        if (!text.startsWith('/') || text.length > 24 || /\s\s|\n/.test(text)) return CLOSED;
        return { from, query: text.slice(1) };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '/') return false;
        const $from = view.state.doc.resolve(from);
        // In code "/" is a character (comments, paths); only an empty code block opens the menu.
        if (!$from.parent.isTextblock || ($from.parent.type.spec.code && ($from.parent.type !== n.code_block || $from.parent.content.size > 0))) return false;
        const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '￼');
        if (before && !/\s$/.test(before)) return false;
        view.dispatch(view.state.tr.insertText('/', from, to).setMeta(slashKey, { open: from }));
        return true;
      },
      handleKeyDown(view, event) {
        if (slashKey.getState(view.state)?.from === null) return false;
        return onKey(event);
      },
    },
  });
}

export function closeSlash(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(slashKey, { close: true }));
}

// ---------------------------------------------------------------- All together

export interface PluginOptions extends KeyHooks {
  placeholder: () => string;
  slashKey: (event: KeyboardEvent) => boolean;
}

export function plugins(options: PluginOptions): Plugin[] {
  return [
    syncSelection(),
    slash(options.slashKey),
    exits(options),
    rules(),
    ...keys(options),
    history(),
    dropCursor({ color: 'var(--accent)', width: 2 }),
    gapCursor(),
    tableEditing(),
    tableShape(),
    placeholder(options.placeholder),
    highlight(),
  ];
}
