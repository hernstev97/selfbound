// Installable app and notifications: manifest, service worker (push only), "Offline" on phones,
// sharing into the inbox, tapping a notification, notifications in the open app, settings, a new
// version after a deploy. Real push (the browser's push service) is not available in tests; the
// backend tests (backend/test/push.test.ts) cover it.
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { OWNER_KIND } from '../../backend/convex/shared/constants.ts';
import { BACKEND_PORT } from '../support/env.ts';
import { agentCall, api, backend, open, resolve } from '../support/helpers.ts';

test.use({ serviceWorkers: 'allow' });

async function issueDoc(id: string) {
  for (let bucket = 0; ; bucket++) {
    const docs = await backend().query(api.issues.bucket, { bucket });
    const hit = docs.find((d) => d._id === id);
    if (hit || docs.length === 0) return hit;
  }
}

/** Waits until the service worker (scope /push/) is active; it is registered when idle after startup. */
async function registered(page: Page) {
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/push/'))?.active?.state === 'activated', null, { timeout: 20_000 });
}

test('Manifest, installable, service worker only for push (controls no page), status bar in light and dark', async ({ page, context }) => {
  await open(page, '/inbox');
  await registered(page);
  const cdp = await context.newCDPSession(page);
  expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  const parsed = JSON.parse(manifest.data!);
  expect(parsed).toMatchObject({ id: '/', start_url: '/', display: 'standalone', share_target: { action: '/share', method: 'GET' } });
  expect(parsed.shortcuts.map((s: { url: string }) => s.url)).toEqual(['/inbox', '/new']);
  // Controls no page: a controlling service worker made every startup slower.
  await page.reload();
  await expect(page.locator('[data-testid="issue-row"]').first()).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname))).toEqual(['/push/']);
  // The status bar follows the color scheme
  const bar = () => page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content);
  expect(await bar()).toBe('#0f0f10');
  await page.goto('/settings/appearance');
  await page.getByTestId('theme-switch').getByRole('button', { name: 'Light' }).click();
  expect(await bar()).toBe('#fcfcfd');
  await page.getByTestId('theme-switch').getByRole('button', { name: 'System' }).click();
});

test('Phone: without a connection "Offline" shows, then it disappears', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let offline = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(new RegExp(`127\\.0\\.0\\.1:${BACKEND_PORT}`), (ws) => {
    if (offline) return void ws.close();
    ws.connectToServer();
    sockets.add(ws);
  });
  await open(page, '/inbox');
  await expect(page.getByTestId('mobile-sync-state')).toHaveCount(0);
  offline = true;
  for (const ws of sockets) await ws.close();
  await expect(page.getByTestId('mobile-sync-state')).toContainText('Offline', { timeout: 15_000 });
  await expect(page.getByTestId('mobile-sync-state')).toBeVisible();
  offline = false;
  await expect(page.getByTestId('mobile-sync-state')).toHaveCount(0, { timeout: 20_000 });
});

test('Sharing from another app creates exactly one issue in the inbox', async ({ page }) => {
  const text = `Worth reading ${Date.now()} https://example.com/article`;
  const shareUrl = `/share?title=&text=${encodeURIComponent(text)}`;
  await page.goto(shareUrl);
  const toast = page.getByTestId('toast').filter({ hasText: 'added to the inbox' });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/inbox$/);
  const key = (await toast.textContent())!.match(/[A-Z]+-\d+/)![0];
  const issue = await issueDoc((await resolve(key))!.id);
  expect(issue).toMatchObject({ title: text.replace(' https://example.com/article', ''), status: 'triage', createdBy: { kind: OWNER_KIND } });
  expect((await backend().query(api.inbox.list, {})).filter((e) => e.issueId === issue!._id)).toHaveLength(1);
  await expect(page.locator(`[data-testid="issue-row"][data-key="${key}"]`)).toBeVisible();
  // Triggered twice (e.g. shared twice): no second issue
  await page.goto(shareUrl);
  await expect(page.getByTestId('toast').filter({ hasText: `${key} added to the inbox` })).toBeVisible({ timeout: 15_000 });
  // Undo removes it again
  await page.getByTestId('toast').filter({ hasText: key }).getByTestId('toast-action').click();
  await expect(page.locator(`[data-testid="issue-row"][data-key="${key}"]`)).toHaveCount(0);
});

test('Tapping a notification opens the issue in the open window', async ({ page, context }) => {
  await open(page, '/inbox');
  await registered(page);
  const key = (await page.getByTestId('issue-row').first().getAttribute('data-key'))!;
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // This is how the service worker passes the tap to the window (notificationclick in app/sw/sw.js).
  await worker.evaluate(async (url) => {
    const sw = self as unknown as { clients: { matchAll(o: object): Promise<{ postMessage(m: unknown): void }[]> } };
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'xlr8-open', url });
  }, `/issue/${key}`);
  await expect(page).toHaveURL(new RegExp(`/issue/${key}$`));
  await expect(page.getByTestId('detail-key')).toHaveText(key);
  // Back leads to the previous page
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox$/);
});

test('XLR8 is open: an agent notification shows as a toast in the app, "Open" shows the issue', async ({ page }) => {
  await open(page, '/inbox');
  await registered(page);
  // The PWA chunk (with presence) is loaded once the service worker is registered.
  const title = `From the agent ${Date.now()}`;
  const teams = (await backend().query(api.meta.get, {})).teams;
  await agentCall('create_issues', { requestId: `pwa-${Date.now()}`, issues: [{ team: teams[0].key, title }] });
  const toast = page.getByTestId('toast').filter({ hasText: 'New issue' });
  await expect(toast).toBeVisible({ timeout: 25_000 });
  await expect(toast).toContainText(title);
  await toast.getByTestId('toast-action').click();
  await expect(page).toHaveURL(/\/issue\/[A-Z]+-\d+$/);
  await expect(page.getByTestId('detail-title')).toHaveValue(title);
});

test('Settings › Notifications: toggle events, list and remove devices', async ({ page }) => {
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  // The test backend has no VAPID key: notice instead of a switch
  await expect(page.getByTestId('push-status')).toContainText('Not set up on the server');
  const events = page.getByTestId('push-event');
  await expect(events).toHaveCount(7);
  const linked = events.filter({ hasText: 'PR linked' });
  await expect(linked.getByRole('button', { name: 'Off' })).toHaveClass(/on/);
  await linked.getByRole('button', { name: 'On' }).click();
  await expect(linked.getByRole('button', { name: 'On' })).toHaveClass(/on/);
  expect((await backend().query(api.push.config, {})).events.pr_linked).toBe(true);
  await linked.getByRole('button', { name: 'Off' }).click();
  await expect(linked.getByRole('button', { name: 'Off' })).toHaveClass(/on/);
  // Another device (subscribed via the server here) shows in the list and can be removed.
  await backend().mutation(api.push.subscribe, { endpoint: 'https://push.example/e2e-phone', p256dh: 'x', auth: 'y', device: 'Android · Chrome · App', vapidKey: 'z' });
  const device = page.getByTestId('push-device-row').filter({ hasText: 'Android · Chrome · App' });
  await expect(device).toBeVisible();
  await device.getByRole('button', { name: 'Remove' }).click();
  await expect(device).toHaveCount(0);
});

test('New version after a deploy: returning to the app reloads it', async ({ page }) => {
  await page.clock.install();
  await open(page, '/inbox');
  await registered(page);
  let served = 0;
  await page.route('**/version.json', (route) => {
    served++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ build: 'new-build' }) });
  });
  await page.clock.fastForward('11:00');
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await reloaded;
  expect(served).toBe(1);
});
