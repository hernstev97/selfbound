import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { claimFence, codeBlockHtml, TOKEN_STYLE } from '../src/lib/codeblock.ts';
import { LANGUAGES } from '../src/lib/languages.ts';
import { contrast, parseHex } from '../src/lib/look/color.ts';
import { mapTheme, MIN_SYNTAX } from '../src/lib/look/map.ts';
import { selfboundSyntax, syntaxSet, syntaxTheme, type SyntaxSet } from '../src/lib/look/syntax.ts';
import { readTheme, type VsTheme } from '../src/lib/look/vscode.ts';

// The browser fetches the .wasm file; here the same engine reads it from disk.
vi.mock('../src/lib/highlightEngine.ts', async () => {
  const { createOnigurumaEngine } = await import('shiki/engine/oniguruma');
  const wasm = createRequire(import.meta.url).resolve('shiki/onig.wasm');
  return { createEngine: () => createOnigurumaEngine(readFileSync(wasm)) };
});

const highlight = await import('../src/lib/highlight.ts');
const { look } = await import('../src/lib/look/index.ts');
const { fenceGrammars, needsHighlight } = await import('../src/lib/highlightLoad.ts');

const source = (id: string) => readFileSync(new URL(`../src/themes/${id}/theme.json`, import.meta.url), 'utf8');
const set = (dark: VsTheme | null, light: VsTheme | null, rev: number): SyntaxSet =>
  syntaxSet(rev, dark && syntaxTheme(dark, mapTheme(dark)), light && syntaxTheme(light, mapTheme(light)));

describe('code block language', () => {
  it('detects the required languages and their short forms', () => {
    for (const info of ['ts', 'typescript', 'js', 'javascript', 'svelte', 'json', 'bash', 'sh', 'shell', 'sql', 'python', 'py', 'kotlin', 'kt', 'yaml', 'yml', 'markdown', 'md', 'diff']) {
      expect(highlight.languageOf(info), info).not.toBeNull();
    }
    expect(highlight.languageOf('TS')).toBe('typescript');
    expect(highlight.languageOf('ts title="a.ts"')).toBe('typescript');
  });
  it('has a grammar for every language of the picker', () => {
    for (const lang of LANGUAGES) expect(highlight.languageOf(lang.id), lang.id).toBe(lang.grammar);
  });
  it('guesses nothing: without an info string or with an unknown language it stays neutral', () => {
    expect(highlight.languageOf(undefined)).toBeNull();
    expect(highlight.languageOf('')).toBeNull();
    expect(highlight.languageOf('klingon')).toBeNull();
    expect(highlight.highlightCode('const a = 1', undefined)).toBeNull();
  });
});

describe('loading only when needed', () => {
  it('finds the grammars of fences, also in quotes and lists', () => {
    for (const text of ['```ts\nx\n```', '~~~sh\nx\n~~~', '> ```ts\n> x', '- ```ts\n  x', '1. ```json\n   {}']) expect(needsHighlight(text), text).toBe(true);
    for (const text of ['```\nx\n```', 'Text without code', 'Inline ```ts in a sentence', '```klingon\nx\n```']) expect(needsHighlight(text), text).toBe(false);
    expect(fenceGrammars('```ts\na\n```\n```TSX\nb\n```\n```py\nc\n```').sort()).toEqual(['python', 'typescript']);
  });
  it('another renderer can claim a fence language; the highlighter never sees it', () => {
    expect(needsHighlight('```mermaid\ngraph TD\n```')).toBe(false);
    const release = claimFence('ts', () => '<div>claimed</div>');
    expect(needsHighlight('```ts\nx\n```')).toBe(false);
    release();
    expect(needsHighlight('```ts\nx\n```')).toBe(true);
  });
});

