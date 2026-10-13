// Entry of the start page and sign-in (welcome.html). Separate from the app (index.html): no
// Svelte, no Convex, nothing from the start bundle. The content is HTML in welcome.html and readable
// without this script; this only adds motion and sign-in.

import './welcome.css';
import { loadStar, mountRaster, type Place, type Raster } from './raster.ts';
import { publishableKey } from '../publishableKey.ts';
import { safeRedirect } from './session.ts';

type Theme = 'dark' | 'light';
type View = 'landing' | 'sign-in';

const root = document.documentElement;
const landing = document.querySelector<HTMLElement>('main.landing')!;
const signIn = document.querySelector<HTMLElement>('main.sign-in')!;
const hero = landing.querySelector<HTMLElement>('.hero')!;
const skip = document.querySelector<HTMLAnchorElement>('.skip')!;
const clerkBox = signIn.querySelector<HTMLElement>('.clerk')!;

// --- Color scheme: as in the app (setting in xlr8:prefs), otherwise system ---

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const theme = (): Theme => (root.dataset.theme === 'light' ? 'light' : 'dark');
function prefTheme(): string {
  try {
    return JSON.parse(localStorage.getItem('xlr8:prefs') ?? '{}').theme ?? 'system';
  } catch {
    return 'system';
  }
}
systemDark.addEventListener('change', () => {
  if (prefTheme() !== 'system') return;
  root.dataset.theme = systemDark.matches ? 'dark' : 'light';
  raster?.refresh();
  signInHandle?.retheme();
});

// --- View: start page or sign-in (same page, /sign-in) ---

const viewOf = (path: string): View => (/^\/sign-in\/?$/.test(path) ? 'sign-in' : 'landing');
let view: View = viewOf(location.pathname);

const PLACES: Record<View, Place> = {
  // Star centered behind the headline, dimmed so the text stays readable
  landing: (w) => (w > 820 ? { x: w / 2, y: Math.min(innerHeight * 0.36, 330), r: Math.min(w * 0.3, 330), k: 0.5 } : { x: w / 2, y: 250, r: w * 0.5, k: 0.42 }),
  // Large star behind the sign-in form
  'sign-in': (w, h) => ({ x: w / 2, y: h / 2, r: Math.min(w * 0.42, h * 0.4), k: 0.45 }),
};

function show(next: View, focus: boolean) {
  view = next;
  root.dataset.view = next;
  landing.hidden = next !== 'landing';
  signIn.hidden = next !== 'sign-in';
  skip.href = next === 'landing' ? '#main' : '#sign-in';
  fxWrap.remove();
  (next === 'landing' ? hero : signIn).prepend(fxWrap);
  raster?.setPlace(PLACES[next]);
  if (next === 'sign-in') void startSignIn();
  if (focus) (next === 'sign-in' ? signIn : landing).focus({ preventScroll: false });
  if (next === 'sign-in') scrollTo(0, 0);
}

landing.tabIndex = -1;
signIn.tabIndex = -1;
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-sign-in], a[href="/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const next = a.hasAttribute('data-sign-in') ? 'sign-in' : 'landing';
  e.preventDefault();
  if (next === view) return;
  history.pushState(null, '', next === 'sign-in' ? '/sign-in' : '/');
  show(next, true);
});
addEventListener('popstate', () => show(viewOf(location.pathname), true));

// Load Clerk when hovering "Sign in", not only on click.
const warm = (e: Event) => {
  if (!publishableKey || !(e.target as Element).closest?.('a[data-sign-in]')) return;
  void import('./signin.ts').then((m) => m.preloadClerk());
};
document.addEventListener('pointerover', warm, { passive: true });
document.addEventListener('focusin', warm);

// --- Sign-in ---

let signInHandle: { retheme(): void } | undefined;
let signInStarted = false;
async function startSignIn() {
  if (signInStarted) return;
  signInStarted = true;
  const note = clerkBox.querySelector<HTMLElement>('.clerk-note')!;
  if (!publishableKey) {
    // Locally (test sign-in) there is no Clerk: go straight to the app.
    clerkBox.dataset.state = 'error';
    clerkBox.removeAttribute('aria-busy');
    note.innerHTML = 'Sign-in is not set up here. Locally you are signed in already: <a href="/">open the app</a>.';
    note.querySelector('a')!.addEventListener('click', (e) => {
      e.preventDefault();
      location.assign(safeRedirect(new URLSearchParams(location.search).get('redirect_url'), location.origin));
    });
    return;
  }
  try {
    const { mountSignIn } = await import('./signin.ts');
    const redirect = safeRedirect(new URLSearchParams(location.search).get('redirect_url'), location.origin);
    clerkBox.dataset.state = 'mounting';
    note.remove();
    signInHandle = await mountSignIn(clerkBox, { publishableKey, redirect, theme });
    clerkBox.dataset.state = 'ready';
    clerkBox.removeAttribute('aria-busy');
  } catch (error) {
    console.error(error);
    clerkBox.dataset.state = 'error';
    clerkBox.removeAttribute('aria-busy');
    clerkBox.replaceChildren(note);
    note.textContent = 'Sign-in could not be loaded. Please reload the page.';
    signInStarted = false;
  }
}

// --- Background ---

// The placeholder is already in the HTML (dot pattern via CSS); the canvas goes on top.
const fxWrap = document.querySelector<HTMLElement>('.fx-wrap')!;
const canvas = document.createElement('canvas');
fxWrap.append(canvas);
let raster: Raster | undefined;

show(view, false);
// Motion only after the first paint, so text and button come first. After 1 s at the latest:
// without a deadline a busy browser can postpone idle time indefinitely.
const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 50));
requestAnimationFrame(() =>
  idle(
    () => {
      raster = mountRaster(canvas, { place: PLACES[view], theme, star: loadStar('/brand/xlr8-mark.svg') });
    },
    { timeout: 1000 },
  ),
);
