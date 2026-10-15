// Info panels (`> [!KIND] Title`) and visual blocks: syntax, rendering markup, the editor's
// reading and writing, and the renderer registry.
import { Lexer, type Tokens } from 'marked';
import { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { calloutHtml, calloutKind, calloutOf, parseCalloutLine } from '../src/lib/blocks/callout.ts';
import { blockFenceHtml } from '../src/lib/blocks/fence.ts';
import { blockFor, loadBlock, type BlockRenderer } from '../src/lib/blocks/registry.ts';
import { cycleCalloutKind, hardBreak, insertCallout, insertRule, setCalloutKind, unwrapCallout } from '../src/lib/editor/commands.ts';
import { parseMarkdown } from '../src/lib/editor/parse.ts';
import { schema } from '../src/lib/editor/schema.ts';
import { serializeMarkdown } from '../src/lib/editor/serialize.ts';
import { plainText } from '../src/lib/markdown.ts';

const quote = (md: string) => new Lexer({ gfm: true, breaks: true }).lex(md)[0] as Tokens.Blockquote;

describe('keywords', () => {
  it('the five kinds and the GitHub alert names', () => {
    expect(['info', 'note', 'success', 'warning', 'error'].map(calloutKind)).toEqual(['info', 'note', 'success', 'warning', 'error']);
    expect(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map(calloutKind)).toEqual(['note', 'success', 'info', 'warning', 'error']);
    expect(calloutKind('Warning')).toBe('warning');
    expect(calloutKind('foo')).toBeNull();
    // Names of Object.prototype are not keywords
    expect(['constructor', 'toString', '__proto__', 'hasOwnProperty'].map(calloutKind)).toEqual([null, null, null, null]);
    expect(calloutOf(quote('> [!constructor] x\n> y'))).toBeNull();
  });
  it('marker line with and without a title', () => {
    expect(parseCalloutLine('[!WARNING] Post-conditions\nbody')).toMatchObject({ kind: 'warning', word: 'WARNING', title: 'Post-conditions' });
    expect(parseCalloutLine('[!info]')).toMatchObject({ kind: 'info', title: '' });
    expect(parseCalloutLine('[!FOO] x')).toBeNull();
    expect(parseCalloutLine('text [!INFO]')).toBeNull();
    expect(parseCalloutLine('[!INFO]x')).toMatchObject({ title: 'x' });
  });
});

describe('quote → panel', () => {
  it('title, body, and a list that follows the marker line', () => {
    const c = calloutOf(quote('> [!INFO] Pre-conditions\n> - one\n> - two'))!;
    expect(c).toMatchObject({ kind: 'info', title: 'Pre-conditions' });
    expect(c.body.map((t) => t.type)).toEqual(['list']);
  });
  it('text on the following lines is the first paragraph of the body', () => {
    const c = calloutOf(quote('> [!NOTE]\n> Line one\n> line two'))!;
    expect(c.title).toBe('');
    expect(c.body.map((t) => t.type)).toEqual(['paragraph']);
    expect((c.body[0] as Tokens.Paragraph).text).toBe('Line one\nline two');
  });
  it('a plain quote, an unknown keyword and a marker not at the start stay quotes', () => {
    expect(calloutOf(quote('> plain'))).toBeNull();
    expect(calloutOf(quote('> [!FOO] x'))).toBeNull();
    expect(calloutOf(quote('> text\n> [!INFO] x'))).toBeNull();
    expect(calloutOf(quote('> # Heading\n> [!INFO]'))).toBeNull();
  });
  it('markup: kind class, accessible name, escaped title', () => {
    const c = calloutOf(quote('> [!WARNING] <img src=x onerror=alert(1)> & "q"\n> body'))!;
    const html = calloutHtml(c, '<p>body</p>');
    expect(html).toContain('class="callout callout-warning"');
    expect(html).toContain('role="note"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
    expect(html).toContain('<div class="callout-body"><p>body</p></div>');
  });
  it('no title: the name of the kind', () => {
    const html = calloutHtml(calloutOf(quote('> [!SUCCESS]\n> ok'))!, '<p>ok</p>');
    expect(html).toContain('<span class="callout-name">Success</span>');
  });
  it('plain text for previews drops the marker, keeps the title', () => {
    const text = plainText('> [!WARNING] Careful\n> Text');
    expect(text).not.toContain('[!');
    expect(text).toContain('Careful');
    expect(text).toContain('Text');
  });
});

describe('editor: reading and writing', () => {
  const read = (md: string) => parseMarkdown(md);
  const fresh = (md: string) => serializeMarkdown(read(md).doc);

  it('a panel becomes a callout node with title and body', () => {
    const doc = read('> [!TIP] Hint\n> - a\n> - b').doc;
    const callout = doc.child(0);
    expect(callout.type.name).toBe('callout');
    expect(callout.attrs).toMatchObject({ kind: 'success', word: 'TIP' });
    expect(callout.child(0).textContent).toBe('Hint');
    expect(callout.child(1).type.name).toBe('bullet_list');
  });
  it('an empty panel has an empty paragraph as content', () => {
    const callout = read('> [!INFO]').doc.child(0);
    expect(callout.childCount).toBe(2);
    expect(callout.child(1).type.name).toBe('paragraph');
  });
  it('other quotes stay quotes', () => {
    expect(read('> [!FOO] x').doc.child(0).type.name).toBe('blockquote');
  });
  it('written fresh: marker line, paragraph directly below, other blocks after a blank line', () => {
    expect(fresh('> [!WARNING] Title\n> body')).toBe('> [!WARNING] Title\n> body');
    expect(fresh('> [!tip] T\n>\n> body')).toBe('> [!tip] T\n> body');
    expect(fresh('> [!INFO]\n> - a\n> - b')).toBe('> [!INFO]\n>\n> - a\n> - b');
    expect(fresh('> [!INFO]')).toBe('> [!INFO]');
    expect(fresh('> [!NOTE] x\n> ```ts\n> a\n> ```')).toBe('> [!NOTE] x\n>\n> ```ts\n> a\n> ```');
  });
  it('a panel whose first content block is not written (empty paragraph) keeps its structure', () => {
    const { doc } = read('> [!INFO] T\n>\n> - a');
    const callout = doc.child(0);
    const withEmpty = callout.copy(callout.content.replaceChild(1, schema.nodes.paragraph.create()).addToEnd(schema.nodes.horizontal_rule.create()));
    const out = serializeMarkdown(doc.copy(doc.content.replaceChild(0, withEmpty)));
    expect(out).toBe('> [!INFO] T\n>\n> ---');
    expect(read(out).doc.child(0).childCount).toBe(2);
    const list = schema.nodes.ordered_list.create({ order: 3 }, schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text('x'))));
    const swallow = callout.copy(callout.content.replaceChild(1, schema.nodes.paragraph.create()).addToEnd(list));
    const out2 = serializeMarkdown(doc.copy(doc.content.replaceChild(0, swallow)));
    expect(out2).toBe('> [!INFO] T\n>\n> 3. x');
    expect(read(out2).doc.child(0).child(1).type.name).toBe('ordered_list');
  });
  it('nested panels and panels in lists read back the same', () => {
    const md = '> [!SUCCESS] Outer\n> > [!INFO] Inner\n> > Nested';
    const out = fresh(md);
    expect(read(out).doc.toJSON()).toEqual(read(md).doc.toJSON());
  });
  it('changing the kind drops the keyword as written; the old one stays while untouched', () => {
    const { doc, source } = read('> [!TIP] Hint\n> text');
    const state = EditorState.create({ doc, schema });
    let next = state;
    setCalloutKind(0, 'error')(state, (tr) => (next = state.apply(tr)));
    expect(serializeMarkdown(next.doc, source)).toBe('> [!ERROR] Hint\n> text');
    expect(serializeMarkdown(doc, source)).toBe('> [!TIP] Hint\n> text');
  });
});

