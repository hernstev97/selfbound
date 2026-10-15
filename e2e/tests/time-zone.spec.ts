// Time zone: the first sign-in saves the browser's zone for the whole instance; settings → General changes it.
import { expect, test } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

// Other specs count days in Europe/Berlin (the browser's zone, see playwright.config.ts).
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  await backend().mutation(api.instance.setTimeZone, { timeZone: 'Europe/Berlin' });
});

test('the browser\'s zone is saved at the first sign-in; the select changes it for the instance', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  const select = page.getByTestId('settings-timezone');
  await expect(select).toHaveValue('Europe/Berlin');
  await expect.poll(async () => (await backend().query(api.meta.get, {})).timeZone).toBe('Europe/Berlin');

  await select.selectOption('America/Los_Angeles');
  await expect.poll(async () => (await backend().query(api.meta.get, {})).timeZone).toBe('America/Los_Angeles');
  // The browser is in Berlin: the shortcut to go back appears.
  await page.getByTestId('settings-timezone-browser').click();
  await expect.poll(async () => (await backend().query(api.meta.get, {})).timeZone).toBe('Europe/Berlin');
  await expect(page.getByTestId('settings-timezone-browser')).toHaveCount(0);
});

test('an unknown zone is refused by the server', async () => {
  await expect(backend().mutation(api.instance.setTimeZone, { timeZone: 'Mars/Olympus' })).rejects.toThrow();
});
