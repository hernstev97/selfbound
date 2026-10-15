// Set a code block's language in the source (rendered view), turn a code block back into text, keep tables in Markdown shape.
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { Lexer } from 'marked';
import { setCodeLangIn } from '../src/lib/codeLang.ts';
import { backspaceToParagraph, codeToText, setBlock } from '../src/lib/editor/commands.ts';
import { parseMarkdown } from '../src/lib/editor/parse.ts';
import { schema } from '../src/lib/editor/schema.ts';
import { serializeMarkdown } from '../src/lib/editor/serialize.ts';
import { alignColumn, nextCellOrRow, tableCommands, tableShape } from '../src/lib/editor/table.ts';
import { languageFor, languageLabel } from '../src/lib/languages.ts';

const setCodeLang = (markdown: string, index: number, total: number, lang: string) => setCodeLangIn(markdown, Lexer.lex(markdown, { gfm: true, breaks: true }), index, total, lang);

describe('setCodeLang (rendered view)', () => {
  const md = 'Text\n\n```ts\nconst a = 1;\n```\n\n> ```\n> quoted\n> ```\n\n- Item\n\n  ~~~py title=x\n  print(1)\n  ~~~';
  it('changes only the info string of the n-th fence', () => {
    expect(setCodeLang(md, 0, 3, 'javascript')).toBe(md.replace('```ts', '```javascript'));
    expect(setCodeLang(md, 1, 3, 'sql')).toBe(md.replace('> ```\n> quoted', '> ```sql\n> quoted'));
    expect(setCodeLang(md, 2, 3, 'python')).toBe(md.replace('~~~py title=x', '~~~python title=x'));
  });
  it('plain text removes the info string', () => {
    expect(setCodeLang(md, 0, 3, '')).toBe(md.replace('```ts', '```'));
    expect(setCodeLang(md, 2, 3, '')).toBe(md.replace('~~~py title=x', '~~~'));
  });
  it('fences inside code do not count', () => {
    const nested = '````md\n```ts\nx\n```\n````\n\n```\ny\n```';
    expect(setCodeLang(nested, 1, 2, 'bash')).toBe('````md\n```ts\nx\n```\n````\n\n```bash\ny\n```');
  });
  it('indented code and HTML: fence-like lines inside do not count, the real fence is hit', () => {
    const indented = 'Text\n\n    ```\n    no fence\n\n```\nreal\n```';
    expect(setCodeLang(indented, 0, 2, 'ts')).toBeNull(); // the indented block has no fence
    expect(setCodeLang(indented, 1, 2, 'ts')).toBe('Text\n\n    ```\n    no fence\n\n```ts\nreal\n```');
    const html = '<div>\n```\nin HTML\n</div>\n\n```\nreal\n```';
    expect(setCodeLang(html, 0, 1, 'sql')).toBe('<div>\n```\nin HTML\n</div>\n\n```sql\nreal\n```');
  });
  it('null if the count does not match the rendered view or the info string is unsafe', () => {
    expect(setCodeLang(md, 0, 4, 'ts')).toBeNull();
    expect(setCodeLang(md, 0, 3, 'a b')).toBeNull();
    expect(setCodeLang(md, 0, 3, '<script>')).toBeNull();
  });
});

describe('languages', () => {
  it('names and spellings', () => {
    expect(languageLabel('ts')).toBe('TypeScript');
    expect(languageLabel('')).toBe('Plain text');
    expect(languageLabel('rust')).toBe('rust');
    expect(languageFor('YML')?.id).toBe('yaml');
    expect(languageFor('svelte')?.grammar).toBe('svelte');
  });
});

/** State from Markdown, cursor at `find` (plus `offset`) in the first matching text block. */
function stateAt(markdown: string, find: string, offset = 0) {
  const doc = parseMarkdown(markdown).doc;
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.isTextblock && node.textContent.includes(find)) pos = p + 1 + node.textContent.indexOf(find) + offset;
    return true;
  });
  expect(pos).toBeGreaterThan(0);
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos), plugins: [tableShape()] });
}

