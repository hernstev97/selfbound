// Markdown → editor document, with the same parser as the renderer (marked, GFM, newline = line
// break). `Source` remembers the original text of every top-level block: serialize.ts writes
// unchanged blocks back byte for byte and only regenerates changed ones.
import { Lexer, type Token, type Tokens } from 'marked';
import { Fragment, type Mark, type Node } from 'prosemirror-model';
import { schema } from './schema.ts';

export interface SourceBlock {
  node: Node;
  /** Original text of the block */
  raw: string;
  /** Blank lines up to the next block (or the end) */
  after: string;
}

export interface Source {
  /** Blank lines before the first block */
  lead: string;
  blocks: SourceBlock[];
}

const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp);/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode common HTML entities in text (&amp; → &). Others stay literal. */
export function decodeEntities(text: string) {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (all, name: string) => {
    if (name[0] !== '#') return NAMED[name] ?? all;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** The pattern serialize.ts escapes when writing "&". */
export const ENTITY_START = /&(?=(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp);)/g;

const lexer = () => new Lexer({ gfm: true, breaks: true });

/** Markdown → document with the source of each block. Empty text = one empty paragraph. */
export function parseMarkdown(markdown: string): { doc: Node; source: Source } {
  const tokens = lexer().lex(markdown);
  const source: Source = { lead: '', blocks: [] };
  for (const token of tokens) {
    if (token.type === 'space') {
      const last = source.blocks.at(-1);
      if (last) last.after += token.raw;
      else source.lead += token.raw;
      continue;
    }
    source.blocks.push({ node: blockOrRaw(token), raw: token.raw, after: '' });
  }
  const children = source.blocks.length ? source.blocks.map((b) => b.node) : [schema.nodes.paragraph.create()];
  return { doc: schema.nodes.doc.create(null, children), source };
}

/** Only the blocks (for pasted text and the round-trip check when writing). */
export function parseBlocks(markdown: string): Node[] {
  return lexer()
    .lex(markdown)
    .filter((t) => t.type !== 'space')
    .map(blockOrRaw);
}

/** One block; if it does not fit the schema, it is kept as source. */
function blockOrRaw(token: Token): Node {
  try {
    return block(token);
  } catch {
    return rawBlock(token.raw, 'other');
  }
}

function rawBlock(raw: string, kind: string) {
  const text = raw.replace(/\n+$/, '');
  return schema.nodes.raw_block.create({ kind }, text ? schema.text(text) : null);
}

function block(token: Token): Node {
  const n = schema.nodes;
  switch (token.type) {
    case 'paragraph':
      return n.paragraph.createChecked(null, inline((token as Tokens.Paragraph).tokens));
    case 'text': {
      // Text block in a tight list
      const t = token as Tokens.Text;
      return n.paragraph.createChecked(null, t.tokens ? inline(t.tokens) : textNodes(t.text, []));
    }
    case 'heading': {
      const t = token as Tokens.Heading;
      return n.heading.createChecked({ level: t.depth }, inline(t.tokens));
    }
    case 'code': {
      const t = token as Tokens.Code;
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(t.raw)?.[1]?.[0] ?? '`';
      return n.code_block.createChecked({ lang: t.lang ?? '', fence }, t.text ? schema.text(t.text) : null);
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const inner = blocks(t.tokens);
      return n.blockquote.createChecked(null, inner.length ? inner : [n.paragraph.create()]);
    }
    case 'hr':
      return n.horizontal_rule.create();
    case 'list':
      return list(token as Tokens.List);
    case 'table':
      return table(token as Tokens.Table);
    case 'html':
      return rawBlock(token.raw, 'html');
    case 'def':
      return rawBlock(token.raw, 'def');
    default:
      return rawBlock(token.raw, 'other');
  }
}

function blocks(tokens: Token[]): Node[] {
  return tokens.filter((t) => t.type !== 'space').map(block);
}

function list(token: Tokens.List): Node {
  const n = schema.nodes;
  const tight = !token.loose;
  const items = token.items.map((item) => {
    const content = blocks(withoutCheckbox(item.tokens));
    if (!content.length || content[0]!.type !== n.paragraph) content.unshift(n.paragraph.create());
    return n.list_item.createChecked({ checked: item.task ? !!item.checked : null }, content);
  });
  if (token.ordered) {
    const delim = /^\s*\d+([.)])/.exec(token.raw)?.[1] ?? '.';
    return n.ordered_list.createChecked({ order: typeof token.start === 'number' ? token.start : 1, delim, tight }, items);
  }
  const bullet = /^\s*([-*+])/.exec(token.raw)?.[1] ?? '-';
  return n.bullet_list.createChecked({ bullet, tight }, items);
}

/** A task's checkbox is its own token in the item or in its first paragraph. */
function withoutCheckbox(tokens: Token[]): Token[] {
  return tokens
    .filter((t) => t.type !== 'checkbox')
    .map((t) => ('tokens' in t && Array.isArray(t.tokens) && t.tokens.some((c) => c.type === 'checkbox') ? { ...t, tokens: t.tokens.filter((c) => c.type !== 'checkbox') } : t)) as Token[];
}

function table(token: Tokens.Table): Node {
  const n = schema.nodes;
  const cell = (type: typeof n.table_cell, c: Tokens.TableCell, i: number) => type.createChecked({ align: token.align[i] ?? null }, inline(c.tokens));
  const header = n.table_row.createChecked(null, token.header.map((c, i) => cell(n.table_header, c, i)));
  const rows = token.rows.map((row) => n.table_row.createChecked(null, row.map((c, i) => cell(n.table_cell, c, i))));
  return n.table.createChecked(null, [header, ...rows]);
}

function textNodes(text: string, marks: readonly Mark[]): Node[] {
  return text ? [schema.text(text, marks)] : [];
}

function inline(tokens: Token[] | undefined, marks: readonly Mark[] = []): Node[] {
  const out: Node[] = [];
  const m = schema.marks;
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        out.push(...(t.tokens ? inline(t.tokens, marks) : textNodes(decodeEntities(t.text), marks)));
        break;
      }
      case 'escape':
        out.push(...textNodes(decodeEntities((token as Tokens.Escape).text), marks));
        break;
      case 'strong':
        out.push(...inline((token as Tokens.Strong).tokens, m.strong.create({ markup: token.raw.slice(0, 2) }).addToSet(marks)));
        break;
      case 'em':
        out.push(...inline((token as Tokens.Em).tokens, m.em.create({ markup: token.raw[0] }).addToSet(marks)));
        break;
      case 'del':
        out.push(...inline((token as Tokens.Del).tokens, m.strike.create().addToSet(marks)));
        break;
      case 'codespan':
        out.push(...textNodes((token as Tokens.Codespan).text, m.code.create().addToSet(marks)));
        break;
      case 'link': {
        const t = token as Tokens.Link;
        const auto = t.raw.startsWith('<') ? 'angle' : t.raw.startsWith('[') ? null : 'bare';
        out.push(...inline(t.tokens, m.link.create({ href: t.href, title: t.title ?? null, auto }).addToSet(marks)));
        break;
      }
      case 'image': {
        const t = token as Tokens.Image;
        out.push(schema.nodes.image.create({ src: t.href, alt: decodeEntities(t.text), title: t.title ?? null }, null, marks));
        break;
      }
      case 'br':
        out.push(schema.nodes.hard_break.create(null, null, marks));
        break;
      case 'html':
        out.push(schema.nodes.html_inline.create({ raw: token.raw }, null, marks));
        break;
      case 'checkbox':
        break;
      default:
        out.push(...textNodes(token.raw, marks));
    }
  }
  return out;
}

/** Pasted Markdown text as a fragment (Ctrl V). */
export function markdownFragment(markdown: string): Fragment {
  return Fragment.from(parseBlocks(markdown));
}
