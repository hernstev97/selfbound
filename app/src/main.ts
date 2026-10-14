import './styles/fonts.css';
import './styles/app.css';
import { mount } from 'svelte';
import { isConsentPath, rowIconCss } from '@selfbound/core';
import { loadFuzzy } from '@selfbound/core/search';
import Root from './Root.svelte';
import { app, auth, client, convexUrl } from './app-instance.ts';
import { loadMarkdown, markdownReady, renderMarkdown, setLinkKeys } from './lib/markdown.ts';
import { pages, preloadPages } from './lib/pages.ts';
import { t } from '@selfbound/core/i18n';

// Mask icons of the list rows (status, priority …) from the same shapes as the SVG icons.
const icons = document.createElement('style');
icons.textContent = rowIconCss();
document.head.append(icons);

// Share from another app (/share?title=…&text=…): remember the values and set the address to the
// inbox before navigation reads it. lib/pwa/share.ts creates the issue after startup.
const shareHref = location.pathname === '/share' ? location.href : null;
if (shareHref) history.replaceState(history.state, '', '/inbox');

// After a deploy the chunks of the old version are gone (the host replaces assets/).
// If loading a chunk fails, reload once instead of showing an error.
addEventListener('vite:preloadError', (event) => {
  // Only when connected and with no pending changes: offline the browser would show its error page,
  // and reloading would discard what has not been sent yet. In that case the part reports the error
  // itself and offers "Try again" (components/Lazy.svelte).
  const sync = app.store.sync.get();
  if (!navigator.onLine || !sync.connected || sync.pending > 0) return;
  try {
    if (Date.now() - Number(sessionStorage.getItem('xlr8:reloadedAt') ?? 0) < 30_000) return;
    sessionStorage.setItem('xlr8:reloadedAt', String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

// The UI language is already active here (lib/locale-ready.ts, imported by app-instance.ts).
boot();

function boot() {
  mount(Root, { target: document.getElementById('app')! });

  // Consent page for connectors (isConsentPath): sign-in only, no data, no navigation
  // (that would rewrite the address to the last visited view).
  const consent = isConsentPath(location.pathname);

  // Startup order: shell → data (meta, counts, packs) → first list. Everything else (overlays,
  // uFuzzy, detail page, Markdown, sprint header) comes afterwards, so on a cold start it shares
  // neither the network nor the main thread with the packs. The first input (key, click) loads the
  // overlays at once.
  //
  // UI sounds follow the same pattern: the audio library is its own chunk that only `loadSound`
  // fetches (idle after startup, at the latest on the first input) and only if sounds are on. The
  // first gesture creates the AudioContext.
  let soundLoading: Promise<void> | null = null;
  function loadSound() {
    if (consent || soundLoading || !app.prefs.state.get().sound) return soundLoading;
    return (soundLoading = import('./lib/sound/index.ts').then(({ startSound }) => void startSound(app)));
  }
  // Sounds turned on later although off at startup: load now, then the switch-on plays (swoosh).
  // If the chunk is already loaded, `startSound` announces the switch-on itself.
  let soundWas = app.prefs.state.get().sound;
  app.prefs.state.subscribe(() => {
    const on = app.prefs.state.get().sound;
    const turnedOn = on && !soundWas;
    soundWas = on;
    if (!turnedOn || soundLoading) return;
    void loadSound()?.then(() => app.cues.emit('swoosh'));
  });

  // Installable app, push, version check: its own chunk, idle after the first list.
  // No service worker in the Vite dev server (there is no /sw.js there) or with ?sw=0.
  let pwaLoading = false;
  function loadPwa() {
    if (consent || !convexUrl || pwaLoading) return;
    pwaLoading = true;
    const serviceWorker = !import.meta.env.DEV && new URL(location.href).searchParams.get('sw') !== '0';
    void import('./lib/pwa/index.ts').then(({ startPwa }) => startPwa(app, { serviceWorker }));
  }

  // Appearance: a separate chunk syncs themes and fonts with the server. index.html has already applied
  // the CSS from the last run; this only adds what is new (another device, a new build).
  function loadLook() {
    if (consent || !convexUrl) return;
    void import('./lib/look/start.ts').then(({ startLook }) => startLook(app));
  }

  let later = false;
  function loadLater() {
    if (later) return;
    later = true;
    void pages.overlays();
    const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
    idle(() => {
      void loadFuzzy();
      preloadPages();
      void loadMarkdown();
      loadSound();
      loadPwa();
      loadLook();
    });
  }
  const onFirstInput = () => {
    if (consent) return;
    loadSound();
    // Unsubscribe only once the overlays are loaded: if loading fails (no network), the next input tries again.
    void pages.overlays().then(
      () => {
        removeEventListener('keydown', onFirstInput, true);
        removeEventListener('pointerdown', onFirstInput, true);
      },
      () => {},
    );
  };
  addEventListener('keydown', onFirstInput, true);
  addEventListener('pointerdown', onFirstInput, true);

  if (convexUrl) {
    // Sign in first, then subscribe to data (the server refuses otherwise).
    let started = false;
    auth.status.subscribe(() => {
      const status = auth.status.get();
      // Signed out: to the sign-in page (welcome.html), then back to this address.
      if (status === 'signed-out' && auth.kind === 'clerk' && !auth.leaving) auth.signIn({ replace: true });
      // `cached`: signed in last time, Clerk still loading or offline; the list comes from the cache.
      if ((status === 'signed-in' || status === 'cached') && !started) {
        started = true;
        if (consent) return;
        app.start();
        if (shareHref) void import('./lib/pwa/share.ts').then(({ readShare, handleShare }) => {
          const shared = readShare(new URL(shareHref));
          if (shared) void handleShare(app, shared);
        });
        const check = () => {
          const phase = app.store.sync.get().phase;
          if (phase === 'live') {
            stop();
            loadLater();
          }
        };
        const stop = app.store.sync.subscribe(check);
        check();
        // Load anyway after 3 s at the latest (e.g. a slow connection).
        setTimeout(loadLater, 3000);
      }
    });
    // Sign-in unreachable while the app runs from the cache: say once what that means.
    auth.unreachable.subscribe(() => {
      if (!auth.unreachable.get() || auth.status.get() !== 'cached' || consent) return;
      app.toasts.show(t('Offline'), undefined, 'info', t('You are seeing the last saved state on this device. Editing works again once Selfbound is connected.'), 10_000);
    });
    void auth.start(client);
  } else if (!consent) {
    loadLater();
  }

  // Identifiers like "ACME-106" in text become links, but only with the keys of real teams.
  app.store.meta.subscribe(() => setLinkKeys(app.store.meta.get()?.teams.map((team) => team.key) ?? []));

  // Preloaded details (focus on a row): render the description while idle, so space and Enter show it
  // without marked/DOMPurify (the result sits in markdown.ts's cache).
  app.store.onDetail((doc) => {
    const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 50));
    idle(() => {
      if (!markdownReady()) return;
      const text = doc.body.markdown;
      if (!text.trim()) return;
      renderMarkdown(text);
      if (text.length > 1200) renderMarkdown(text.slice(0, 1200));
    });
  });

  // Deep link straight to an issue: load the detail at once, not when idle.
  if (location.pathname.startsWith('/issue/')) void pages.issue();
}
