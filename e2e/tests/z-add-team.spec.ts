// Add team: the dialog from the sidebar, via O N and from the command menu.
// The file name starts with "z-" so it runs last: it creates teams that must not show up in the
// other tests (cards, sprint planning). All specs run serially against one backend.
import { expect, test } from '@playwright/test';
import { api, backend, open } from '../support/helpers.ts';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#e5484d"/></svg>';

test('The plus opens the dialog; the key comes from the name, a taken key is rejected at once', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-teams').hover();
  await page.getByTestId('nav-team-add').click();
  await expect(page.getByTestId('new-team-dialog')).toBeVisible();
  await expect(page.getByTestId('new-team-name')).toBeFocused();
  await expect(page.getByTestId('new-team-submit')).toBeDisabled();
  await page.getByTestId('new-team-name').fill('Comets');
  await expect(page.getByTestId('new-team-key')).toHaveValue('COME');
  await page.getByTestId('new-team-key').fill('orb');
  await expect(page.getByTestId('new-team-error')).toHaveText('The key ORB is already taken.');
  await expect(page.getByTestId('new-team-submit')).toBeDisabled();
  await page.getByTestId('new-team-key').fill('K');
  await expect(page.getByTestId('new-team-error')).toContainText('2 to 6 characters');
  // Esc closes, nothing was created.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-team-dialog')).toHaveCount(0);
  const teams = (await backend().query(api.meta.get, {})).teams.map((t) => t.key);
  expect(teams).not.toContain('COME');
});

test('Create with a logo: the new team becomes the current team', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-teams').hover();
  await page.getByTestId('nav-team-add').click();
  await page.getByTestId('new-team-name').fill('Comets');
  await page.getByTestId('new-team-logo').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect(page.getByTestId('new-team-dialog').locator('[data-logo="img"]')).toBeVisible();
  await page.getByTestId('new-team-submit').click();
  await expect(page.getByTestId('new-team-dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/team\/COME$/);
  await expect(page.locator('.team-card.current')).toHaveAttribute('data-testid', 'nav-team-COME');
  await expect(page.locator('.team-card.current [data-logo="img"]')).toBeVisible();
  await expect(page.getByTestId('nav-team-COME-settings')).toBeVisible();
  // The old team is back in the "Teams" list.
  await expect(page.getByTestId('nav-team-ORB')).not.toHaveClass(/current/);
  const meta = await backend().query(api.meta.get, {});
  expect(meta.teams.filter((t) => t.key === 'COME')).toHaveLength(1);
});

test('By keyboard: O N opens, Enter creates', async ({ page }) => {
  await open(page);
  await page.keyboard.press('o');
  await page.keyboard.press('n');
  await expect(page.getByTestId('new-team-dialog')).toBeVisible();
  await page.keyboard.type('Stars');
  await expect(page.getByTestId('new-team-key')).toHaveValue('STAR');
  // Page shortcuts stay silent in the dialog (c would otherwise open "New issue").
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/team\/STAR$/);
  await expect(page.locator('.team-card.current')).toHaveAttribute('data-testid', 'nav-team-STAR');
});

test('Command menu: "Add team …"', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Add team');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('new-team-dialog')).toBeVisible();
  await page.getByTestId('new-team-name').fill('Clouds');
  await page.getByTestId('new-team-key').fill('clou');
  await page.getByTestId('new-team-submit').click();
  await expect(page).toHaveURL(/\/team\/CLOU$/);
});
