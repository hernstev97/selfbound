// Browser state written under the old product name moves to the new names on the first start.
// legacy-xlr8: this whole spec writes the old names on purpose; it goes away with the fallbacks.
import { expect, test } from '@playwright/test';
import { open } from '../support/helpers.ts';

test('old storage keys are moved, old cache databases are deleted', async ({ page }) => {
  // Seed the old names before the app's first script runs, once (a reload must not seed again).
  await page.addInitScript(() => {
    if (localStorage.getItem('legacy-seeded')) return;
    localStorage.setItem('legacy-seeded', '1');
    localStorage.setItem('xlr8:prefs', JSON.stringify({ locale: 'de' }));
    localStorage.setItem('xlr8:recent', '["a"]');
    sessionStorage.setItem('xlr8:reloadedAt', '1');
    // An open connection would block the deletion, as it would for a second tab of the old build.
    const request = indexedDB.open('xlr8:http://127.0.0.1:1', 1);
    request.onsuccess = () => request.result.close();
  });
  await page.goto('/inbox');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.waitForFunction(() => (window as unknown as { __selfbound?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__selfbound?.app?.store.sync.get().phase === 'live');
  const state = await page.evaluate(() => ({
    prefs: JSON.parse(localStorage.getItem('selfbound:prefs') ?? '{}').locale,
    recent: localStorage.getItem('selfbound:recent'),
    reloadedAt: sessionStorage.getItem('selfbound:reloadedAt'),
    old: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('xlr8:')),
  }));
  expect(state).toEqual({ prefs: 'de', recent: '["a"]', reloadedAt: '1', old: [] });
  // The cache of the old name is dropped once the app is idle.
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('xlr8:'))), { timeout: 15_000 })
    .toEqual([]);
});
