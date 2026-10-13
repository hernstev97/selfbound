// Subscribe and unsubscribe push on this device. Used by Settings › Notifications and at startup
// (renew the subscription after a new server key).
import { api } from '@xlr8/backend/api';
import type { App } from '@xlr8/core';
import { t } from '@xlr8/core/i18n';

export type PushSupport = 'ok' | 'unsupported' | 'insecure';

export function pushSupport(): PushSupport {
  if (!globalThis.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in globalThis) || !('Notification' in globalThis)) return 'unsupported';
  return 'ok';
}

/**
 * The service worker exists only for push and controls no page (scope /push/): a controlling SW
 * would slow down every start (app/sw/sw.js). Hence no `navigator.serviceWorker.ready`, which only
 * resolves for controlling registrations.
 */
export const SW_SCOPE = '/push/';

export function getRegistration() {
  return navigator.serviceWorker.getRegistration(SW_SCOPE);
}

/** Register the service worker or check for a new version; waits until it is active. */
export async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: SW_SCOPE, updateViaCache: 'none' });
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  await new Promise<void>((resolve) => {
    if (!worker) return resolve();
    worker.addEventListener('statechange', () => worker.state === 'activated' && resolve());
  });
  return reg;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function base64url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Display name of the device, e.g. "Android · Chrome · App". */
export function deviceName(ua = navigator.userAgent): string {
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : t('Device');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const installed = globalThis.matchMedia?.('(display-mode: standalone)').matches ? ' · App' : '';
  return `${os} · ${browser}${installed}`;
}

/** Register the subscription with the server (same endpoint = same device). */
async function register(app: App, sub: PushSubscription, publicKey: string) {
  await app.store.client.mutation(api.push.subscribe, {
    endpoint: sub.endpoint,
    p256dh: base64url(sub.getKey('p256dh')),
    auth: base64url(sub.getKey('auth')),
    device: deviceName(),
    vapidKey: publicKey,
  });
}

/** Turn on: ask for permission, subscribe with the push service, register with the server. */
export async function enablePush(app: App, publicKey: string): Promise<'on' | 'denied'> {
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && base64url(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(publicKey) });
  await register(app, sub, publicKey);
  return 'on';
}

/** Turn off on this device. */
export async function disablePush(app: App) {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await app.store.client.mutation(api.push.unsubscribe, { endpoint });
}

/**
 * At startup (idle): if the device is subscribed but the server no longer knows it (the push service
 * reported the subscription as expired) or has a new VAPID key, renew the subscription.
 */
export async function syncPush(app: App) {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (!sub) return;
  const config = await app.store.client.query(api.push.config, {});
  if (!config.publicKey) return;
  const known = config.devices.some((d) => d.endpoint === sub.endpoint);
  const sameKey = base64url(sub.options.applicationServerKey) === config.publicKey;
  if (known && sameKey) return;
  await sub.unsubscribe().catch(() => false);
  await enablePush(app, config.publicKey);
}
