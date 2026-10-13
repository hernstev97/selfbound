// Editor document → Markdown. Principle: whatever the user did not touch stays byte for byte as it
// was (blank lines, "*" instead of "-", setext headings, HTML leftovers). To do that,
// `serializeMarkdown` compares every top-level block with the source (`Source`, parse.ts): equal →
// original text, changed or new → written fresh.
//
// Freshly written blocks are escaped sparingly first ("5 * 3" stays "5 * 3"). If reading the text
// back does not give the same block, everything is escaped ("5 \* 3").
import type { Mark, Node } from 'prosemirror-model';
import { ENTITY_START, parseBlocks, type Source } from './parse.ts';

interface Ctx {
  full: boolean;
  table: boolean;
  heading: boolean;
}

/** Document → Markdown; with `source`, unchanged blocks are kept verbatim. */
export function serializeMarkdown(doc: Node, source?: Source | null): string {
  const lookup = source ? sourceLookup(source) : null;
  let out = '';
  let prev = -2; // index of the previous original block, -1 = new block, -2 = none yet
  doc.forEach((node) => {
    const k = lookup?.(node) ?? -1;
    const piece = k >= 0 ? source!.blocks[k]!.raw : serializeBlock(node);
    if (k < 0 && piece === '') return; // empty paragraph: cannot be expressed in Markdown
    if (prev === -2) out = k === 0 ? source!.lead : '';
    else if (prev >= 0 && k === prev + 1) out += source!.blocks[prev]!.after;
    else out = blankLine(out);
    out += piece;
    prev = k;
  });
  if (!source) return out;
  const last = source.blocks.length - 1;
  if (prev >= 0 && prev === last) return out + source.blocks[last]!.after;
  // If the source ended with a newline, keep it.
  const tail = last >= 0 ? source.blocks[last]!.after || source.blocks[last]!.raw : source.lead;
  return tail.endsWith('\n') && out && !out.endsWith('\n') ? `${out}\n` : out;
}

function blankLine(out: string) {
  if (out === '' || out.endsWith('\n\n')) return out;
  return out.endsWith('\n') ? `${out}\n` : `${out}\n\n`;
}

/** Finds the unchanged original block for a block (same object or same content). */
function sourceLookup(source: Source) {
  const byNode = new Map<Node, number>();
  source.blocks.forEach((b, i) => byNode.set(b.node, i));
  const used = new Set<number>();
  let byText: Map<string, number[]> | null = null;
  const key = (node: Node) => `${node.type.name}\u0000${node.textContent}`;
  return (node: Node): number => {
    let k = byNode.get(node);
    if (k === undefined || used.has(k)) {
      // After undo, blocks have the same content but are new objects.
      if (!byText) {
        byText = new Map();
        source.blocks.forEach((b, i) => {
          const list = byText!.get(key(b.node));
          if (list) list.push(i);
          else byText!.set(key(b.node), [i]);
        });
      }
      k = byText.get(key(node))?.find((i) => !used.has(i) && source.blocks[i]!.node.eq(node));
    }
    if (k === undefined) return -1;
    used.add(k);
    return k;
  };
}

/** One block, written fresh (escaped sparingly when that is unambiguous). */
export function serializeBlock(node: Node): string {
  if (node.type.name === 'paragraph' && node.content.size === 0) return '';
  const light = block(node, { full: false, table: false, heading: false });
  const parsed = parseBlocks(light);
  if (parsed.length === 1 && sameContent(parsed[0]!, node)) return light;
  return block(node, { full: true, table: false, heading: false });
}

// ---------------------------------------------------------------- Blocks