function run(state: EditorState, cmd: (s: EditorState, d: (tr: Transaction) => void) => boolean) {
  let next = state;
  const ok = cmd(state, (tr) => (next = state.applyTransaction(tr).state));
  expect(ok).toBe(true);
  return next;
}

const md = (state: EditorState) => serializeMarkdown(state.doc);

describe('code block back to text', () => {
  it('one paragraph per line, the cursor keeps its place', () => {
    const state = stateAt('```ts\none\n\ntwo\n```', 'two', 2);
    const next = run(state, codeToText(0));
    expect(md(next)).toBe('one\n\ntwo');
    expect(next.doc.childCount).toBe(3);
    expect(next.selection.$from.parent.textContent).toBe('two');
    expect(next.selection.$from.parentOffset).toBe(2);
  });
  it('Backspace at the start, also with content', () => {
    const state = stateAt('Before\n\n```\na\nb\n```', 'a\nb');
    expect(md(run(state, backspaceToParagraph))).toBe('Before\n\na\n\nb');
  });
  it('"Text" from the menu or Ctrl Alt 0', () => {
    const state = stateAt('```js\nx\ny\n```', 'y');
    expect(md(run(state, setBlock(schema.nodes.paragraph)))).toBe('x\n\ny');
  });
});

describe('tables', () => {
  const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |';

  it('row above the header row: new header row, the old one becomes a normal row', () => {
    const next = run(stateAt(TABLE, 'A'), tableCommands.rowBefore);
    expect(md(next)).toBe('| | |\n| --- | --- |\n| A | B |\n| 1 | 2 |');
    const rows: string[][] = [];
    next.doc.firstChild!.forEach((row) => {
      const types: string[] = [];
      row.forEach((cell) => types.push(cell.type.name));
      rows.push(types);
    });
    expect(rows).toEqual([
      ['table_header', 'table_header'],
      ['table_cell', 'table_cell'],
      ['table_cell', 'table_cell'],
    ]);
    // Cursor in the new row
    expect(next.selection.$from.parent.type.name).toBe('table_header');
    expect(next.selection.$from.parent.textContent).toBe('');
  });

  it('row above a centered header row: alignment stays', () => {
    const next = run(stateAt('| A | B |\n| :-: | --: |\n| 1 | 2 |', 'A'), tableCommands.rowBefore);
    expect(md(next)).toBe('| | |\n| :-: | --: |\n| A | B |\n| 1 | 2 |');
  });

  it('a column to the right takes no foreign alignment; alignment applies to the whole column', () => {
    let state = run(stateAt('| A | B |\n| :-: | --- |\n| 1 | 2 |', '1'), tableCommands.columnAfter);
    expect(md(state)).toBe('| A | | B |\n| :-: | --- | --- |\n| 1 | | 2 |');
    state = run(state, alignColumn('right'));
    expect(md(state)).toBe('| A | | B |\n| :-: | --: | --- |\n| 1 | | 2 |');
  });

  it('delete: not the last row/column on its own', () => {
    const one = stateAt('| A |\n| --- |', 'A');
    expect(tableCommands.deleteRow(one)).toBe(false);
    expect(tableCommands.deleteColumn(one)).toBe(false);
    expect(md(run(stateAt(TABLE, '2'), tableCommands.deleteRow))).toBe('| A | B |\n| --- | --- |');
    expect(md(run(stateAt(TABLE, 'B'), tableCommands.deleteColumn))).toBe('| A |\n| --- |\n| 1 |');
  });

  it('Tab in the last cell: new row, cursor in its first cell', () => {
    const next = run(stateAt(TABLE, '2', 1), nextCellOrRow);
    expect(md(next)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| | |');
    const $from = next.selection.$from;
    expect($from.parent.type.name).toBe('table_cell');
    expect($from.index($from.depth - 1)).toBe(0);
    expect($from.index($from.depth - 2)).toBe(2);
  });
});
