import { describe, expect, it } from 'vitest';
import { codeBlockHtml } from '../src/lib/codeblock.ts';
import { codeRanges, highlightCode, languageOf } from '../src/lib/highlight.ts';

describe('code block language', () => {
  it('detects the required languages and their short forms', () => {
    for (const info of ['ts', 'typescript', 'js', 'javascript', 'svelte', 'json', 'bash', 'sh', 'shell', 'sql', 'python', 'py', 'kotlin', 'kt', 'yaml', 'yml', 'markdown', 'md', 'diff']) {
      expect(languageOf(info), info).not.toBeNull();
    }
    expect(languageOf('TS')).toBe('typescript');
    expect(languageOf('ts title="a.ts"')).toBe('typescript');
  });
  it('guesses nothing: without an info string or with an unknown language it stays neutral', () => {
    expect(languageOf(undefined)).toBeNull();
    expect(languageOf('')).toBeNull();
    expect(languageOf('klingon')).toBeNull();
    expect(highlightCode('const a = 1', undefined)).toBeNull();
  });
});

describe('highlighting', () => {
  const samples: Record<string, string> = {
    ts: 'const n: number = 1; // one',
    svelte: '<script lang="ts">let a = $state(1)</script><p>{a}</p>',
    json: '{"a": [1, true, "x"]}',
    bash: 'echo "hi" && pnpm test',
    sql: "select id from issues where title = 'x'",
    python: 'def f(x):\n    return x + 1',
    kotlin: 'fun main() { println("hi") }',
    yaml: 'name: ci\non: [push]',
    markdown: '# Title\n- **bold**',
    diff: '-old\n+new',
  };
  for (const [lang, code] of Object.entries(samples)) {
    it(`${lang}: returns spans`, () => {
      expect(highlightCode(code, lang)).toMatch(/<span class="hljs-/);
    });
  }
  it('escapes HTML in code (no injection)', () => {
    const html = highlightCode('const s = "<img src=x onerror=alert(1)>"', 'ts')!;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('code block HTML', () => {
  it('without highlighting: text escaped, no hljs class', () => {
    const html = codeBlockHtml('<b>&</b>\n', undefined, null);
    expect(html).toContain('<code>&lt;b&gt;&amp;&lt;/b&gt;</code>');
    expect(html).not.toContain('hljs');
    expect(html).not.toContain('data-lang');
  });
  it('with highlighting: language as data-lang, class hljs', () => {
    const html = codeBlockHtml('x', 'ts', highlightCode('const a = 1', 'ts'));
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('class="hljs"');
  });
  it('an unsafe info string is not used', () => {
    expect(codeBlockHtml('x', '"><script>', null)).not.toContain('data-lang');
  });
});

describe('loading only when needed', () => {
  it('detects fences with a language, also in quotes and lists', async () => {
    const { needsHighlight } = await import('../src/lib/markdown.ts');
    for (const text of ['```ts\nx\n```', '~~~sh\nx\n~~~', '> ```ts\n> x', '- ```ts\n  x', '1. ```json\n   {}']) expect(needsHighlight(text), text).toBe(true);
    for (const text of ['```\nx\n```', 'Text without code', 'Inline ```ts in a sentence']) expect(needsHighlight(text), text).toBe(false);
  });
});

describe('color ranges for the editor', () => {
  it('returns offsets that match the code', () => {
    const code = 'const a = "<b>" && 1;';
    const ranges = codeRanges(code, 'ts')!;
    const kw = ranges.find((r) => r.cls.includes('hljs-keyword'))!;
    expect(code.slice(kw.from, kw.to)).toBe('const');
    const str = ranges.find((r) => r.cls.includes('hljs-string'))!;
    expect(code.slice(str.from, str.to)).toBe('"<b>"');
    expect(codeRanges(code, 'klingon')).toBeNull();
  });
});
