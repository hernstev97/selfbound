// UI language: English by default, German when the browser prefers German (pref "auto") or when
// Settings › General › Language says so. German is a dictionary chunk loaded before the app mounts
// (app/src/lib/i18n.ts); a string translated earlier stays English and is reported on the console
// with "[i18n]".
import { expect, test, type Page } from '@playwright/test';
import { open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

/** Collects console messages that report strings translated before the dictionary was loaded. */
function watchEarlyStrings(page: Page) {
  const early: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('[i18n]')) early.push(message.text());
  });
  return early;
}

/** A few strings from the start screen that differ between English and German. */
async function expectLanguage(page: Page, lang: 'en' | 'de') {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.getByTestId('nav-inbox')).toContainText(lang === 'de' ? 'Eingang' : 'Inbox');
  await expect(page.getByTestId('nav-settings')).toContainText(lang === 'de' ? 'Einstellungen' : 'Settings');
  await expect(page.getByTestId('nav-search')).toHaveAttribute('aria-label', lang === 'de' ? 'Suche' : 'Search');
}

test.describe('English browser', () => {
  test.use({ locale: 'en-US' });

  test('English by default', async ({ page }) => {
    const early = watchEarlyStrings(page);
    await open(page, '/inbox');
    await expectLanguage(page, 'en');
    await expect(page.getByTestId('view-title')).toHaveText('Inbox');
    expect(early).toEqual([]);
  });

  test('Settings › General › Language: German reloads into the German UI, Auto goes back', async ({ page }) => {
    await open(page, '/inbox');
    await page.goto('/settings/general');
    const select = page.getByTestId('settings-locale');
    await expect(select).toHaveValue('auto');
    const reloaded = page.waitForEvent('load');
    await select.selectOption('de');
    await reloaded;
    await expect(page.getByTestId('settings-locale')).toHaveValue('de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByTestId('settings-page')).toContainText('Sprache');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('selfbound:prefs') ?? '{}').locale)).toBe('de');
    await open(page, '/inbox');
    await expectLanguage(page, 'de');
    await expect(page.getByTestId('view-title')).toHaveText('Eingang');

    // Back to "auto": the English browser language applies again.
    await page.goto('/settings/general');
    const back = page.waitForEvent('load');
    await page.getByTestId('settings-locale').selectOption('auto');
    await back;
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('settings-page')).toContainText('Language');
  });
});

test.describe('German browser', () => {
  test.use({ locale: 'de-DE' });

  test('pref "auto" follows the browser: German UI', async ({ page }) => {
    await open(page, '/inbox');
    expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
    await expectLanguage(page, 'de');
    await expect(page.getByTestId('view-title')).toHaveText('Eingang');
  });

  test('no string is translated before the German dictionary is loaded (list, detail, command menu, settings)', async ({ page }) => {
    // Known bug: app-instance.ts constructs the App while main.ts is still importing, before
    // startLocale() loads the dictionary, and the App computes the first header (core views.ts
    // label "Inbox", list.ts "none", "Plan sprint") and document.title in English. Remove this
    // line once the App is created after the locale is resolved.
    const early = watchEarlyStrings(page);
    await open(page, '/all?group=none&order=created');
    await expect(page.getByTestId('view-title')).toHaveText('Alle Issues');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('detail')).toBeVisible();
    await expect(page.getByTestId('detail-description')).toBeVisible();

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'command');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);

    // Fresh page loads: each start evaluates the start bundle again.
    await page.goto('/settings/general');
    await expect(page.getByTestId('settings-locale')).toHaveValue('auto');
    await expect(page.getByTestId('settings-page')).toContainText('Sprache');
    await open(page, '/team/ORB');
    await expect(page.getByTestId('nav-inbox')).toContainText('Eingang');
    expect(early).toEqual([]);
  });
});
