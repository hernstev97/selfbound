// Third-party notices (vite.notices.ts) and the source link (vite.plugins.ts sourceUrl), SELF-83.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectNotices, licenseAllowed, mergeNotices, type Notice, packageOf, parseGrammarNotice, renderNotices } from '../vite.notices.ts';
import { DEFAULT_SOURCE_URL, sourceUrl } from '../vite.plugins.ts';

const app = fileURLToPath(new URL('..', import.meta.url));

describe('licenseAllowed', () => {
  it('accepts AGPL-compatible licenses and expressions', () => {
    for (const id of ['MIT', 'Apache-2.0', 'OFL-1.1', 'LGPL-3.0-only', '(MPL-2.0 OR Apache-2.0)', 'MIT AND ISC', 'GPL-2.0-only OR MIT']) expect(licenseAllowed(id), id).toBe(true);
  });
  it('rejects missing, unknown and incompatible licenses', () => {
    for (const id of [undefined, '', 'UNLICENSED', 'SEE LICENSE IN LICENSE', 'GPL-2.0-only', 'SSPL-1.0', 'BUSL-1.1', 'MIT AND SSPL-1.0', 'CC-BY-NC-4.0', '(MIT OR Apache-2.0) AND SSPL-1.0']) expect(licenseAllowed(id), String(id)).toBe(false);
  });
});

describe('packageOf', () => {
  it('finds the package of a module path, scoped or not, in pnpm layout', () => {
    expect(packageOf('/r/node_modules/.pnpm/svelte@5.0.0/node_modules/svelte/src/index.js?v=1')).toEqual({ name: 'svelte', dir: '/r/node_modules/.pnpm/svelte@5.0.0/node_modules/svelte' });
    expect(packageOf('/r/node_modules/.pnpm/@shikijs+langs@4/node_modules/@shikijs/langs/dist/css.mjs')?.name).toBe('@shikijs/langs');
  });
  it('ignores first-party code', () => {
    expect(packageOf('/r/app/src/main.ts')).toBeNull();
  });
});

describe('parseGrammarNotice', () => {
  it('maps every file of a section to its license', () => {
    const rule = '='.repeat(40);
    const notice = `Intro\n${rule}\nFiles:   a.json, b.json\nLicense: https://x/LICENSE\nSPDX:    MIT\n${'-'.repeat(40)}\nMIT text\n${rule}\nFiles:   c.json\nLicense: https://y\nSPDX:    Apache-2.0\n${'-'.repeat(40)}\nApache text\n`;
    const sections = parseGrammarNotice(notice);
    expect(sections.get('b')).toEqual({ license: 'MIT', url: 'https://x/LICENSE', text: 'MIT text' });
    expect(sections.get('c')?.license).toBe('Apache-2.0');
  });
});

describe('collectNotices', () => {
  it('reads packages, vendored themes and Shiki grammars that are in the bundle', () => {
    const svelte = fileURLToPath(new URL('../node_modules/svelte/src/index-client.js', import.meta.url));
    const notices = collectNotices([svelte, `${app}src/themes/nord/theme.json`, '/x/node_modules/@shikijs/langs/dist/kotlin.mjs', '/x/app/src/main.ts']);
    const byKind = (kind: Notice['kind']) => notices.filter((n) => n.kind === kind);
    expect(byKind('package').map((n) => n.name)).toEqual(['svelte']);
    expect(byKind('package')[0]!.text).toMatch(/Permission is hereby granted/);
    expect(byKind('theme')[0]).toMatchObject({ name: 'Nord', license: 'MIT' });
    expect(byKind('grammar')[0]).toMatchObject({ name: 'kotlin', license: 'MIT' });
    expect(notices.every((n) => licenseAllowed(n.license))).toBe(true);
  });
  it('credits Vite for its injected helpers, without the licenses of its own dependencies', () => {
    const [vite] = collectNotices(['\0vite/preload-helper.js']);
    expect(vite).toMatchObject({ name: 'vite', license: 'MIT' });
    expect(vite!.text).not.toMatch(/bundled dependencies/i);
  });
});

describe('mergeNotices and renderNotices', () => {
  const a: Notice = { kind: 'package', name: 'b-pkg', version: '1.0.0', license: 'MIT', text: 'B' };
  const b: Notice = { kind: 'grammar', name: 'css', license: 'MIT', text: 'G' };
  const c: Notice = { kind: 'package', name: 'a-pkg', version: '2.0.0', license: 'ISC', text: 'A' };
  it('merges two builds without duplicates, packages first', () => {
    expect(mergeNotices([a, b], [a, c]).map((n) => n.name)).toEqual(['a-pkg', 'b-pkg', 'css']);
  });
  it('names the source link and every entry with its license text', () => {
    const text = renderNotices(mergeNotices([a, c]), 'https://git.example.org/fork');
    expect(text).toContain('Source code: https://git.example.org/fork');
    expect(text).toContain('- Package: a-pkg 2.0.0 (ISC)');
    expect(text).toMatch(/b-pkg 1\.0\.0\nPackage, license: MIT\n\nB/);
  });
});

describe('sourceUrl', () => {
  it('defaults to the upstream repository and takes a fork’s URL', () => {
    expect(sourceUrl({})).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl({ SELFBOUND_SOURCE_URL: ' https://git.example.org/fork/ ' })).toBe('https://git.example.org/fork');
  });
  it('rejects values that are not a plain http(s) URL', () => {
    for (const bad of ['javascript:alert(1)', 'git@github.com:x/y.git', 'https://x.example/"onmouseover=1', 'https://x.example/a b']) expect(() => sourceUrl({ SELFBOUND_SOURCE_URL: bad })).toThrow(/SELFBOUND_SOURCE_URL/);
  });
  it('the sign-in page carries the placeholder and the link to the notices', () => {
    const html = readFileSync(`${app}welcome.html`, 'utf8');
    expect(html).toContain('href="%SELFBOUND_SOURCE_URL%"');
    expect(html).toContain('href="/third-party-notices.txt"');
  });
});
