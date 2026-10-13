// HTML of a code block. Pure and DOM-free so it can be tested on its own. The output then goes
// through DOMPurify (markdown.ts); the copy button is added afterwards by Markdown.svelte.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** `highlighted`: finished highlighter HTML, or null (neutral, text only escaped). */
export function codeBlockHtml(code: string, info: string | undefined, highlighted: string | null) {
  // Language name only as class/attribute if it looks harmless (it comes from user text).
  const lang = (info ?? '').trim().split(/\s+/, 1)[0] ?? '';
  const safe = /^[\w#+.-]{1,24}$/.test(lang) ? lang.toLowerCase() : '';
  const body = highlighted ?? escapeHtml(code.replace(/\n$/, ''));
  const attr = safe ? ` data-lang="${safe}"` : '';
  const cls = highlighted !== null ? 'hljs' : '';
  return `<div class="codeblock"${attr}><pre><code${cls ? ` class="${cls}"` : ''}>${body}</code></pre></div>\n`;
}
