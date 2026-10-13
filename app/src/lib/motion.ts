// Motion: the same values as the CSS tokens in styles/app.css (`--dur-…`, `--ease-…`), for
// animations from JS (Web Animations API). A test keeps both in sync (test/motion.test.ts).
// Ground rule: state and focus switch immediately; motion only runs alongside.

export const DUR = {
  /** Close, fade out */
  1: 90,
  /** Open menus, pickers, popovers; color changes */
  2: 140,
  /** Dialogs, peek, toasts, detail */
  3: 190,
  /** Slides: groups, column stages, landing */
  4: 250,
} as const;

export const EASE = {
  out: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  glide: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  /** Damped spring, about 4 % overshoot */
  spring: 'linear(0, 0.047, 0.16, 0.303, 0.452, 0.593, 0.715, 0.816, 0.894, 0.952, 0.992, 1.017, 1.032, 1.038, 1.038, 1.035, 1.03, 1.024, 1.019, 1.014, 1.009, 1.006, 1.003, 1.001, 1)',
} as const;

/** Offset per row for staggered fade-in, for the first 8 rows at most */
export const STAGGER = 12;

/** Reduced motion: only short fades (≤ 100 ms), no slides, no springs. */
export function reduced(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

const LAND_MS = 700;

/**
 * A row or card landed in a new place (status, priority, column changed): a short highlight, and
 * cards pop slightly. Only the opacity of a layer on top (`.landing::after`, app.css) and `scale`
 * are animated, which runs on the compositor. Animating background and border directly would
 * repaint every frame on the main thread, and the next key press would wait for it.
 */
export function land(el: HTMLElement, opts: { pop?: boolean } = {}) {
  const rm = reduced();
  // If the same element lands again, the new animation replaces the old one (the old one does not take the class with it).
  const prev = glows.get(el);
  if (prev) {
    running.delete(prev);
    prev.cancel();
  }
  el.classList.add('landing');
  const glow = el.animate([{ opacity: 1 }, { opacity: 1, offset: rm ? 0 : 0.3 }, { opacity: 0 }], { duration: rm ? DUR[1] : LAND_MS, easing: EASE.out, pseudoElement: '::after' });
  glows.set(el, glow);
  track(glow, () => {
    if (glows.get(el) !== glow) return;
    glows.delete(el);
    el.classList.remove('landing');
  });
  if (opts.pop && !rm) track(el.animate([{ scale: 0.96 }, { scale: 1 }], { duration: DUR[4], easing: EASE.spring }));
}

/**
 * Running decorative animations (landing). The next input cancels them: whoever keeps working has
 * seen them. Otherwise they would keep running (even on removed cards) and the browser would compute
 * every frame for up to 700 ms; in benchmarks that cost the next action about 9 ms.
 */
const running = new Map<Animation, (() => void) | undefined>();
const glows = new WeakMap<HTMLElement, Animation>();
function stopAll() {
  for (const [a, done] of running) {
    a.cancel();
    done?.();
  }
  running.clear();
}
let listening = false;
function track(a: Animation, done?: () => void) {
  running.set(a, done);
  const end = () => {
    running.delete(a);
    done?.();
  };
  a.finished.then(end, () => {});
  if (!listening && typeof addEventListener === 'function') {
    listening = true;
    addEventListener('keydown', stopAll, true);
    addEventListener('pointerdown', stopAll, true);
  }
}

/**
 * Inert copy of an element for a fade-out: without test ids, ids and labels, not interactive. The
 * real element is already gone by then (tests, focus, keyboard).
 */
export function stillCopy(el: Element): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
    for (const attr of ['data-testid', 'data-id', 'data-key', 'id', 'aria-label', 'title']) node.removeAttribute(attr);
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  return copy;
}

/**
 * Svelte transition for leaving (`out:leave`): a 90 ms fade without movement. The element loses its
 * test ids and focus at once; Svelte makes it `inert` meanwhile. So it is already gone for tests,
 * keyboard and clicks while it still fades out. If it opens again before it is gone, Svelte takes
 * the same element back and lifts `inert`: then the test ids come back too.
 */
export function leave(node: Element, opts: { duration?: number } = {}) {
  const marked = [node, ...node.querySelectorAll('[data-testid]')].filter((el) => el.hasAttribute('data-testid')).map((el) => [el, el.getAttribute('data-testid')!] as const);
  for (const [el] of marked) el.removeAttribute('data-testid');
  // The element gives up focus inside it (the picker's search field) at once, as on removal: the
  // next key is a shortcut again. If the app has already moved focus elsewhere, it stays there.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && node.contains(focused)) focused.blur();
  const back = new MutationObserver(() => {
    if ((node as HTMLElement).inert) return;
    back.disconnect();
    for (const [el, id] of marked) el.setAttribute('data-testid', id);
  });
  back.observe(node, { attributes: true, attributeFilter: ['inert'] });
  return { duration: opts.duration ?? DUR[1], easing: (t: number) => t, css: (t: number) => `opacity: ${t}` };
}
