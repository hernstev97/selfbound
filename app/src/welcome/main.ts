// Entry of the sign-in page (welcome.html). Separate from the app (index.html): no Svelte, no
// Convex, nothing from the start bundle. The Clerk form loads only here.

import './welcome.css';
import { publishableKey } from '../publishableKey.ts';
import { safeRedirect } from './session.ts';

type Theme = 'dark' | 'light';

const root = document.documentElement;
const clerkBox = document.querySelector<HTMLElement>('.clerk')!;

// --- Color scheme: as in the app (setting in selfbound:prefs), otherwise system ---

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const theme = (): Theme => (root.dataset.theme === 'light' ? 'light' : 'dark');
function prefTheme(): string {
  try {
    // legacy-xlr8: the old key is read until the app has moved it.
    return JSON.parse(localStorage.getItem('selfbound:prefs') ?? localStorage.getItem('xlr8:prefs') ?? '{}').theme ?? 'system';
  } catch {
    return 'system';
  }
}
systemDark.addEventListener('change', () => {
  if (prefTheme() !== 'system') return;
  root.dataset.theme = systemDark.matches ? 'dark' : 'light';
  signInHandle?.retheme();
});

// --- Sign-in ---

let signInHandle: { retheme(): void } | undefined;
async function startSignIn() {
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
  }
}

void startSignIn();
