// Tables in the editor: insert, delete and align rows and columns, through the table menu
// (RichEditor) and keys. Markdown knows exactly one header row at the top and one alignment per
// column; `tableShape` keeps the table in that shape after every change.
import type { Node } from 'prosemirror-model';
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  selectedRect,
  TableMap,
} from 'prosemirror-tables';
import { schema } from './schema.ts';

const n = schema.nodes;

export type Align = 'left' | 'center' | 'right' | null;

export { isInTable };

/** Set the alignment of the column(s) under the selection (whole column, as in Markdown). */
export function alignColumn(align: Align): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (dispatch) {
      const rect = selectedRect(state);
      const tr = state.tr;
      const seen = new Set<number>();
      for (let row = 0; row < rect.map.height; row++) {
        for (let col = rect.left; col < rect.right; col++) {
          const at = rect.map.map[row * rect.map.width + col]!;
          if (seen.has(at)) continue;
          seen.add(at);
          const pos = rect.tableStart + at;
          const cell = tr.doc.nodeAt(pos)!;
          tr.setNodeMarkup(pos, null, { ...cell.attrs, align });
        }
      }
      dispatch(tr);
    }
    return true;
  };
}

/** Alignment of the column at the cursor (for the check mark in the menu). */
export function columnAlign(state: EditorState): Align {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  const cell = rect.table.nodeAt(rect.map.map[rect.left]!);
  return (cell?.attrs.align as Align) ?? null;
}

/** The last row or column cannot be deleted on its own (delete the table instead). */
export const canDeleteRow = (state: EditorState) => isInTable(state) && selectedRect(state).map.height > 1;
export const canDeleteColumn = (state: EditorState) => isInTable(state) && selectedRect(state).map.width > 1;

/** Tab in the last cell: new row below, cursor in its first cell. */
export const nextCellOrRow: Command = (state, dispatch) => {
  if (goToNextCell(1)(state, dispatch)) return true;
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  const { tableStart } = selectedRect(state);
  let tr: Transaction | null = null;
  addRowAfter(state, (t) => (tr = t));
  if (!tr) return false;
  const done = tr as Transaction;
  const table = done.doc.nodeAt(tableStart - 1)!;
  const map = TableMap.get(table);
  const first = tableStart + map.map[(map.height - 1) * map.width]!;
  dispatch(done.setSelection(TextSelection.create(done.doc, first + 1)).scrollIntoView());
  return true;
};

/** Insert, then put the cursor in the new row or column (same column or row). */
function insertAndGo(cmd: Command, axis: 'row' | 'col', after: boolean): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return cmd(state);
    const rect = selectedRect(state);
    let tr: Transaction | null = null;
    cmd(state, (t) => (tr = t));
    if (!tr) return false;
    const done = tr as Transaction;
    const map = TableMap.get(done.doc.nodeAt(rect.tableStart - 1)!);
    const row = axis === 'row' ? (after ? rect.bottom : rect.top) : rect.top;
    const col = axis === 'col' ? (after ? rect.right : rect.left) : rect.left;
    if (axis === 'row') {
      // The new row takes the alignment of its columns. Otherwise a new header row (inserted
      // above the old one) would clear the alignment of the whole table (tableShape).
      const old = rect.map;
      for (let c = 0; c < map.width; c++) {
        const align = rect.table.nodeAt(old.map[c]!)?.attrs.align ?? null;
        const pos = rect.tableStart + map.map[row * map.width + c]!;
        const cell = done.doc.nodeAt(pos)!;
        if ((cell.attrs.align ?? null) !== align) done.setNodeMarkup(pos, null, { ...cell.attrs, align });
      }
    }
    const cell = rect.tableStart + map.map[row * map.width + col]!;
    dispatch(done.setSelection(TextSelection.create(done.doc, cell + 1)).scrollIntoView());
    return true;
  };
}

export const tableCommands = {
  rowBefore: insertAndGo(addRowBefore, 'row', false),
  rowAfter: insertAndGo(addRowAfter, 'row', true),
  columnBefore: insertAndGo(addColumnBefore, 'col', false),
  columnAfter: insertAndGo(addColumnAfter, 'col', true),
  deleteRow: ((state, dispatch) => canDeleteRow(state) && deleteRow(state, dispatch)) as Command,
  deleteColumn: ((state, dispatch) => canDeleteColumn(state) && deleteColumn(state, dispatch)) as Command,
  deleteTable,
};

/**
 * After every change: header cells in the first row, normal cells everywhere else, alignment per
 * column as in the header row. Otherwise "Insert row above" on the header row would create two
 * header rows, which Markdown cannot express, and a new column would get mixed alignments.
 */
export function tableShape() {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      let tr: Transaction | null = null;
      state.doc.descendants((node, pos) => {
        if (node.type === n.table) {
          tr = fixTable(node, pos, state, tr);
          return false;
        }
        return !node.isTextblock && !node.isAtom;
      });
      return tr;
    },
  });
}

function fixTable(table: Node, pos: number, state: EditorState, tr: Transaction | null): Transaction | null {
  const map = TableMap.get(table);
  const start = pos + 1;
  const aligns: unknown[] = [];
  for (let col = 0; col < map.width; col++) aligns.push(table.nodeAt(map.map[col]!)?.attrs.align ?? null);
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const at = map.map[row * map.width + col]!;
      if (seen.has(at)) continue;
      seen.add(at);
      const cell = table.nodeAt(at)!;
      const type = row === 0 ? n.table_header : n.table_cell;
      const align = aligns[col] ?? null;
      if (cell.type === type && (cell.attrs.align ?? null) === align) continue;
      tr ??= state.tr;
      tr.setNodeMarkup(start + at, type, { ...cell.attrs, align });
    }
  }
  return tr;
}
