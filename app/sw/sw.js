// @ts-check
/// <reference lib="webworker" />
// Selfbound service worker, for notifications only. The pwaFiles plugin (app/vite.plugins.ts) inserts
// the build id and emits the file as /sw.js; every build changes it.
//
// Registered with the scope /push/ (app/src/lib/pwa/push.ts), so it controls no page of the app:
// a controlling service worker made every startup 16–40 ms slower (measured), even without a fetch
// handler. Push and notification clicks need no control. Offline, the browser shows its own offline
// page; the open app shows "Offline".

/** Build id: changes the file on every build so the browser picks up the new version. */
const BUILD = '__SELFBOUND_BUILD__';
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

sw.addEventListener('install', () => void sw.skipWaiting());

/**
 * @typedef {{ title?: string, body?: string, url?: string, tag?: string, issueId?: string, at?: number, test?: boolean, lang?: string }} PushMessage
 */

sw.addEventListener('push', (event) => {
  /** @type {PushMessage} */
  let message = {};
  try {
    message = event.data?.json() ?? {};
  } catch {
    message = { body: event.data?.text() ?? '' };
  }
  event.waitUntil(
    (async () => {
      // Selfbound is in the foreground on this device: the app shows the message itself (toast and sound).
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const front = windows.find((c) => c.visibilityState === 'visible' && c.focused && isApp(c.url));
      if (front && !message.test) {
        front.postMessage({ type: 'xlr8-push', message });
        return;
      }
      await sw.registration.showNotification(message.title || 'Selfbound', {
        body: message.body ?? '',
        tag: message.tag || undefined,
        // @ts-ignore renotify is missing from the types: the same tag replaces the old notification but alerts again
        renotify: Boolean(message.tag),
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        // Language of the text, if the backend sends it (push texts follow XLR8_LOCALE).
        lang: message.lang || undefined,
        timestamp: message.at,
        data: { url: message.url || '/', issueId: message.issueId ?? null, at: message.at ?? Date.now() },
      });
    })(),
  );
});

/** App window (not the landing page or sign-in). @param {string} href */
function isApp(href) {
  const path = new URL(href).pathname;
  return path !== '/sign-in' && path !== '/welcome';
}

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', sw.location.origin);
  event.waitUntil(
    (async () => {
      // Prefer an open app window: the app navigates there itself (without reloading).
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = windows.find((c) => isApp(c.url));
      if (app) {
        await app.focus();
        app.postMessage({ type: 'xlr8-open', url: url.pathname + url.search });
        return;
      }
      await sw.clients.openWindow(url.href);
    })(),
  );
});
