// Change the language of a code block in rendered Markdown (description, own comment): replace the
// info string at the fence of the n-th code block in the source, without loading the editor.
//
// The same parser as the renderer (`marked`) decides which fence belongs to which block: its code
// blocks (in render order) are matched with the fences in the source by language and content.
// Indented code, fence-like lines inside indented code or HTML, and anything that cannot be matched
// unambiguously give null: then nothing changes.
import type { Token, TokensList } from 'marked';
import { langWord } from './languages.ts';

/** Opening fence, also in quotes and lists; group 1 = prefix, 2 = fence, 3 = info string. */
const OPEN = /^((?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*)(`{3,}|~{3,})(.*)$/;
const CLOSE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})[ \t]*$/;
const SAFE_LANG = /^[\w#+.-]{0,24}$/;

interface Fence {
  line: number;
  /** Line of the closing fence (or end of text) */
  end: number;
  info: string;
  body: string;
}

/** Lines without quote/indent prefix and trailing space: comparable with `token.text`. */
const norm = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/^(?:[ \t]*>)*[ \t]*/, '').trimEnd())
    .join('\n')
    .trim();

/**
 * Every line that looks like an opening fence, with its content up to the closing fence. Each on
 * its own: whether a line really is a fence (and not inside indented code or HTML) is decided by
 * the match with `marked`.
 */
function fences(lines: string[]): Fence[] {
  const out: Fence[] = [];
  lines.forEach((line, i) => {
    const m = OPEN.exec(line);
    // Backtick fences must not have a backtick in the info string (that would be inline code).
    if (!m || (m[2]![0] === '`' && m[3]!.includes('`'))) return;
    const fence = m[2]!;
    let end = i + 1;
    for (; end < lines.length; end++) {
      const c = CLOSE.exec(lines[end]!)?.[1];
      if (c && c[0] === fence[0] && c.length >= fence.length) break;
    }
    out.push({ line: i, end, info: m[3]!, body: norm(lines.slice(i + 1, end).join('\n')) });
  });
  return out;
}

/** Code blocks in render order (also inside lists and quotes). */
function codeTokens(tokens: Token[] | TokensList, out: Token[] = []): Token[] {
  for (const token of tokens) {
    if (token.type === 'code') out.push(token);
    const t = token as { tokens?: Token[]; items?: { tokens?: Token[] }[] };
    if (t.items) for (const item of t.items) codeTokens(item.tokens ?? [], out);
    if (t.tokens) codeTokens(t.tokens, out);
  }
  return out;
}

/**
 * The text with a new language on code block `index`, or null. `tokens`: `marked` lexer output for
 * the same text (as in the renderer). null if the number of blocks is not `total`, the block has
 * no fence, or it cannot be matched to exactly one fence.
 */
export function setCodeLangIn(markdown: string, tokens: Token[] | TokensList, index: number, total: number, lang: string): string | null {
  const blocks = codeTokens(tokens);
  if (blocks.length !== total || index < 0 || index >= total || !SAFE_LANG.test(lang)) return null;
  const lines = markdown.split('\n');
  const candidates = fences(lines);
  // Match blocks to fences in order (same language, same content).
  let next = 0;
  let target: Fence | null = null;
  for (let k = 0; k <= index; k++) {
    const block = blocks[k] as { codeBlockStyle?: string; lang?: string; text: string };
    let hit: Fence | null = null;
    if (block.codeBlockStyle !== 'indented') {
      const want = { lang: langWord(block.lang), body: norm(block.text) };
      for (const f of candidates) {
        if (f.line < next || langWord(f.info) !== want.lang || f.body !== want.body) continue;
        hit = f;
        next = f.end + 1; // fences inside this block are out of the question now
        break;
      }
    }
    if (k === index) target = hit;
  }
  if (!target) return null;
  const [, before, marks, info] = OPEN.exec(lines[target.line]!)!;
  // Only the first word is the language; anything after it (title=…) stays as long as there is one.
  const rest = info!.trim().replace(/^\S+/, '').trim();
  lines[target.line] = `${before}${marks}${lang ? [lang, rest].filter(Boolean).join(' ') : ''}`;
  return lines.join('\n');
}

/** Like `setCodeLangIn`, lexes the text itself with `marked` (already loaded by the renderer). */
export async function setCodeLang(markdown: string, index: number, total: number, lang: string): Promise<string | null> {
  const { Lexer } = await import('marked');
  return setCodeLangIn(markdown, Lexer.lex(markdown, { gfm: true, breaks: true }), index, total, lang);
}