function block(node: Node, ctx: Ctx): string {
  switch (node.type.name) {
    case 'paragraph':
      return inline(node, ctx);
    case 'heading': {
      const text = inline(node, { ...ctx, heading: true }).replace(/(#+)(\s*)$/, '\\$1$2');
      return '#'.repeat(node.attrs.level as number) + (text ? ` ${text}` : '');
    }
    case 'blockquote':
      return children(node, ctx, '\n\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'code_block':
      return codeBlock(node);
    case 'horizontal_rule':
      return '---';
    case 'bullet_list':
    case 'ordered_list':
      return list(node, ctx);
    case 'table':
      return table(node, ctx);
    default:
      // raw_block and anything unknown: text as is
      return node.textContent;
  }
}

function children(node: Node, ctx: Ctx, sep: string) {
  const parts: string[] = [];
  node.forEach((child) => {
    const text = block(child, ctx);
    if (text !== '' || child.type.name !== 'paragraph') parts.push(text);
  });
  return parts.join(sep);
}

function codeBlock(node: Node) {
  const text = node.textContent;
  const char = node.attrs.fence === '~' ? '~' : '`';
  const runs = text.match(char === '~' ? /~+/g : /`+/g) ?? [];
  const fence = char.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  const lang = String(node.attrs.lang ?? '').trim();
  return `${fence}${lang}\n${text}${text ? '\n' : ''}${fence}`;
}

function list(node: Node, ctx: Ctx) {
  const tight = node.attrs.tight !== false;
  const ordered = node.type.name === 'ordered_list';
  const items: string[] = [];
  node.forEach((item, _offset, i) => {
    const marker = ordered ? `${(node.attrs.order as number) + i}${node.attrs.delim} ` : `${node.attrs.bullet} `;
    const task = item.attrs.checked === null ? '' : item.attrs.checked ? '[x] ' : '[ ] ';
    const parts: string[] = [];
    item.forEach((child, _o, j) => {
      const text = block(child, ctx);
      if (j === 0 || text !== '' || child.type.name !== 'paragraph') parts.push(text);
    });
    const indent = ' '.repeat(marker.length);
    const lines = (task + parts.join(tight ? '\n' : '\n\n')).split('\n');
    const first = marker + lines[0]!;
    items.push([task ? first : first.trimEnd(), ...lines.slice(1).map((l) => (l ? indent + l : l))].join('\n'));
  });
  return items.join(tight ? '\n' : '\n\n');
}

function table(node: Node, ctx: Ctx) {
  const rows: string[][] = [];
  const aligns: (string | null)[] = [];
  node.forEach((row, _o, r) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      if (r === 0) aligns.push((cell.attrs.align as string | null) ?? null);
      cells.push(inline(cell, { ...ctx, table: true }).trim());
    });
    rows.push(cells);
  });
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (cells: string[]) => `|${Array.from({ length: width }, (_, i) => (cells[i] ? ` ${cells[i]} ` : ' ')).join('|')}|`;
  const rule = Array.from({ length: width }, (_, i) => {
    const a = aligns[i];
    return a === 'left' ? ':--' : a === 'right' ? '--:' : a === 'center' ? ':-:' : '---';
  });
  return [line(rows[0] ?? []), `| ${rule.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

// ---------------------------------------------------------------- Inline text

const WS = /^[ \t\u00a0]+/;
const WS_END = /[ \t\u00a0]+$/;

function inline(parent: Node, ctx: Ctx): string {
  const nodes: Node[] = [];
  parent.forEach((c) => nodes.push(c));
  let out = '';
  let active: { mark: Mark; close: string }[] = [];

  const closeTo = (keep: number) => {
    if (active.length <= keep) return;
    // Spaces go outside the closing marker ("**bold** " instead of "**bold **").
    const code = active.some((a) => a.mark.type.name === 'code');
    const ws = code ? '' : (WS_END.exec(out)?.[0] ?? '');
    out = out.slice(0, out.length - ws.length);
    for (let i = active.length - 1; i >= keep; i--) out += active[i]!.close;
    out += ws;
    active = active.slice(0, keep);
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const marks = node.marks;
    let k = 0;
    while (k < active.length && k < marks.length && active[k]!.mark.eq(marks[k]!)) k++;
    closeTo(k);

    let text = node.isText ? node.text! : null;
    // Leading spaces go before the opening marker (" **bold**"), except for code, where they are
    // part of the content. Only spaces: do not mark at all.
    if (text !== null && k < marks.length && !marks.slice(k).some((m) => m.type.name === 'code')) {
      const lead = WS.exec(text)?.[0];
      if (lead) {
        out += lead;
        text = text.slice(lead.length);
        if (!text) continue;
      }
    }

    // Autolink (bare URL or <…>): write it the way it was.
    let skipped = false;
    for (let m = k; m < marks.length; m++) {
      const mark = marks[m]!;
      if (mark.type.name === 'link' && mark.attrs.auto && m === marks.length - 1 && text !== null) {
        let j = i;
        let all = text;
        while (j + 1 < nodes.length && nodes[j + 1]!.isText && nodes[j + 1]!.marks.length === marks.length && mark.isInSet(nodes[j + 1]!.marks)) all += nodes[++j]!.text!;
        const href = String(mark.attrs.href);
        if (href === all || href === `http://${all}` || href === `mailto:${all}`) {
          out += mark.attrs.auto === 'angle' ? `<${all}>` : all;
          i = j;
          skipped = true;
          break;
        }
      }
      const open = openMark(mark, nodes, i, out);
      out = open.before;
      out += open.open;
      active.push({ mark, close: open.close });
    }
    if (skipped) continue;

    if (text !== null) {
      const inCode = marks.some((m) => m.type.name === 'code');
      // In table cells "|" separates columns even inside code.
      if (inCode) out += ctx.table ? text.replace(/\|/g, '\\|') : text;
      else out += escapeText(text, ctx, out === '' || out.endsWith('\n'));
    } else if (node.type.name === 'hard_break') {
      out += ctx.table ? '<br>' : ctx.heading ? ' ' : '\n';
    } else if (node.type.name === 'image') {
      out += image(node);
    } else if (node.type.name === 'html_inline') {
      out += String(node.attrs.raw);
    }
  }
  closeTo(0);
  return out;
}

function openMark(mark: Mark, nodes: Node[], i: number, out: string): { before: string; open: string; close: string } {
  switch (mark.type.name) {
    case 'link': {
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : '';
      // "!" right before "[" would make an image.
      const before = /(^|[^\\])!$/.test(out) ? `${out.slice(0, -1)}\\!` : out;
      return { before, open: '[', close: `](${url(String(mark.attrs.href))}${title})` };
    }
    case 'em': {
      const d = mark.attrs.markup === '_' && !wordAround(nodes, i, out) ? '_' : '*';
      return { before: out, open: d, close: d };
    }
    case 'strong': {
      const d = mark.attrs.markup === '__' && !wordAround(nodes, i, out) ? '__' : '**';
      return { before: out, open: d, close: d };
    }
    case 'strike':
      return { before: out, open: '~~', close: '~~' };
    case 'code': {
      // Enough backticks that no run in the content ends the code span.
      let text = '';
      for (let j = i; j < nodes.length && mark.isInSet(nodes[j]!.marks); j++) text += nodes[j]!.text ?? '';
      const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
      const ticks = '`'.repeat(longest + 1);
      const pad = text.startsWith('`') || text.endsWith('`') || (/^ .* $/.test(text) && text.trim() !== '') ? ' ' : '';
      return { before: out, open: ticks + pad, close: pad + ticks };
    }
    default:
      return { before: out, open: '', close: '' };
  }
}

/** "_" does not work inside a word: use "*" then. */
function wordAround(nodes: Node[], i: number, out: string) {
  const before = out.at(-1) ?? '';
  let j = i;
  while (j + 1 < nodes.length && nodes[j + 1]!.marks.length >= nodes[i]!.marks.length) j++;
  const after = nodes[j + 1]?.text?.[0] ?? '';
  return /\w/.test(before) || /\w/.test(after);
}

function url(href: string) {
  return /[\s<>()]/.test(href) ? `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : href;
}

function image(node: Node) {
  const alt = String(node.attrs.alt ?? '').replace(/[[\]\\]/g, '\\$&');
  const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
  return `![${alt}](${url(String(node.attrs.src))}${title})`;
}

const URLISH = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/;

function escapeText(text: string, ctx: Ctx, lineStart: boolean): string {
  // Never escape URLs, otherwise the renderer no longer detects them as links.
  const parts = text.split(URLISH);
  return parts.map((part, i) => (i % 2 === 1 ? part : escapePart(part, ctx, lineStart && i === 0))).join('');
}

function escapePart(text: string, ctx: Ctx, lineStart: boolean): string {
  let s = text.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
  s = s.replace(ENTITY_START, '\\&').replace(/<(?=[A-Za-z/!?])/g, '\\<');
  if (ctx.table) s = s.replace(/\|/g, '\\|');
  if (ctx.full) {
    s = s.replace(/[`*~[\]]/g, '\\$&');
    s = s.replace(/_/g, (m, offset: number, all: string) => (/\w/.test(all[offset - 1] ?? '') && /\w/.test(all[offset + 1] ?? '') ? m : '\\_'));
  }
  if (lineStart) {
    s = s
      .replace(/^(#{1,6})(?=[ \t]|$)/, '\\$1')
      .replace(/^([-+*])(?=[ \t]|$)/, '\\$1')
      .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
      .replace(/^>/, '\\>')
      .replace(/^(`{3,}|~{3,})/, '\\$1')
      .replace(/^(=+|-+)[ \t]*$/, '\\$1')
      .replace(/^\[([ xX])\]/, '\\[$1]');
  }
  return s;
}

// ---------------------------------------------------------------- Comparison

/** Same block content? Notation (tight list, "*" or "_", autolink) does not count. */
export function sameContent(a: Node, b: Node): boolean {
  if (a.type !== b.type || a.childCount !== b.childCount) return false;
  if (a.isText) return a.text === b.text && sameMarks(a.marks, b.marks);
  if (!sameAttrs(a.attrs, b.attrs) || !sameMarks(a.marks, b.marks)) return false;
  for (let i = 0; i < a.childCount; i++) if (!sameContent(a.child(i), b.child(i))) return false;
  return true;
}

const STYLE_ATTRS = new Set(['tight', 'markup', 'auto']);

function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const key of Object.keys(a)) {
    if (STYLE_ATTRS.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]) {
  return a.length === b.length && a.every((m, i) => m.type === b[i]!.type && sameAttrs(m.attrs, b[i]!.attrs));
}
