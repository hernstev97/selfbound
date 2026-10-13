// Creating: C, Ctrl Enter, "create more", drafts, /new.
import { expect, test } from '@playwright/test';
import { open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('C → title → Ctrl Enter: in the list at once, first "saving", then with an identifier', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  await expect(page.getByTestId('create-title')).toBeFocused();
  // Context prefilled: team and status of the view
  await expect(page.getByTestId('create-team')).toContainText('ORB');
  await expect(page.getByTestId('create-status')).toContainText('Backlog');
  await page.keyboard.type('E2E: new issue from the backlog');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  const created = page.getByTestId('issue-row').filter({ hasText: 'E2E: new issue from the backlog' });
  await expect(created).toHaveCount(1);
  await expect(created).toHaveAttribute('data-key', /^ORB-\d+$/);
  await expect(created.getByTestId('row-pending')).toHaveCount(0);
  await expect(created).toHaveClass(/focused/);
});

test('Create more (Ctrl Shift Enter) keeps the properties, the dialog stays open', async ({ page }) => {
  await open(page, '/team/NOVA');
  await page.keyboard.press('c');
  await page.getByTestId('create-priority').click();
  await page.keyboard.type('high');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('create-priority')).toContainText('High');
  await page.getByTestId('create-title').fill('E2E series one');
  await page.keyboard.press('Control+Shift+Enter');
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  await expect(page.getByTestId('create-title')).toHaveValue('');
  await expect(page.getByTestId('create-title')).toBeFocused();
  await expect(page.getByTestId('create-priority')).toContainText('High');
  await page.keyboard.type('E2E series two');
  await page.keyboard.press('Control+Shift+Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  for (const title of ['E2E series one', 'E2E series two']) {
    await expect(page.getByTestId('issue-row').filter({ hasText: title })).toHaveAttribute('data-priority', '2');
  }
});

test('A draft survives navigating away and reloading', async ({ page }) => {
  await open(page, '/inbox');
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/all/);
  await page.keyboard.press('c');
  await page.keyboard.type('E2E draft that stays');
  // Back closes the dialog first, the next Back changes the page; the draft stays.
  await page.goBack();
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/all/);
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox/);
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-title')).toHaveValue('E2E draft that stays');
  // Close and reopen the tab: the draft is listed under "Drafts".
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByTestId('nav-drafts')).toBeVisible();
  await page.getByTestId('nav-drafts').click();
  await expect(page.getByTestId('draft-row').filter({ hasText: 'E2E draft that stays' })).toBeVisible();
  await page.getByTestId('draft-row').filter({ hasText: 'E2E draft that stays' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('create-title')).toHaveValue('E2E draft that stays');
  await page.getByTestId('create-discard').click();
});

test('Esc with content saves a draft instead of asking', async ({ page }) => {
  await open(page, '/all');
  await page.keyboard.press('c');
  await page.keyboard.type('E2E just a thought');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved as draft' })).toBeVisible();
  await page.getByTestId('nav-drafts').click();
  await expect(page.getByTestId('draft-row').filter({ hasText: 'E2E just a thought' })).toBeVisible();
});

test('/new?title=…&priority=high opens the dialog prefilled', async ({ page }) => {
  await page.goto('/new?title=From%20the%20URL&priority=high&team=KITE');
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  await expect(page.getByTestId('create-title')).toHaveValue('From the URL');
  await expect(page.getByTestId('create-priority')).toContainText('High');
  await expect(page.getByTestId('create-team')).toContainText('KITE');
  await expect(page).not.toHaveURL(/\/new/);
  await page.getByTestId('create-submit').click();
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
});

test('Undo after creating moves the issue to the trash', async ({ page }) => {
  await open(page, '/team/ZEN');
  await page.keyboard.press('c');
  await page.keyboard.type('E2E gone again right away');
  await page.keyboard.press('Control+Enter');
  const created = page.getByTestId('issue-row').filter({ hasText: 'E2E gone again right away' });
  await expect(created).toHaveAttribute('data-key', /^ZEN-\d+$/);
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(created).toHaveCount(0);
  // Navigate away only after the confirmation, otherwise the delete is lost on the page change.
  await settled(page);
  await page.goto('/trash');
  await expect(page.getByTestId('issue-row').filter({ hasText: 'E2E gone again right away' })).toBeVisible();
});
