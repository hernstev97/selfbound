// Landing page script: the background motion and the demo video. The content is HTML in index.html and
// reads without this script; the screenshot in the hero stays the poster of the video.

import './style.css';
import demoDark from './assets/demo-dark.mp4';
import demoLight from './assets/demo-light.mp4';
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

// Demo video over the hero screenshot. It loads after the page has loaded, follows the color scheme, plays
// only while it is on screen and not at all with reduced motion; the button pauses and resumes it.
const stage = document.querySelector<HTMLElement>('.shot .stage');
const toggle = document.querySelector<HTMLButtonElement>('.shot .demo-toggle');
const calm = matchMedia('(prefers-reduced-motion: reduce)');
if (stage && toggle) {
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'none';
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  const still = stage.querySelector('img')!;
  let wanted = !calm.matches;
  let visible = false;
  const sync = () => {
    toggle.textContent = wanted ? 'Pause demo' : 'Play demo';
    toggle.setAttribute('aria-pressed', String(!wanted));
    if (wanted && visible) void video.play().catch(() => {});
    else video.pause();
  };
  const source = () => (dark.matches ? demoDark : demoLight);
  const load = () => {
    video.poster = still.currentSrc;
    video.src = source();
    stage.append(video);
    toggle.hidden = false;
    new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      sync();
    }).observe(stage);
    dark.addEventListener('change', () => {
      const at = video.currentTime;
      video.poster = still.currentSrc;
      video.src = source();
      video.currentTime = at;
      sync();
    });
  };
  toggle.addEventListener('click', () => {
    wanted = !wanted;
    sync();
  });
  // Calm users get the poster; the first click on the button loads and plays the video.
  const start = () => (document.readyState === 'complete' ? idle(load, { timeout: 2000 }) : addEventListener('load', () => idle(load, { timeout: 2000 }), { once: true }));
  start();
}
