// Starting without a network and chunks that cannot load. Sign-in runs through Clerk here as in
// production: the test build takes the key from localStorage (app-instance.ts); it points to a Clerk
// host that does not exist. Backend and Clerk are blocked in the test; the app itself (HTML and
// chunks) comes as if from the browser cache.
import { expect, test, type Page } from '@playwright/test';
import { BACKEND_PORT } from '../support/env.ts';
import { open } from '../support/helpers.ts';

/** Publishable key of a Clerk host that does not exist (`pk_test_` + base64 of "host$"). */
const FAKE_KEY = `pk_test_${Buffer.from('clerk.xlr8-offline.invalid$').toString('base64')}`;
const FAKE_HOST = /xlr8-offline\.invalid/;

/** Blocks the backend (requests and WebSocket) and Clerk: like no network, only the app files load. */
async function cutNetwork(page: Page) {
  await page.route(FAKE_HOST, (route) => route.abort('internetdisconnected'));
  await page.route(new RegExp(`127\\.0\\.0\\.1:${BACKEND_PORT}`), (route) => route.abort('internetdisconnected'));
  await page.routeWebSocket(new RegExp(`127\\.0\\.0\\.1:${BACKEND_PORT}`), (ws) => ws.close());
}

/** Until the cache (IndexedDB) holds buckets. */
async function mirrorWritten(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const names = (await indexedDB.databases()).map((d) => d.name!).filter((n) => n.startsWith('xlr8:'));
          let count = 0;
          for (const name of names) {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const r = indexedDB.open(name);
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            if (db.objectStoreNames.contains('buckets')) {
              count += await new Promise<number>((resolve) => {
                const r = db.transaction('buckets').objectStore('buckets').count();
                r.onsuccess = () => resolve(r.result);
              });
            }
            db.close();
          }
          return count;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
}

async function asClerk(page: Page, signedInBefore: boolean) {
  await page.evaluate((key) => localStorage.setItem('xlr8:testClerk', key), FAKE_KEY);
  const url = new URL(page.url());
  if (signedInBefore) await page.context().addCookies([{ name: 'xlr8_signed_in', value: '1', domain: url.hostname, path: '/' }]);
  else await page.context().clearCookies({ name: 'xlr8_signed_in' });
}

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  await page.evaluate(() => localStorage.removeItem('xlr8:testClerk')).catch(() => undefined);
  await page.context().clearCookies({ name: 'xlr8_signed_in' });
});

test('Signed in last time, no network: list from the cache, "Offline" notice', async ({ page }) => {
  await open(page, '/all?group=none&order=created');
  const titles = await page.locator('[data-testid="issue-row"] [data-testid="row-title"]').allTextContents();
  await mirrorWritten(page);
  await asClerk(page, true);
  await cutNetwork(page);
  await page.reload();
  // The list from this device right away, not just the logo.
  await expect(page.locator('[data-testid="issue-row"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="issue-row"] [data-testid="row-title"]').first()).toHaveText(titles[0]);
  await expect(page.getByTestId('sync-state')).toHaveText('Offline', { timeout: 6000 });
  // Clerk stays unreachable: one notice explaining what applies.
  await expect(page.getByTestId('toast').filter({ hasText: 'last saved state on this device' })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __xlr8: { app: { auth: { status: { get(): string } } } } }).__xlr8.app.auth.status.get())).toBe('cached');
  // Editing without a confirmed sign-in: a notice at once, nothing is saved only seemingly.
  const id = await page.locator('[data-testid="issue-row"]').first().getAttribute('data-id');
  const before = await page.locator('[data-testid="issue-row"]').first().getAttribute('data-priority');
  await page.evaluate((issue) => (window as unknown as { __xlr8: { app: { edit: { patch(ids: string[], p: object): void } } } }).__xlr8.app.edit.patch([issue!], { priority: 4 }), id);
  await expect(page.getByText('Offline: you can make changes again', { exact: false })).toBeVisible();
  await expect(page.locator('[data-testid="issue-row"]').first()).toHaveAttribute('data-priority', before!);
});

test('Never signed in, no network: "No connection" with "Try again"', async ({ page }) => {
  await open(page, '/all');
  await asClerk(page, false);
  await cutNetwork(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No connection' })).toBeVisible({ timeout: 10_000 });
  const retry = page.getByTestId('offline-retry');
  await retry.click();
  // New attempt, Clerk stays unreachable: the notice again instead of an empty logo.
  await expect(page.getByRole('heading', { name: 'No connection' })).toBeVisible({ timeout: 10_000 });
  await expect(retry).toBeEnabled();
});

test('A chunk that cannot load offline: notice instead of an empty page; back online it loads by itself', async ({ page, context }) => {
  await open(page, '/all');
  // The projects page is its own chunk, not loaded at startup.
  await context.setOffline(true);
  await page.evaluate(() => (window as unknown as { __xlr8: { app: { nav: { go(p: object): void } } } }).__xlr8.app.nav.go({ name: 'projects', team: 'ORB' }));
  await expect(page.getByTestId('load-failed')).toBeVisible();
  await expect(page.getByTestId('load-failed')).toContainText('Offline: this part is not loaded');
  await context.setOffline(false);
  await expect(page.getByTestId('load-failed')).toHaveCount(0);
  await expect(page.getByTestId('projects-page')).toBeVisible();
});
