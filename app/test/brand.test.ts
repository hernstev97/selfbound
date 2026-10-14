// Logo files, the inline paths in the app and the CSS masks all come from brand/logo.svg and brand/mark.svg.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/lib/brand.ts';

const repo = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8');
const pathsOf = (svg: string) => [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]);
const viewBoxOf = (svg: string) => svg.match(/viewBox="([^"]+)"/)![1];

describe('logo', () => {
  it('the generated files carry the shapes and view boxes of the sources', () => {
    for (const kind of ['mark', 'logo'] as const) {
      const source = read('brand', `${kind}.svg`);
      expect(BRAND[kind].paths).toEqual(pathsOf(source));
      expect(BRAND[kind].viewBox).toBe(viewBoxOf(source).trim().split(/[\s,]+/).map(Number).join(' '));
      for (const variant of ['', '-black', '-white']) {
        const svg = read('app', 'public', 'brand', `selfbound-${kind}${variant}.svg`);
        expect(pathsOf(svg)).toEqual(BRAND[kind].paths);
        expect(viewBoxOf(svg)).toBe(BRAND[kind].viewBox);
      }
      expect(read('app', 'public', 'brand', `selfbound-${kind}.svg`)).toContain('fill="currentColor"');
    }
  });

  it('the landing page and docs site get the same files', () => {
    expect(read('site', 'public', 'brand', 'selfbound-logo.svg')).toBe(read('app', 'public', 'brand', 'selfbound-logo.svg'));
    expect(read('site', 'public', 'brand', 'selfbound-mark.svg')).toBe(read('app', 'public', 'brand', 'selfbound-mark.svg'));
    expect(read('docs-site', 'src', 'assets', 'logo-light.svg')).toBe(read('app', 'public', 'brand', 'selfbound-logo-black.svg'));
    expect(read('docs-site', 'src', 'assets', 'logo-dark.svg')).toBe(read('app', 'public', 'brand', 'selfbound-logo-white.svg'));
    expect(read('site', 'public', 'favicon.svg')).toBe(read('app', 'public', 'favicon.svg'));
  });

  it('the header logo masks use the aspect ratio of the logo', () => {
    for (const css of [read('app', 'src', 'welcome', 'welcome.css'), read('site', 'src', 'style.css')]) {
      expect(css).toContain(`aspect-ratio: ${BRAND.logo.ratio} / 1`);
      expect(css).toContain('url(/brand/selfbound-logo.svg)');
    }
  });

  it('the manifest names the product', () => {
    expect(JSON.parse(read('app', 'public', 'site.webmanifest')).name).toBe('Selfbound');
  });
});
