// Contrast and focus in light mode: status colors used as text (due date, added late to the sprint,
// budget, error text), faint hints and the focus ring reach 4.5:1 (text) or 3:1 (ring) against the
// surface behind them.
import { expect, test } from '@playwright/test';
import { generateDataset } from '../../backend/data/generate.ts';
import { agentCall, contrast, open, settled } from '../support/helpers.ts';

test.use({ colorScheme: 'light' });

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

/** A day relative to today as YYYY-MM-DD (local, as the app computes it). */
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Two open ORB issues with the highest priority: they are at the top of "All issues" (grouped by team, ORB first). */
const [OVERDUE, SOON] = generateDataset('small')
  .issues.filter((i) => i.teamKey === 'ORB' && i.deletedAt === undefined && ['todo', 'in_progress', 'in_review'].includes(i.status))
  .sort((a, b) => (a.priority || 9) - (b.priority || 9))
  .slice(0, 2)
  .map((i) => `ORB-${i.number}`);

test.beforeAll(async () => {
  await agentCall('update_issue', { identifier: OVERDUE, dueDate: day(-10) });
  await agentCall('update_issue', { identifier: SOON, dueDate: day(1) });
});
test.afterAll(async () => {
  for (const identifier of [OVERDUE, SOON]) await agentCall('update_issue', { identifier, dueDate: null });
});

test('Status colors as text in the list and in error text', async ({ page }) => {
  await open(page, '/all');
  for (const selector of ['.pill.overdue', '.pill.soon', '.pill.late', '.group-budget.over', '[data-testid="group-budget"]']) {
    const target = page.locator(selector).first();
    await expect(target, selector).toBeVisible();
    expect(await contrast(target), selector).toBeGreaterThanOrEqual(4.5);
  }
  await page.getByTestId('nav-teams').hover();
  await page.getByTestId('nav-team-add').click();
  await page.getByTestId('new-team-name').fill('Contrast');
  await page.getByTestId('new-team-key').fill('orb');
  await expect(page.getByTestId('new-team-error')).toBeVisible();
  expect(await contrast(page.getByTestId('new-team-error'))).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press('Escape');
});

test('Sprint planning: shortcut hints and the hint about the active sprint', async ({ page }) => {
  await open(page, '/sprint/plan');
  for (const selector of ['.plan-keys', '.plan-hint']) {
    const target = page.locator(selector).first();
    await expect(target, selector).toBeVisible();
    expect(await contrast(target), selector).toBeGreaterThanOrEqual(4.5);
  }
});

test('Focus ring: button and select of the display options by keyboard', async ({ page }) => {
  await open(page, '/all');
  const button = page.getByTestId('display-button');
  await button.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect.poll(() => contrast(button, 'outline')).toBeGreaterThanOrEqual(3);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('display-popover')).toBeVisible();
  // After keyboard input Chrome also shows the ring for focus set by script (:focus-visible).
  const select = page.getByTestId('display-grouping');
  await select.focus();
  await expect.poll(() => select.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  // Used to be `outline: none` without a replacement.
  await expect.poll(() => select.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await expect.poll(() => contrast(select, 'outline')).toBeGreaterThanOrEqual(3);
});
