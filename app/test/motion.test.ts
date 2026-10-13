// Motion tokens in CSS (app.css) and JS (lib/motion.ts) stay the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUR, EASE } from '../src/lib/motion.ts';

const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

describe('motion tokens', () => {
  it('durations', () => {
    for (const step of [1, 2, 3, 4] as const) expect(token(`dur-${step}`)).toBe(`${DUR[step]}ms`);
  });
  it('easing curves', () => {
    expect(token('ease')).toBe(EASE.out);
    expect(token('ease-in')).toBe(EASE.in);
    expect(token('ease-glide')).toBe(EASE.glide);
    expect(token('ease-spring')).toBe(EASE.spring);
  });
});
