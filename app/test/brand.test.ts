// Logo files and the inline paths in the app come from the same original.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/lib/brand.ts';

const brand = join(import.meta.dirname, '..', 'public', 'brand');
const read = (f: string) => readFileSync(join(brand, f), 'utf8');
const pathOf = (svg: string) => svg.match(/ d="([^"]+)"/)![1];

describe('logo', () => {
  it('the full logo is the original (only the color replaced)', () => {
    expect(pathOf(read('xlr8-logo.svg'))).toBe(pathOf(read('xlr8-logo-original.svg')));
  });

  it('mark and wordmark split the original path without remainder or overlap', () => {
    const whole = pathOf(read('xlr8-logo-original.svg'));
    const parts = [BRAND.mark.d, BRAND.word.d].flatMap((d) => d.split(/(?=M)/));
    const original = whole.split(/(?=M)/);
    expect(parts.sort()).toEqual([...original].sort());
  });

  it('app and files use the same shapes and view boxes', () => {
    for (const [kind, name] of [['mark', 'mark'], ['word', 'wordmark'], ['full', 'logo']] as const) {
      for (const variant of ['', '-black', '-white']) {
        const svg = read(`xlr8-${name}${variant}.svg`);
        expect(pathOf(svg)).toBe(kind === 'full' ? pathOf(read('xlr8-logo-original.svg')) : BRAND[kind].d);
        expect(svg).toContain(`viewBox="${BRAND[kind].viewBox}"`);
      }
      expect(read(`xlr8-${name}.svg`)).toContain('fill="currentColor"');
    }
  });

  it('the original sits unchanged in brand/', () => {
    expect(read('xlr8-logo-original.svg')).toMatch(/^<svg [^>]*viewBox="0 0 581\.89 138\.62"/);
  });
});