describe('highlighting', () => {
  beforeAll(async () => {
    look.syntax.set(set(readTheme(source('dracula')), readTheme(source('github-light')), 1));
    await highlight.prepare(['typescript']);
  });

  it('is neutral until the grammar is loaded, and loads only what is asked for', async () => {
    expect(highlight.isReady('typescript')).toBe(true);
    expect(highlight.isReady('python')).toBe(false);
    expect(highlight.highlightCode('def f(x): pass', 'py')).toBeNull();
    await highlight.prepare(['python']);
    expect(highlight.highlightCode('def f(x): pass', 'py')).toMatch(/<span class="tk/);
  });

  it('colors with the colors of the theme, dark and light in one go', () => {
    const html = highlight.highlightCode('const n: number = 1; // one', 'ts')!;
    // Dracula keyword, GitHub Light keyword
    expect(html).toContain('<span class="tk" style="--d:#ff79c6;--l:#cf222e">const</span>');
    expect(html).toContain('// one</span>');
  });

  it('applies context selectors and font styles of the theme', async () => {
    const theme: VsTheme = {
      name: 'Context',
      type: 'dark',
      colors: { 'editor.background': '#202020', 'editor.foreground': '#d0d0d0' },
      tokenColors: [
        { scope: 'string', settings: { foreground: '#ff0000' } },
        { scope: 'meta.tag string', settings: { foreground: '#00ff00' } },
        { scope: 'comment', settings: { foreground: '#8888ff', fontStyle: 'italic bold' } },
      ],
    };
    look.syntax.set(set(theme, null, 2));
    await highlight.prepare(['html']);
    const tag = highlight.highlightCode('<a href="x">t</a> <!-- c -->', 'html')!;
    expect(tag).toMatch(/--d:#00ff00[^>]*>&quot;x&quot;/);
    expect(tag).toMatch(/class="tk tk-di tk-db[^"]*"[^>]*>&lt;!-- c --&gt;/);
    // The same kind of token outside a tag has the plain string color.
    expect(highlight.highlightCode('const s = "x"', 'ts')).toMatch(/--d:#ff0000[^>]*>&quot;x&quot;/);
  });

  it('keeps every color readable on the code block (3 : 1) and in the allowed form', async () => {
    const dim: VsTheme = {
      name: 'Dim',
      type: 'dark',
      colors: { 'editor.background': '#202020', 'editor.foreground': '#d0d0d0' },
      tokenColors: [{ scope: ['keyword', 'storage'], settings: { foreground: '#252525' } }],
    };
    const mapped = mapTheme(dim);
    look.syntax.set(set(dim, null, 3));
    await highlight.prepare(['typescript']);
    const html = highlight.highlightCode('const a = 1', 'ts')!;
    const color = /--d:(#[0-9a-f]{6})/.exec(html)![1]!;
    expect(contrast(parseHex(color)!, parseHex(mapped.vars['code-bg'])!)).toBeGreaterThanOrEqual(MIN_SYNTAX);
    for (const m of html.matchAll(/style="([^"]+)"/g)) expect(m[1], m[1]).toMatch(TOKEN_STYLE);
  });

  it('the Selfbound colors follow the CSS variables', async () => {
    look.syntax.set(syntaxSet(4, null, null));
    await highlight.prepare(['typescript', 'yaml']);
    const html = highlight.highlightCode('const a = "x"; // c', 'ts')!;
    expect(html).toContain('--d:var(--sx-keyword);--l:var(--sx-keyword)">const');
    expect(html).toContain('var(--sx-string)');
    expect(html).toContain('var(--sx-comment)');
    for (const m of html.matchAll(/style="([^"]+)"/g)) expect(m[1], m[1]).toMatch(TOKEN_STYLE);
    // Plain code has no span at all.
    expect(html).toContain(' a ');
    expect(selfboundSyntax('dark').fg).not.toBe(selfboundSyntax('light').theme.colors['editor.background']);
  });

  it('escapes HTML in code (no injection)', () => {
    const html = highlight.highlightCode('const s = "<img src=x onerror=alert(1)>"', 'ts')!;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('returns offsets for the editor that match the code', () => {
    const code = 'const a = "<b>" && 1;';
    const ranges = highlight.codeRanges(code, 'ts')!;
    const kw = ranges.find((r) => code.slice(r.from, r.to) === 'const')!;
    expect(kw.cls).toBe('tk');
    expect(kw.style).toContain('--d:');
    expect(ranges.some((r) => code.slice(r.from, r.to) === '"<b>"')).toBe(true);
    // Several lines: offsets count the line breaks.
    const two = 'let a;\nconst b = 1;';
    expect(highlight.codeRanges(two, 'ts')!.some((r) => two.slice(r.from, r.to) === 'const')).toBe(true);
    expect(highlight.codeRanges(code, 'klingon')).toBeNull();
  });

  it('very long code stays neutral; the editor limit is lower than the display limit', () => {
    const long = 'const a = 1;\n'.repeat(1000); // 13,000 characters
    expect(highlight.highlightCode(long, 'ts')).toMatch(/<span class="tk/);
    expect(highlight.codeRanges(long, 'ts')).toBeNull();
    expect(highlight.highlightCode('const a = 1;\n'.repeat(2000), 'ts')).toBeNull();
  });

  it('colors every language of the picker', async () => {
    look.syntax.set(syntaxSet(5, null, null));
    const samples: Record<string, string> = {
      typescript: 'const n: number = 1; // one',
      javascript: 'const n = 1;',
      svelte: '<script lang="ts">let a = $state(1)</script><p>{a}</p>',
      vue: '<template><p>{{ a }}</p></template>',
      html: '<p class="a">x</p>',
      xml: '<a b="c"/>',
      css: 'a { color: red; }',
      json: '{"a": [1, true, "x"]}',
      bash: 'echo "hi" && pnpm test',
      sql: "select id from issues where title = 'x'",
      python: 'def f(x):\n    return x + 1',
      kotlin: 'fun main() { println("hi") }',
      yaml: 'name: ci\non: [push]',
      markdown: '# Title\n- **bold**',
      diff: '-old\n+new',
    };
    await highlight.prepare(LANGUAGES.map((l) => l.grammar));
    for (const lang of LANGUAGES) expect(highlight.highlightCode(samples[lang.id]!, lang.id), lang.id).toMatch(/<span class="tk/);
  });
});

describe('code block HTML', () => {
  it('without highlighting: text escaped, no highlight class', () => {
    const html = codeBlockHtml('<b>&</b>\n', undefined, null);
    expect(html).toContain('<code>&lt;b&gt;&amp;&lt;/b&gt;</code>');
    expect(html).not.toContain('class="hl"');
    expect(html).not.toContain('data-lang');
  });
  it('with highlighting: language as data-lang, class hl', () => {
    const html = codeBlockHtml('x', 'ts', '<span class="tk">x</span>');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('class="hl"');
  });
  it('the neutral block and the colored one have the same text', () => {
    const code = 'const a = 1;\nlet b = "x";\n';
    const plain = codeBlockHtml(code, 'ts', null);
    const colored = codeBlockHtml(code, 'ts', highlight.highlightCode(code, 'ts'));
    const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    expect(text(colored)).toBe(text(plain));
  });
  it('an unsafe info string is not used', () => {
    expect(codeBlockHtml('x', '"><script>', null)).not.toContain('data-lang');
  });
});