describe('editor: commands', () => {
  const stateOf = (md: string, at = 1) => {
    const { doc } = parseMarkdown(md);
    return EditorState.create({ doc, schema, selection: TextSelection.create(doc, at) });
  };
  const run = (state: EditorState, cmd: (s: EditorState, d?: (tr: import('prosemirror-state').Transaction) => void) => boolean) => {
    let next = state;
    expect(cmd(state, (tr) => (next = state.apply(tr)))).toBe(true);
    return next;
  };

  it('insert on an empty line: empty panel, cursor in the title', () => {
    const next = run(stateOf(''), insertCallout('warning'));
    expect(serializeMarkdown(next.doc)).toBe('> [!WARNING]');
    expect(next.selection.$from.parent.type.name).toBe('callout_title');
  });
  it('insert on text wraps the text as content', () => {
    const next = run(stateOf('Some text', 3), insertCallout('info'));
    expect(serializeMarkdown(next.doc)).toBe('> [!INFO]\n> Some text');
  });
  it('not inside a table cell', () => {
    const state = stateOf('| a |\n|---|\n| b |', 4);
    expect(insertCallout('info')(state)).toBe(false);
  });
  it('turn into text and into a quote keep the title and the content', () => {
    const state = stateOf('> [!INFO] Title\n> body', 3);
    expect(serializeMarkdown(run(state, unwrapCallout(0)).doc)).toBe('Title\n\nbody');
    expect(serializeMarkdown(run(state, unwrapCallout(0, true)).doc)).toBe('> Title\n>\n> body');
  });
  it('a divider from the title goes in front of the content, from the content after it; never into the title', () => {
    const state = stateOf('> [!INFO] Title\n> body', 3); // cursor in the title
    const next = run(state, insertRule);
    expect(serializeMarkdown(next.doc)).toBe('> [!INFO] Title\n>\n> ---\n>\n> body');
    expect(() => next.doc.check()).not.toThrow();
    const inBody = run(stateOf('> [!INFO] Title\n> body', 11), insertRule);
    expect(serializeMarkdown(inBody.doc)).toBe('> [!INFO] Title\n> body\n>\n> ---');
  });
  it('Shift Enter in the title continues in the content; Ctrl Alt P cycles the kind', () => {
    const state = stateOf('> [!INFO] Title\n> body', 3);
    const moved = run(state, hardBreak);
    expect(moved.selection.$from.parent.type.name).toBe('paragraph');
    let next = state;
    for (const kind of ['NOTE', 'SUCCESS', 'WARNING', 'ERROR', 'INFO']) {
      next = run(next, cycleCalloutKind);
      expect(serializeMarkdown(next.doc)).toBe(`> [!${kind}] Title\n> body`);
    }
    expect(cycleCalloutKind(stateOf('plain'))).toBe(false);
  });
  it('the result is a valid document', () => {
    const next = run(stateOf('x'), insertCallout('note'));
    expect(() => next.doc.check()).not.toThrow();
    expect(Node.fromJSON(schema, next.doc.toJSON()).eq(next.doc)).toBe(true);
  });
});

