// Logo files, the inline paths in the app and the CSS masks all come from brand/*.svg.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/lib/brand.ts';

const repo = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8');
const pathsOf = (svg: string) =>
  [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => ({ d: m[0].match(/\sd="([^"]+)"/)![1], transform: m[0].match(/\stransform="([^"]+)"/)?.[1] }));
const viewBoxOf = (svg: string) => svg.match(/viewBox="([^"]+)"/)![1].trim().split(/[\s,]+/).map(Number).join(' ');
const INK = '#070707';
const PAPER = '#FFFFFF';

describe('logo', () => {
  it('the generated files carry the shapes and view boxes of the sources', () => {
    for (const kind of ['symbol', 'wordmark', 'lockup'] as const) {
      const source = read('brand', `${kind}.svg`);
      expect(BRAND[kind].paths.map((p) => ({ d: p.d, transform: 'transform' in p ? p.transform : undefined }))).toEqual(pathsOf(source));
      expect(BRAND[kind].viewBox).toBe(viewBoxOf(source));
      for (const variant of ['', '-ink', '-paper']) {
        const svg = read('app', 'public', 'brand', `selfbound-${kind}${variant}.svg`);
        expect(pathsOf(svg)).toEqual(pathsOf(source));
        expect(viewBoxOf(svg)).toBe(BRAND[kind].viewBox);
      }
      expect(read('app', 'public', 'brand', `selfbound-${kind}.svg`)).toContain('fill="currentColor"');
    }
  });

  it('only the two brand colours appear in the sources and generated SVGs', () => {
    const files = [
      ...['symbol', 'wordmark', 'lockup'].map((n) => read('brand', `${n}.svg`)),
      read('app', 'public', 'favicon.svg'),
      read('app', 'public', 'brand', 'selfbound-lockup-ink.svg'),
      read('app', 'public', 'brand', 'selfbound-lockup-paper.svg'),
    ];
    for (const svg of files) {
      const colors = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase());
      expect(colors.length).toBeGreaterThan(0);
      for (const c of colors) expect([INK, PAPER]).toContain(c);
    }
    expect(JSON.parse(read('app', 'public', 'site.webmanifest')).theme_color.toUpperCase()).toBe(INK);
  });

  it('the landing page and docs site get the same files', () => {
    for (const f of ['selfbound-lockup.svg', 'selfbound-symbol.svg']) expect(read('site', 'public', 'brand', f)).toBe(read('app', 'public', 'brand', f));
    expect(read('docs-site', 'src', 'assets', 'logo-light.svg')).toBe(read('app', 'public', 'brand', 'selfbound-lockup-ink.svg'));
    expect(read('docs-site', 'src', 'assets', 'logo-dark.svg')).toBe(read('app', 'public', 'brand', 'selfbound-lockup-paper.svg'));
    expect(read('site', 'public', 'favicon.svg')).toBe(read('app', 'public', 'favicon.svg'));
  });

  it('the header logo masks use the aspect ratio of the lockup', () => {
    for (const css of [read('app', 'src', 'welcome', 'welcome.css'), read('site', 'src', 'style.css')]) {
      expect(css).toContain(`aspect-ratio: ${BRAND.lockup.ratio} / 1`);
      expect(css).toContain('url(/brand/selfbound-lockup.svg)');
    }
  });

  it('the manifest names the product', () => {
    expect(JSON.parse(read('app', 'public', 'site.webmanifest')).name).toBe('Selfbound');
  });
});
