// Round trip Markdown → editor → Markdown. The storage format stays Markdown: opening and saving
// without a change must change nothing, and a change only its own block.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { decodeEntities, parseMarkdown } from '../src/lib/editor/parse.ts';
import { schema } from '../src/lib/editor/schema.ts';
import { sameContent, serializeMarkdown } from '../src/lib/editor/serialize.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** Samples: own collection (agent report, GitHub template, Linear export, edge cases) and every Markdown file in the repo. */
function corpus(): [string, string][] {
  const own = join(here, 'fixtures', 'markdown');
  const files: [string, string][] = readdirSync(own).map((f) => [`fixtures/${f}`, readFileSync(join(own, f), 'utf8')]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'fixtures') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push([path.slice(root.length + 1), readFileSync(path, 'utf8')]);
    }
  };
  for (const dir of ['docs', 'README.md', 'perf', 'e2e', 'tooling']) {
    const path = join(root, dir);
    if (!existsSync(path)) continue;
    if (dir.endsWith('.md')) files.push([dir, readFileSync(path, 'utf8')]);
    else walk(path);
  }
  return files;
}

const CORPUS = corpus();

/** All blocks written fresh (without source) and read back: same content? */
function expectSameDoc(a: Node, b: Node, name: string) {
  expect(b.childCount, name).toBe(a.childCount);
  a.forEach((block, _o, i) => {
    if (!sameContent(block, b.child(i))) {
      expect(b.child(i).toJSON(), `${name}, block ${i}`).toEqual(block.toJSON());
    }
  });
}

/** Markdown cannot express empty paragraphs; leave them out of the comparison. */
function withoutEmpty(doc: Node) {
  const kept: Node[] = [];
  doc.forEach((b) => {
    if (!(b.type.name === 'paragraph' && b.content.size === 0)) kept.push(b);
  });
  return schema.nodes.doc.create(null, kept.length ? kept : [schema.nodes.paragraph.create()]);
}

describe('round trip without changes', () => {
  it(`has enough samples (${CORPUS.length} files)`, () => {
    expect(CORPUS.length).toBeGreaterThan(10);
  });

  it.each(CORPUS)('%s stays byte for byte the same', (_name, md) => {
    const { doc, source } = parseMarkdown(md);
    expect(serializeMarkdown(doc, source)).toBe(md);
  });

  it.each(CORPUS)('%s: also after undo (new, equal objects)', (_name, md) => {
    const { doc, source } = parseMarkdown(md);
    const copy = Node.fromJSON(schema, doc.toJSON());
    expect(serializeMarkdown(copy, source)).toBe(md);
  });

  it('empty text stays empty', () => {
    const { doc, source } = parseMarkdown('');
    expect(doc.childCount).toBe(1);
    expect(serializeMarkdown(doc, source)).toBe('');
  });
});

describe('writing fresh gives the same content', () => {
  it.each(CORPUS)('%s', (name, md) => {
    const { doc } = parseMarkdown(md);
    const written = serializeMarkdown(doc);
    expectSameDoc(withoutEmpty(doc), withoutEmpty(parseMarkdown(written).doc), name);
  });
});

describe('a change only affects its block', () => {
  it('one paragraph changed, everything else stays verbatim', () => {
    const md = readFileSync(join(here, 'fixtures', 'markdown', 'edge-cases.md'), 'utf8');
    const { doc, source } = parseMarkdown(md);
    // Change the paragraph starting with "Entities"
    let index = -1;
    doc.forEach((b, _o, i) => {
      if (b.textContent.startsWith('Entities')) index = i;
    });
    expect(index).toBeGreaterThan(0);
    const changed = doc.copy(doc.content.replaceChild(index, schema.nodes.paragraph.create(null, schema.text('New: 5 * 3 & <b> # x'))));
    const out = serializeMarkdown(changed, source);
    const before = source.blocks.slice(0, index).map((b) => b.raw + b.after).join('');
    expect(out.startsWith(source.lead + before)).toBe(true);
    const after = source.blocks.slice(index + 1).map((b) => b.raw + b.after).join('');
    expect(out.endsWith(after)).toBe(true);
    expect(out).toContain('New: 5 * 3 & \\<b> # x');
  });

  it('a new block at the end gets a blank line, the source keeps its trailing newline', () => {
    const md = '# Title\n\nText\n';
    const { doc, source } = parseMarkdown(md);
    const more = doc.copy(doc.content.addToEnd(schema.nodes.paragraph.create(null, schema.text('More'))));
    expect(serializeMarkdown(more, source)).toBe('# Title\n\nText\n\nMore\n');
  });

  it('a "*" list keeps its marker and tasks when changed', () => {
    const md = 'Before\n\n* [ ] a\n* [x] b\n\nAfter';
    const { doc, source } = parseMarkdown(md);
    const list = doc.child(1);
    const toggled = list.copy(list.content.replaceChild(0, list.child(0).type.create({ checked: true }, list.child(0).content)));
    const out = serializeMarkdown(doc.copy(doc.content.replaceChild(1, toggled)), source);
    expect(out).toBe('Before\n\n* [x] a\n* [x] b\n\nAfter');
  });
});

