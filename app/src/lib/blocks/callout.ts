// Info panels ("callouts"): a quote whose first line is `[!KIND] optional title`, the GitHub alert
// syntax plus a title. Shared by the renderer (markdownRender.ts) and the editor (editor/parse.ts),
// so both read the same text the same way. Pure: no DOM, no translation.
import { t } from '@selfbound/core/i18n';
import { Lexer, type Token, type Tokens } from 'marked';
import { escapeHtml } from '../codeblock.ts';

export const CALLOUT_KINDS = ['info', 'note', 'success', 'warning', 'error'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

// GitHub's five alert names read as the nearest panel; the word stays in the text as written.
const KEYWORDS: Record<string, CalloutKind> = {
  info: 'info',
  note: 'note',
  success: 'success',
  warning: 'warning',
  error: 'error',
  tip: 'success',
  important: 'info',
  caution: 'error',
};

/** Panel kind for a keyword (`WARNING`, `tip` …), or null if it is not one. */
export function calloutKind(word: string): CalloutKind | null {
  return KEYWORDS[word.toLowerCase()] ?? null;
}

/** The first line of a panel: `[!WARNING] Title` (title optional). */
const MARKER = /^\[!([A-Za-z]+)\][ \t]*([^\n]*)(?:\n|$)/;

export interface Callout {
  kind: CalloutKind;
  /** Keyword as written (`TIP`), kept so the editor writes the text back unchanged */
  word: string;
  title: string;
  /** Block tokens after the first line */
  body: Token[];
}

/** The marker at the start of a quote's text, or null (`[!FOO]`, text before the marker …). */
export function parseCalloutLine(text: string) {
  const m = MARKER.exec(text);
  const kind = m && calloutKind(m[1]!);
  if (!m || !kind) return null;
  return { kind, word: m[1]!, title: m[2]!.trim(), length: m[0].length };
}

/** Is this quote a panel? Returns its parts, with the rest of the first paragraph as body. */
export function calloutOf(quote: Tokens.Blockquote): Callout | null {
  const first = quote.tokens[0];
  if (first?.type !== 'paragraph') return null;
  const paragraph = first as Tokens.Paragraph;
  const line = parseCalloutLine(paragraph.text);
  if (!line) return null;
  const rest = paragraph.text.slice(line.length);
  const body: Token[] = [];
  if (rest) body.push({ type: 'paragraph', raw: rest, text: rest, tokens: new Lexer({ gfm: true, breaks: true }).inlineTokens(rest) } satisfies Tokens.Paragraph);
  body.push(...quote.tokens.slice(1));
  return { kind: line.kind, word: line.word, title: line.title, body };
}

/** Visible name of a kind when the panel has no title. Translated at call time. */
export function calloutLabel(kind: CalloutKind): string {
  switch (kind) {
    case 'info':
      return t('Info');
    case 'note':
      return t('Note');
    case 'success':
      return t('Success');
    case 'warning':
      return t('Warning');
    case 'error':
      return t('Error');
  }
}

/**
 * HTML of one panel. `bodyHtml` is the already rendered content. The result goes through DOMPurify
 * like all Markdown output; the icon is drawn by CSS (md.css), so there is no markup for it but an
 * empty span.
 */
export function calloutHtml(callout: Callout, bodyHtml: string): string {
  const label = calloutLabel(callout.kind);
  const title = callout.title || label;
  // The kind is part of the name even when the title is custom (the icon alone says it only to eyes).
  const name = callout.title ? `${label}: ${callout.title}` : label;
  return (
    `<div class="callout callout-${callout.kind}" role="note" aria-label="${escapeHtml(name)}">` +
    `<div class="callout-title"><span class="callout-icon" aria-hidden="true"></span><span class="callout-name">${escapeHtml(title)}</span></div>` +
    `<div class="callout-body">${bodyHtml}</div></div>\n`
  );
}
