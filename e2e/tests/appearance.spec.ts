// Appearance: VS Code themes for light and dark, custom themes, fonts. Applies on all devices
// (Convex) and is in place right at startup (localStorage, inline script in index.html).
import { expect, test, type Page } from '@playwright/test';
import { api, backend, contrast, open, settled } from '../support/helpers.ts';

const DEFAULT = { dark: 'xlr8', light: 'xlr8', sans: 'inter', mono: 'system', overrides: [] };

/** Other specs run afterwards on the same data: always reset the appearance to the default. */
async function reset() {
  const client = backend();
  const { themes } = await client.query(api.appearance.get, {});
  for (const t of themes) await client.mutation(api.appearance.deleteTheme, { id: t.id });
  await client.mutation(api.appearance.save, DEFAULT);
}

test.beforeAll(reset);
test.afterAll(reset);
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function openAppearance(page: Page) {
  await page.goto('/settings/appearance');
  await expect(page.getByTestId('theme-picker-dark')).toBeVisible();
}

test('Choosing a theme: applies at once, saved on the server, present after a reload without app code', async ({ page, browser }) => {
  await openAppearance(page);
  await page.getByTestId('theme-switch').getByText('Dark', { exact: true }).click();
  await page.locator('[data-testid="theme-card"][data-id="catppuccin-mocha"]').click();
  await expect.poll(() => cssVar(page, '--bg-panel')).toBe('#1e1e2e');
  await expect(page.getByTestId('theme-selected-dark')).toHaveText('Catppuccin Mocha');
  await expect(page.getByTestId('theme-preview-dark')).toBeVisible();
  await expect.poll(async () => (await backend().query(api.appearance.get, {})).settings?.dark).toBe('catppuccin-mocha');

  // Reload without any script except the inline one: colors and status bar are still right.
  await page.route(/\/assets\/.*\.js$|\/src\/.*\.(ts|svelte)/, (route) => route.abort());
  await page.goto('/all');
  await expect.poll(() => cssVar(page, '--bg-app')).toBe('#181825');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(24, 24, 37)');
  expect(await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content)).toBe('#181825');
  await page.unroute(/\/assets\/.*\.js$|\/src\/.*\.(ts|svelte)/);

  // Second device (empty browser): fetches the choice from the server.
  const other = await browser.newPage({ baseURL: test.info().project.use.baseURL, colorScheme: 'dark', serviceWorkers: 'block' });
  await open(other, '/all');
  await expect.poll(() => cssVar(other, '--bg-panel'), { timeout: 15_000 }).toBe('#1e1e2e');
  await other.close();

  // Back to Selfbound: the theme's variables disappear.
  await openAppearance(page);
  await page.locator('[data-testid="theme-card"][data-id="xlr8"][data-mode="dark"]').click();
  await expect.poll(() => cssVar(page, '--bg-panel')).not.toBe('#1e1e2e');
});

test('Contrast with themes: budget, error text and focus ring stay readable', async ({ page }) => {
  await backend().mutation(api.appearance.save, { ...DEFAULT, dark: 'nord', light: 'solarized-light' });
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, '/all');
    await expect.poll(() => cssVar(page, '--bg-panel'), { timeout: 15_000 }).toBe(scheme === 'dark' ? '#2e3440' : '#fdf6e3');
    const budget = page.getByTestId('group-budget').first();
    await expect(budget).toBeVisible();
    expect(await contrast(budget), `Budget ${scheme}`).toBeGreaterThanOrEqual(4.5);
    const button = page.getByTestId('display-button');
    await button.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect.poll(() => contrast(button, 'outline')).toBeGreaterThanOrEqual(3);
    await page.getByTestId('nav-teams').hover();
    await page.getByTestId('nav-team-add').click();
    await page.getByTestId('new-team-name').fill('Contrast');
    await page.getByTestId('new-team-key').fill('orb');
    await expect(page.getByTestId('new-team-error')).toBeVisible();
    expect(await contrast(page.getByTestId('new-team-error')), `Error ${scheme}`).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Escape');
  }
  await backend().mutation(api.appearance.save, DEFAULT);
});

