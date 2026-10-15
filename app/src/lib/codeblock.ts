// HTML of a code block. Pure and DOM-free so it can be tested on its own. The output then goes
// through DOMPurify (markdown.ts); the copy button is added afterwards by Markdown.svelte.
import { langWord } from './languages.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** What a highlighted token may carry as `style`: its dark and light color as custom properties (hex, or a `--sx-*` variable of md.css). */
export const TOKEN_STYLE = /^--[dl]:(?:#[0-9a-f]{6}|var\(--sx-[a-z]+\))(?:;--[dl]:(?:#[0-9a-f]{6}|var\(--sx-[a-z]+\)))?$/;

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/**
 * Another renderer for a fence language (diagrams …): it returns the block's finished HTML, or null
 * to leave the block to the code block renderer. Claimed languages never reach the highlighter.
 */
export type FenceRenderer = (code: string, info: string) => string | null;

const claimed = new Map<string, FenceRenderer>();

/** Claims a fence language (as after the fence: "mermaid"). Returns a function that gives it back. */
export function claimFence(lang: string, render: FenceRenderer): () => void {
  const word = lang.toLowerCase();
  claimed.set(word, render);
  return () => void (claimed.get(word) === render && claimed.delete(word));
}

/** The renderer that claimed this info string's language, if any. */
export const fenceClaim = (info: string | undefined) => claimed.get(langWord(info));

/** `highlighted`: finished highlighter HTML, or null (neutral, text only escaped). */
export function codeBlockHtml(code: string, info: string | undefined, highlighted: string | null) {
  // Language name only as class/attribute if it looks harmless (it comes from user text).
  const lang = (info ?? '').trim().split(/\s+/, 1)[0] ?? '';
  const safe = /^[\w#+.-]{1,24}$/.test(lang) ? lang.toLowerCase() : '';
  const body = highlighted ?? escapeHtml(code.replace(/\n$/, ''));
  const attr = safe ? ` data-lang="${safe}"` : '';
  const cls = highlighted !== null ? 'hl' : '';
  return `<div class="codeblock"${attr}><pre><code${cls ? ` class="${cls}"` : ''}>${body}</code></pre></div>\n`;
}
