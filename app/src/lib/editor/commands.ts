// Editor commands: block conversion (shortcuts and the "/" menu), lists, tasks, tables.
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import type { MarkType, Node, NodeType, ResolvedPos } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { findWrapping } from 'prosemirror-transform';
import type { CalloutKind } from '../blocks/callout.ts';
import { schema } from './schema.ts';

const n = schema.nodes;

/** Depth of the enclosing list item (or -1). */
function itemDepth($pos: ResolvedPos) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === n.list_item) return d;
  return -1;
}

/** Depth of the enclosing list (or -1). */
function listDepth($pos: ResolvedPos) {
  for (let d = $pos.depth; d > 0; d--) {
    const type = $pos.node(d).type;
    if (type === n.bullet_list || type === n.ordered_list) return d;
  }
  return -1;
}

export const toggle = (type: MarkType): Command => toggleMark(type);

/** Paragraph, heading or code block; a code block turns into one block per line. */
export function setBlock(type: NodeType, attrs?: Record<string, unknown>): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    if ($from.parent.type === n.code_block && $from.sameParent($to) && !type.spec.code) return codeToText($from.before(), type, attrs)(state, dispatch);
    return setBlockType(type, attrs)(state, dispatch);
  };
}

/**
 * Turns the code block at `pos` back into text: one paragraph (or `type`) per line, empty lines
 * stay empty paragraphs. The cursor stays at the same place in the text.
 */
export function codeToText(pos: number, type: NodeType = n.paragraph, attrs?: Record<string, unknown>): Command {
  return (state, dispatch) => {
    const code = state.doc.nodeAt(pos);
    if (!code || code.type !== n.code_block) return false;
    const $pos = state.doc.resolve(pos);
    if (!$pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type)) return false;
    if (!dispatch) return true;
    const lines = code.textContent.split('\n');
    const blocks = lines.map((line) => type.create(attrs, line ? schema.text(line) : null));
    const tr = state.tr.replaceWith(pos, pos + code.nodeSize, blocks);
    // Cursor: same line and column as before in the code
    const { $from } = state.selection;
    let offset = $from.parent === code ? $from.parentOffset : 0;
    let at = pos + 1;
    for (const line of lines) {
      if (offset <= line.length) {
        at += offset;
        break;
      }
      offset -= line.length + 1;
      at += line.length + 2;
    }
    tr.setSelection(TextSelection.create(tr.doc, Math.min(at, tr.doc.content.size)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Toggle a list (Ctrl Shift 7/8): same list type → lift out, other type → convert. */
export function toggleList(type: NodeType, task = false): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const d = listDepth($from);
    if (d >= 0) {
      const list = $from.node(d);
      const item = $from.node(itemDepth($from));
      const isTask = item.attrs.checked !== null;
      if (list.type === type && isTask === task) return liftListItem(n.list_item)(state, dispatch);
      if (dispatch) {
        const tr = state.tr;
        if (list.type !== type) tr.setNodeMarkup($from.before(d), type, type === n.ordered_list ? { order: 1, delim: '.', tight: list.attrs.tight } : { bullet: '-', tight: list.attrs.tight });
        list.forEach((child, offset) => {
          const pos = $from.start(d) + offset;
          tr.setNodeMarkup(pos, null, { checked: task ? (child.attrs.checked ?? false) : null });
        });
        dispatch(tr);
      }
      return true;
    }
    if (!task) return wrapInList(type)(state, dispatch);
    return wrapTask(state, dispatch);
  };
}

/** Wrap a paragraph in a task list. */
function wrapTask(state: EditorState, dispatch?: (tr: Transaction) => void, checked = false) {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to);
  if (!range || !findWrapping(range, n.bullet_list)) return false;
  if (dispatch) dispatch(state.tr.wrap(range, [{ type: n.bullet_list, attrs: { bullet: '-' } }, { type: n.list_item, attrs: { checked } }]).scrollIntoView());
  return true;
}

/** "[ ] " at the start of a paragraph or list item: turn it into a task. */
export function makeTask(tr: Transaction, start: number, checked: boolean): Transaction | null {
  const $start = tr.doc.resolve(start);
  const d = itemDepth($start);
  if (d >= 0 && $start.depth === d + 1 && $start.index(d) === 0) return tr.setNodeMarkup($start.before(d), null, { checked });
  const range = $start.blockRange();
  if (!range || !findWrapping(range, n.bullet_list)) return null;
  return tr.wrap(range, [{ type: n.bullet_list, attrs: { bullet: '-' } }, { type: n.list_item, attrs: { checked } }]);
}

/** Enter in a list: new item (a task stays a task, unchecked); empty item → lift out. */
export const splitItem: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const d = itemDepth($from);
  if (d < 0) return false;
  const checked = $from.node(d).attrs.checked;
  return splitListItem(n.list_item, checked === null ? undefined : { checked: false })(state, dispatch);
};

export const sinkItem: Command = (state, dispatch) => sinkListItem(n.list_item)(state, dispatch);
export const liftItem: Command = (state, dispatch) => liftListItem(n.list_item)(state, dispatch);

/** Backspace at the start: list item, heading, quote, code block → plain text. */
export const backspaceToParagraph: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty || sel.$from.parentOffset > 0) return false;
  const $from = sel.$from;
  const parent = $from.parent;
  if (parent.type === n.heading) return setBlockType(n.paragraph)(state, dispatch);
  if (parent.type === n.code_block) return codeToText($from.before())(state, dispatch);
  const d = itemDepth($from);
  if (d >= 0 && $from.depth === d + 1 && $from.index(d) === 0) return liftListItem(n.list_item)(state, dispatch);
  if ($from.depth > 1 && $from.node($from.depth - 1).type === n.blockquote && $from.index($from.depth - 1) === 0) return lift(state, dispatch);
  if (parent.type === n.callout_title) return unwrapCallout($from.before() - 1)(state, dispatch);
  return false;
};

