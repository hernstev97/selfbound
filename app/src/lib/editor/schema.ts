// Editor schema (ProseMirror). Covers exactly what the renderer (marked, GFM, info panels) knows.
// Blocks the editor does not understand (HTML blocks, link definitions …) become `raw_block`:
// shown as source and saved unchanged. Inline HTML becomes `html_inline`. Attributes such as
// `bullet`, `delim`, `fence` and `markup` remember the source notation, so an edited list keeps
// its "*" and italic text keeps its "_".
import { t } from '@selfbound/core/i18n';
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { CALLOUT_KINDS } from '../blocks/callout.ts';

const align = {
  default: null,
  getFromDOM: (dom: HTMLElement) => dom.style.textAlign || dom.getAttribute('align') || null,
  setDOMAttr: (value: unknown, attrs: Record<string, unknown>) => {
    if (value) attrs.style = `text-align: ${String(value)}`;
  },
};

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    group: 'block',
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 1 } },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },
  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },
  // Info panel (`> [!WARNING] Title`): the title is its own text block, then any blocks.
  callout: {
    group: 'block',
    content: 'callout_title block+',
    defining: true,
    // word: the keyword as written (`TIP`), so an untouched panel is written back as it was
    attrs: { kind: { default: 'info' }, word: { default: null } },
    parseDOM: [
      {
        tag: 'div.callout',
        getAttrs: (dom: HTMLElement) => ({ kind: CALLOUT_KINDS.find((k) => dom.classList.contains(`callout-${k}`)) ?? 'info' }),
      },
    ],
    toDOM: (node): DOMOutputSpec => ['div', { class: `callout callout-${node.attrs.kind}` }, 0],
  },
  callout_title: {
    content: 'text*',
    marks: '',
    defining: true,
    parseDOM: [{ tag: 'div.callout-title' }],
    toDOM: () => ['div', { class: 'callout-title' }, 0],
  },
  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },
  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { lang: { default: '' }, fence: { default: '`' } },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (dom: HTMLElement) => ({
          lang: dom.dataset.lang ?? /language-([\w#+.-]+)/.exec(dom.querySelector('code')?.className ?? '')?.[1] ?? '',
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec => ['pre', { 'data-lang': node.attrs.lang || null, spellcheck: 'false' }, ['code', 0]],
  },
  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { bullet: { default: '-' }, tight: { default: true } },
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', 0],
  },
  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { order: { default: 1 }, delim: { default: '.' }, tight: { default: true } },
    parseDOM: [{ tag: 'ol', getAttrs: (dom: HTMLElement) => ({ order: Number(dom.getAttribute('start') ?? 1) || 1 }) }],
    toDOM: (node) => ['ol', { start: node.attrs.order === 1 ? null : node.attrs.order }, 0],
  },
  list_item: {
    content: 'paragraph block*',
    defining: true,
    // null: plain item, true/false: task (done/open)
    attrs: { checked: { default: null } },
    parseDOM: [
      {
        tag: 'li',
        getAttrs: (dom: HTMLElement) => {
          const box = dom.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]') as HTMLInputElement | null;
          return { checked: box ? box.checked : null };
        },
      },
    ],
    toDOM: (node) => ['li', { class: node.attrs.checked === null ? null : 'task' }, 0],
  },
  raw_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    // html, def (link definition) or other
    attrs: { kind: { default: 'other' } },
    toDOM: () => ['pre', { class: 'raw-md', spellcheck: 'false' }, ['code', 0]],
  },
  ...tableNodes({ tableGroup: 'block', cellContent: 'inline*', cellAttributes: { align } }),
  text: { group: 'inline' },
  image: {
    group: 'inline',
    inline: true,
    draggable: true,
    attrs: { src: {}, alt: { default: '' }, title: { default: null } },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom: HTMLElement) => ({ src: dom.getAttribute('src'), alt: dom.getAttribute('alt') ?? '', title: dom.getAttribute('title') }),
      },
    ],
    toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },
  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
  html_inline: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { raw: {} },
    toDOM: (node) => ['code', { class: 'raw-inline', title: t('HTML (kept unchanged)') }, node.attrs.raw],
  },
};

// Order = nesting when serializing: link outside, code inside.
const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null }, auto: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }) }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title, rel: 'noopener noreferrer nofollow', target: '_blank' }, 0],
  },
  em: {
    attrs: { markup: { default: '*' } },
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  strong: {
    attrs: { markup: { default: '**' } },
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom: HTMLElement) => dom.style.fontWeight !== 'normal' && null },
      { style: 'font-weight=400', clearMark: (m) => m.type.name === 'strong' },
      { style: 'font-weight', getAttrs: (value: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM: () => ['strong', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s', 0],
  },
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
};

export const schema = new Schema({ nodes, marks });
