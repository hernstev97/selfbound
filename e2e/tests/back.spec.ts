// Back closes overlays: the Android back gesture (here history.back(), which is what the browser
// does for the gesture) first closes the drawer, search, create, context menu and dialogs instead of
// changing the page underneath or leaving the app. Phone profile with touch.
import { expect, test, type Page } from '@playwright/test';
import { open, settled } from '../support/helpers.ts';

test.use({ viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true });

/** Back like the gesture; waits until the history has settled. */
async function back(page: Page) {
  await page.evaluate(() => history.back());
  await page.waitForTimeout(150);
}

const path = (page: Page) => new URL(page.url()).pathname;

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('Drawer, search and context menu: Back closes them and stays on the page', async ({ page }) => {
  await open(page, '/inbox');
  await page.locator('.mobile-tab', { hasText: 'Issues' }).click();
  await expect(page).toHaveURL(/\/all/);
  await expect(page.locator('[data-testid="issue-row"]').first()).toBeVisible();

  // Drawer ("More")
  await page.getByTestId('mobile-menu').click();
  await expect(page.getByTestId('sidebar')).toBeInViewport();
  await back(page);
  await expect(page.locator('.frame.drawer')).toHaveCount(0);
  expect(path(page)).toBe('/all');

  // Search
  await page.locator('.mobile-tab', { hasText: 'Search' }).click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await back(page);
  await expect(page.getByTestId('palette')).toHaveCount(0);
  expect(path(page)).toBe('/all');

  // Context menu of a row
  await page.locator('[data-testid="issue-row"]').first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await back(page);
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  expect(path(page)).toBe('/all');

  // Nothing open any more: now Back changes the page as usual.
  await back(page);
  await expect(page).toHaveURL(/\/inbox/);
});

test('Create: Back closes the dialog, the plus button brings the text back', async ({ page }) => {
  await open(page, '/all');
  await page.getByTestId('mobile-create').click();
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  const title = `Back draft ${Date.now()}`;
  await page.getByTestId('create-title').fill(title);
  await back(page);
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  expect(path(page)).toBe('/all');
  await page.getByTestId('mobile-create').click();
  await expect(page.getByTestId('create-title')).toHaveValue(title);
  await page.evaluate(() => (window as unknown as { __selfbound: { app: { create: { discard(): void } } } }).__selfbound.app.create.discard());
});

test('Esc closes: no dead history entry, the next Back changes the page', async ({ page }) => {
  await open(page, '/inbox');
  await page.locator('.mobile-tab', { hasText: 'Issues' }).click();
  await expect(page).toHaveURL(/\/all/);
  await page.locator('.mobile-tab', { hasText: 'Search' }).click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await page.waitForTimeout(150);
  expect(path(page)).toBe('/all');
  await back(page);
  await expect(page).toHaveURL(/\/inbox/);
});

test('A command in the command menu changes the page: Back returns, without a dead entry', async ({ page }) => {
  await open(page, '/all');
  // Phones have no Ctrl K; the menu is the same as search (close and navigate in the same step).
  await page.evaluate(() => (window as unknown as { __selfbound: { app: { palette: { open(kind: string): void } } } }).__selfbound.app.palette.open('command'));
  await page.getByTestId('palette-input').fill('All sprints');
  await page.locator('[data-testid="palette-item"]', { hasText: 'All sprints' }).first().click();
  await expect(page).toHaveURL(/\/sprints/);
  await back(page);
  await expect(page.getByTestId('palette')).toHaveCount(0);
  expect(path(page)).toBe('/all');
  // Forward leads to the sprints again, not to an empty menu entry.
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/\/sprints/);
});

test('Dialog in the settings (color picker): Back closes only the picker', async ({ page }) => {
  await open(page, '/all');
  await page.goto('/settings/teams/ORB');
  await page.getByTestId('team-hue').click();
  await expect(page.locator('.hue-pop')).toBeVisible();
  await back(page);
  await expect(page.locator('.hue-pop')).toHaveCount(0);
  expect(path(page)).toBe('/settings/teams/ORB');
});