describe('writing single elements', () => {
  const write = (md: string) => serializeMarkdown(parseMarkdown(md).doc);
  const same = (md: string) => expect(write(md)).toBe(md);

  it('headings, lists, tasks, quotes, code, divider', () => {
    same('# One\n\n## Two\n\n- a\n- b\n  - c\n\n1. x\n2. y\n\n- [ ] open\n- [x] done\n\n> Quote\n\n```ts\nconst a = 1;\n```\n\n---');
  });
  it('tables with alignment and escaped |, also in code', () => {
    same('| a | b | c |\n| :-- | --: | :-: |\n| 1 \\| 2 | `x \\| y` | |');
  });
  it('links, images, autolinks, inline HTML', () => {
    same('[Text](https://a.example "T") ![Image](https://a.example/b.png) https://a.example/x_y <https://b.example> <kbd>K</kbd>');
  });
  it('escapes sparingly: only where it would otherwise read differently', () => {
    const p = (text: string) => serializeMarkdown(schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text))));
    expect(p('5 * 3 = 15')).toBe('5 * 3 = 15');
    expect(p('a_b_c')).toBe('a_b_c');
    expect(p('*not italic*')).toBe('\\*not italic\\*');
    expect(p('# not a heading')).toBe('\\# not a heading');
    expect(p('- not an item')).toBe('\\- not an item');
    expect(p('1. not a number')).toBe('1\\. not a number');
    expect(p('AT&T &amp;')).toBe('AT&T \\&amp;');
    expect(p('<div>')).toBe('\\<div>');
    expect(p('C:\\Path\\*')).toBe('C:\\Path\\\\*');
  });
  it('code with backticks and fences inside a code block', () => {
    const code = schema.nodes.code_block.create({ lang: 'md' }, schema.text('```\nx\n```'));
    expect(serializeMarkdown(schema.nodes.doc.create(null, code))).toBe('````md\n```\nx\n```\n````');
    const span = schema.nodes.paragraph.create(null, schema.text('a`b', [schema.marks.code.create()]));
    expect(serializeMarkdown(schema.nodes.doc.create(null, span))).toBe('``a`b``');
  });
  it('code made of spaces stays code; plain spaces get no mark', () => {
    const code = schema.marks.code.create();
    const em = schema.marks.em.create();
    const para = schema.nodes.paragraph.create(null, [schema.text('a '), schema.text(' ', [code]), schema.text(' b'), schema.text(' ', [em]), schema.text('c')]);
    const doc = schema.nodes.doc.create(null, para);
    const out = serializeMarkdown(doc);
    expect(out).toBe('a ` ` b c');
    expect(parseMarkdown(out).doc.firstChild!.child(1).marks[0]!.type.name).toBe('code');
  });
  it('spaces stay outside bold/italic', () => {
    const strong = schema.marks.strong.create();
    const para = schema.nodes.paragraph.create(null, [schema.text('a'), schema.text(' bold ', [strong]), schema.text('b')]);
    expect(serializeMarkdown(schema.nodes.doc.create(null, para))).toBe('a **bold** b');
  });
  it('entities', () => {
    expect(decodeEntities('&amp; &lt; &#169; &#x1F600; &copy;')).toBe('& < © 😀 &copy;');
  });
});