const JSONC = `{
  // Comment as in VS Code
  "name": "Test purple",
  "type": "dark",
  "colors": {
    "editor.background": "#1a1022",
    "editor.foreground": "#eadcf5",
    "focusBorder": "#c77dff", /* accent */
    "errorForeground": "#ff4d6d",
  },
  "tokenColors": [
    { "scope": ["keyword"], "settings": { "foreground": "#ff9e64" } },
  ],
}`;

test('Custom theme: paste JSONC, preview, use, override a color, rename, delete with undo', async ({ page }) => {
  await openAppearance(page);
  await page.getByTestId('theme-switch').getByText('Dark', { exact: true }).click();
  await page.getByTestId('theme-add').click();
  await page.getByTestId('theme-json').fill('{ "colors": ');
  await expect(page.getByTestId('theme-error')).toContainText('Not valid JSON');
  await expect(page.getByTestId('theme-save')).toBeDisabled();
  await page.getByTestId('theme-json').fill(JSONC);
  await expect(page.getByTestId('theme-editor-preview')).toBeVisible();
  await expect(page.getByTestId('theme-name')).toHaveValue('Test purple');
  await page.getByTestId('theme-save-use').click();
  await expect(page.getByTestId('theme-editor')).toHaveCount(0);
  await expect.poll(() => cssVar(page, '--bg-panel')).toBe('#1a1022');
  await expect.poll(() => cssVar(page, '--syn-keyword')).toBe('#ff9e64');
  await expect(page.getByTestId('theme-selected-dark')).toHaveText('Test purple');

  // Override a color: applies at once and on the server
  await page.getByTestId('theme-colors-toggle-dark').click();
  const accent = page.locator('[data-testid="theme-color"][data-name="accent"] input[type="color"]');
  await accent.fill('#2266cc');
  await expect.poll(() => cssVar(page, '--accent')).toBe('#2266cc');
  await expect.poll(async () => (await backend().query(api.appearance.get, {})).settings?.overrides[0]?.colors.accent, { timeout: 5000 }).toBe('#2266cc');

  // Rename
  const row = page.getByTestId('custom-theme').first();
  await row.getByTestId('custom-theme-name').fill('Purple');
  await row.getByTestId('custom-theme-name').press('Enter');
  await expect(page.getByTestId('theme-selected-dark')).toHaveText('Purple');

  // Delete: back to Selfbound; undo restores the theme, the selection and the color
  await row.hover();
  await row.getByTestId('custom-theme-delete').click();
  await expect(page.getByTestId('custom-theme')).toHaveCount(0);
  await expect.poll(() => cssVar(page, '--bg-panel')).not.toBe('#1a1022');
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('custom-theme')).toHaveCount(1);
  await expect.poll(() => cssVar(page, '--bg-panel')).toBe('#1a1022');
  await expect.poll(() => cssVar(page, '--accent')).toBe('#2266cc');
});

test('Fonts: only the chosen file loads; local font by name, unsafe names rejected', async ({ page }) => {
  await openAppearance(page);
  await page.getByTestId('font-mono').selectOption('jetbrains-mono');
  await expect.poll(() => cssVar(page, '--mono')).toMatch(/^'JetBrains Mono Variable'/);
  await expect.poll(() => page.evaluate(() => document.fonts.check("13px 'JetBrains Mono Variable'"))).toBe(true);
  const fontFiles = () => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()!).filter((n) => n.endsWith('.woff2')));
  await expect.poll(async () => (await fontFiles()).some((f) => f.startsWith('jetbrains-mono-latin-wght'))).toBe(true);
  expect((await fontFiles()).filter((f) => /^(fira-code|geist|roboto|open-sans|noto-sans|figtree|cascadia|source-|ibm-plex|atkinson)/.test(f))).toEqual([]);

  await page.getByTestId('font-sans').selectOption('local');
  await page.getByTestId('font-sans-local').fill("Evil'; } body {");
  await page.getByTestId('font-sans-local').press('Enter');
  await expect(page.getByRole('alert')).toContainText('Only letters');
  await page.getByTestId('font-sans-local').fill('DejaVu Sans');
  await page.getByTestId('font-sans-local').press('Enter');
  await expect.poll(() => cssVar(page, '--font')).toMatch(/^'DejaVu Sans', ui-sans-serif/);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontFeatureSettings)).toBe('normal');
  await expect.poll(async () => (await backend().query(api.appearance.get, {})).settings).toMatchObject({ sans: 'local:DejaVu Sans', mono: 'jetbrains-mono' });
});
