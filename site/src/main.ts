// Landing page script: only the background motion. The content is HTML in index.html and reads
// without this script.

import './style.css';
import { loadStar, mountRaster, type Place } from './raster.ts';

const hero = document.querySelector<HTMLElement>('.hero')!;
const fxWrap = hero.querySelector<HTMLElement>('.fx-wrap')!;
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => (dark.matches ? 'dark' : 'light');

// Star centered behind the headline, dimmed so the text stays readable
const place: Place = (w) => (w > 820 ? { x: w / 2, y: Math.min(innerHeight * 0.36, 330), r: Math.min(w * 0.3, 330), k: 0.5 } : { x: w / 2, y: 250, r: w * 0.5, k: 0.42 });

// The dot pattern from CSS is already there; the canvas goes on top after the first paint, so text and
// buttons come first. After 1 s at the latest: a busy browser can postpone idle time indefinitely.
const canvas = document.createElement('canvas');
fxWrap.append(canvas);
const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 50));
requestAnimationFrame(() =>
  idle(
    () => {
      const raster = mountRaster(canvas, { place, theme, star: loadStar('/brand/selfbound-symbol.svg') });
      dark.addEventListener('change', () => raster.refresh());
    },
    { timeout: 1000 },
  ),
);