// ---------------------------------------------------------------- Info panels

/**
 * Info panel from the current block(s): an empty line becomes an empty panel, text is wrapped into
 * it as its content. The cursor lands in the title.
 */
export function insertCallout(kind: CalloutKind): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range || !range.parent.canReplaceWith(range.startIndex, range.endIndex, n.callout)) return false;
    if (!dispatch) return true;
    const nodes: Node[] = [];
    for (let i = range.startIndex; i < range.endIndex; i++) nodes.push(range.parent.child(i));
    const empty = nodes.length === 1 && nodes[0]!.type === n.paragraph && nodes[0]!.content.size === 0;
    const callout = n.callout.create({ kind }, [n.callout_title.create(), ...(empty ? [n.paragraph.create()] : nodes)]);
    const tr = state.tr.replaceWith(range.start, range.end, callout);
    tr.setSelection(TextSelection.create(tr.doc, range.start + 2));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Change the kind of the panel at `pos` (the keyword as written no longer applies). */
export function setCalloutKind(pos: number, kind: CalloutKind): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (node?.type !== n.callout) return false;
    if (dispatch) dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, kind, word: null }));
    return true;
  };
}

/**
 * Takes the panel at `pos` apart: the title becomes a paragraph (if it has text) in front of the
 * content, or a quote with the same content (`toQuote`).
 */
export function unwrapCallout(pos: number, toQuote = false): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (node?.type !== n.callout) return false;
    if (!dispatch) return true;
    const title = node.child(0);
    const body: Node[] = [];
    node.forEach((child, _o, i) => {
      if (i > 0) body.push(child);
    });
    const lead = title.content.size ? [n.paragraph.create(null, title.content)] : [];
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, toQuote ? n.blockquote.create(null, [...lead, ...body]) : [...lead, ...body]);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Enter in a panel's title: continue in the content. */
export const enterFromCalloutTitle: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== n.callout_title) return false;
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve($from.after()), 1)).scrollIntoView());
  return true;
};

export const quote: Command = (state, dispatch) => wrapIn(n.blockquote)(state, dispatch);

/** Insert a block after the current one (divider, table) and move the cursor past it. */
function insertBlock(node: Node, cursorInside: boolean): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    // At the top level, or in the nearest wrapper that holds blocks.
    let depth = $from.depth;
    while (depth > 0 && !$from.node(depth - 1).type.contentMatch.matchType(n.paragraph)) depth--;
    if (depth === 0) return false;
    if (!dispatch) return true;
    const parent = $from.node(depth);
    const empty = parent.type === n.paragraph && parent.content.size === 0;
    const tr = state.tr;
    let pos: number;
    if (empty) {
      pos = $from.before(depth);
      tr.replaceWith(pos, $from.after(depth), node);
    } else {
      pos = $from.after(depth);
      tr.insert(pos, node);
    }
    const after = pos + node.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter) tr.insert(after, n.paragraph.create());
    tr.setSelection(cursorInside ? Selection.near(tr.doc.resolve(pos + 1)) : TextSelection.near(tr.doc.resolve(after + 1)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const insertRule: Command = (state, dispatch) => insertBlock(n.horizontal_rule.create(), false)(state, dispatch);

export const insertTable: Command = (state, dispatch) => {
  const cell = (type: NodeType) => type.create();
  const row = (type: NodeType) => n.table_row.create(null, [cell(type), cell(type), cell(type)]);
  const table = n.table.create(null, [row(n.table_header), row(n.table_cell), row(n.table_cell)]);
  return insertBlock(table, true)(state, dispatch);
};

/** "```ts" + Enter or space: the paragraph becomes a code block. */
export const fenceToCode: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== n.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const m = /^(`{3,}|~{3,})([\w#+.-]*)$/.exec($from.parent.textContent);
  if (!m) return false;
  if (dispatch) {
    const start = $from.start();
    const tr = state.tr.delete(start, $from.end()).setBlockType(start, start, n.code_block, { lang: m[2], fence: m[1]![0] });
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Enter at the end of a code block whose last line is empty: leave the code block. */
export const exitCodeOnEmptyLine: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== n.code_block || $from.parentOffset !== $from.parent.content.size) return false;
  if (!$from.parent.textContent.endsWith('\n')) return false;
  if (dispatch) {
    const after = $from.after();
    const tr = state.tr.delete($from.pos - 1, $from.pos);
    const pos = tr.mapping.map(after);
    tr.insert(pos, n.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Arrow down/right at the end of the last block: new paragraph. */
export const leaveLastBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== $from.parent.content.size) return false;
  const top = $from.node(1);
  if (!top || top.type === n.paragraph || state.doc.lastChild !== top) return false;
  // Only at the real end of the last block
  if (Selection.atEnd(state.doc).from !== $from.pos) return false;
  if (dispatch) {
    const tr = state.tr.insert(state.doc.content.size, n.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Line break in a paragraph (Shift Enter); a plain newline in a code block. */
export const hardBreak: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) {
    if (dispatch) dispatch(state.tr.insertText('\n').scrollIntoView());
    return true;
  }
  if ($from.parent.type === n.table_cell || $from.parent.type === n.table_header) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView());
  return true;
};