describe('renderer registry', () => {
  const fake = (over: Partial<BlockRenderer> = {}): BlockRenderer => ({ id: 'fake', langs: ['fake', 'fk'], label: () => 'Fake', load: async () => ({ render() {} }), ...over });

  it('claims a fence language, ignoring case and extra words in the info string', () => {
    const blocks = [fake()];
    expect(blockFor('fake', blocks)?.id).toBe('fake');
    expect(blockFor('FK title=x', blocks)?.id).toBe('fake');
    expect(blockFor('ts', blocks)).toBeNull();
    expect(blockFor('', blocks)).toBeNull();
    expect(blockFor(undefined, blocks)).toBeNull();
  });
  it('markup keeps the source readable and escapes it', () => {
    const html = blockFenceHtml(fake(), 'a <b> & c', 'fake');
    expect(html).toContain('class="codeblock vblock" data-block="fake"');
    expect(html).toContain('data-lang="fake"');
    expect(html).toContain('a &lt;b&gt; &amp; c');
  });
  it('loads a module once, and tries again after a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ render() {} });
    const renderer = fake({ id: 'retry', load });
    await expect(loadBlock(renderer)).rejects.toThrow('offline');
    await Promise.resolve();
    const [a, b] = await Promise.all([loadBlock(renderer), loadBlock(renderer)]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
