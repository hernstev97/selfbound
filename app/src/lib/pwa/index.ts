// Installable app and notifications, the part that runs after startup.
// main.ts loads this module idle after the first list, so it costs startup nothing.
//
//   - register the service worker (app/sw/sw.js, push only, controls no page): show notifications, tap opens the issue
//   - detect a new version after a deploy and reload (version.json)
//   - report presence: while XLR8 is visible and in use here, no pushes go out; the app shows the
//     notifications itself as a toast with a sound
//   - read issues: close their notifications on this device
import { api } from '@xlr8/backend/api';
import type { Id } from '@xlr8/backend/dataModel';
import type { App, IssueId } from '@xlr8/core';
import { t, tc } from '@xlr8/core/i18n';
import { getRegistration, registration, syncPush } from './push.ts';

/** After this long without input, XLR8 counts as "open but not in use". */
const IDLE_MS = 3 * 60_000;
const HEARTBEAT_MS = 60_000;
/** Check for a new version at most this often (when returning to the app). */
const VERSION_CHECK_MS = 10 * 60_000;
const DEVICE_KEY = 'xlr8:device';

export const BUILD: string = typeof __XLR8_BUILD__ === 'string' ? __XLR8_BUILD__ : 'dev';

interface PushMessage {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

export function startPwa(app: App, opts: { serviceWorker: boolean }) {
  if (opts.serviceWorker && 'serviceWorker' in navigator) {
    void registration().catch(() => undefined);
    // Remove an earlier registration with scope "/": it would slow down every start.
    void navigator.serviceWorker.getRegistration('/').then((old) => old?.scope === `${location.origin}/` && old.unregister());
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string; message?: PushMessage } | null;
      if (data?.type === 'xlr8-open' && data.url) app.nav.open(data.url);
      if (data?.type === 'xlr8-push' && data.message) showInApp(app, data.message);
    });
  }
  startPresence(app);
  watchInApp(app);
  watchVersion(app);
  closeReadNotifications(app);
  void syncPush(app).catch(() => undefined);
}

// ---------------------------------------------------------------- Notifications in the app

function showInApp(app: App, message: PushMessage) {
  const url = message.url;
  app.toasts.show(message.title ?? 'XLR8', url ? { label: tc('verb', 'Open'), run: () => app.nav.open(url) } : undefined, 'info', message.body, 8000);
  app.cues.emit('notification');
}

/** Notifications the server sends into the app instead of a push (XLR8 was active on a device). */
function watchInApp(app: App) {
  const since = Date.now();
  const seen = new Set<string>();
  const watch = app.store.watch(api.push.recent, { since });
  watch.slice.subscribe(() => {
    const shown: Id<'pushEvents'>[] = [];
    for (const item of watch.slice.get() ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      // Only a visible window shows the toast and confirms it. If none confirms (window just closed),
      // the server sends a push after 45 s after all.
      if (document.visibilityState !== 'visible') continue;
      showInApp(app, item);
      shown.push(item.id);
    }
    if (shown.length) app.store.client.mutation(api.push.seen, { ids: shown }).catch(() => undefined);
  });
}

// ---------------------------------------------------------------- Presence

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function startPresence(app: App) {
  const device = deviceId();
  let lastInput = Date.now();
  let sent: boolean | null = null;
  const visible = () => document.visibilityState === 'visible';
  const send = (active: boolean) => {
    sent = active;
    app.store.client.mutation(api.push.presence, { device, active }).catch(() => (sent = null));
  };
  const tick = () => {
    const active = visible() && Date.now() - lastInput < IDLE_MS;
    if (active || sent !== false) send(active);
  };
  const onInput = () => {
    lastInput = Date.now();
    if (sent !== true && visible()) send(true);
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) addEventListener(type, onInput, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (visible()) onInput();
    else if (sent !== false) send(false);
  });
  addEventListener('pagehide', () => send(false));
  setInterval(tick, HEARTBEAT_MS);
  tick();
}

// ---------------------------------------------------------------- New version

/** Nothing unsaved open: no dialog, no focus in an input, no pending changes. */
function safeToReload(app: App) {
  const el = document.activeElement as HTMLElement | null;
  const typing = !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  return !typing && !app.create.state.get().open && !document.querySelector('[role="dialog"]') && app.store.sync.get().pending === 0;
}

function watchVersion(app: App) {
  if (BUILD === 'dev') return;
  let lastCheck = Date.now();
  let offered = false;
  const check = async () => {
    lastCheck = Date.now();
    const res = await fetch('/version.json', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const { build } = (await res.json().catch(() => ({}))) as { build?: string };
    if (!build || build === BUILD) return;
    if (safeToReload(app)) {
      location.reload();
    } else if (!offered) {
      offered = true;
      app.toasts.show(t('New version of XLR8'), { label: t('Reload'), run: () => location.reload() }, 'info', undefined, 60_000);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > VERSION_CHECK_MS) void check();
  });
}

// ---------------------------------------------------------------- Close read notifications

function closeReadNotifications(app: App) {
  if (!('serviceWorker' in navigator)) return;
  const run = async () => {
    const reg = await getRegistration();
    if (!reg) return;
    const open = app.nav.page.get();
    for (const n of await reg.getNotifications()) {
      const data = n.data as { issueId?: string | null; at?: number } | null;
      if (!data?.issueId) continue;
      const issue = app.store.get(data.issueId as IssueId);
      const at = data.at ?? 0;
      const opened = open.name === 'issue' && issue?.key === open.key;
      if (issue && (opened || (issue.readAt ?? 0) >= at || (issue.reviewedAt ?? 0) >= at || issue.deletedAt !== undefined)) n.close();
    }
  };
  const later = () => void run().catch(() => undefined);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') later();
  });
  app.nav.page.subscribe(later);
  later();
}
