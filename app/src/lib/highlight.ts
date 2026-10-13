// Syntax highlighting for code blocks: highlight.js (core + selected languages), loaded as its own
// chunk only when a text contains a code block with a language. Nothing is guessed: without a
// (known) language the block stays neutral.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { languageFor } from './languages.ts';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
// Svelte, Vue and HTML use xml (names and spellings: languages.ts).
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

/** Code block info string ("ts", "Svelte" …) to a registered language, otherwise null. */
export function languageOf(info: string | undefined): string | null {
  return languageFor(info)?.grammar ?? null;
}

/** Highlighted HTML (spans with `hljs-*` classes, text escaped), or null without a known language. */
export function highlightCode(code: string, info: string | undefined): string | null {
  const language = languageOf(info);
  if (!language) return null;
  try {
    return hljs.highlight(code.replace(/\n$/, ''), { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

export interface CodeRange {
  from: number;
  to: number;
  cls: string;
}

const HTML_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };

/**
 * Color ranges for the editor (offsets in the code, classes as in the rendered HTML), or null
 * without a known language. Reads highlight.js's HTML for that: spans open/close, text counts.
 */
export function codeRanges(code: string, info: string | undefined): CodeRange[] | null {
  const language = languageOf(info);
  if (!language) return null;
  let html: string;
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const ranges: CodeRange[] = [];
  const stack: string[] = [];
  let pos = 0;
  for (const m of html.matchAll(/<span class="([^"]+)">|<\/span>|([^<]+)/g)) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[0] === '</span>') stack.pop();
    else {
      const text = m[2]!.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => HTML_ENTITY[e]!);
      if (stack.length) ranges.push({ from: pos, to: pos + text.length, cls: stack.join(' ') });
      pos += text.length;
    }
  }
  return ranges;
}
