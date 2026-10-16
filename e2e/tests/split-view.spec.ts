// Split view in lists and on the board (the inbox has its own spec): open with ⇧ Space or the
// button, J/K and click switch the issue on the right, Enter and back keep it, Esc closes it.
import { expect, test, type Page } from '@playwright/test';
import { focusedRow, open } from '../support/helpers.ts';

const shownKey = (page: Page) => page.getByTestId('split-detail').getByTestId('detail-key');
const rows = (page: Page) => page.getByTestId('issue-row');

test('⇧ Space opens the focused issue next to the list; J/K, click, Enter and back keep the list', async ({ page }) => {
  await open(page, '/all?group=none&order=created');
  await expect(page.getByTestId('list-split')).toHaveCount(0);
  await page.keyboard.press('j');
  const first = (await focusedRow(page).getAttribute('data-key'))!;
  await page.keyboard.press('Shift+Space');
  await expect(page.getByTestId('list-split')).toBeVisible();
  await expect(shownKey(page)).toHaveText(first);
  await expect(page.getByTestId('split-toggle')).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('j');
  const second = (await focusedRow(page).getAttribute('data-key'))!;
  expect(second).not.toBe(first);
  await expect(shownKey(page)).toHaveText(second);

  const third = rows(page).nth(4);
  const thirdKey = (await third.getAttribute('data-key'))!;
  await third.click();
  await expect(page).toHaveURL(/\/all\?/);
  await expect(shownKey(page)).toHaveText(thirdKey);

  // Enter opens the own page; back shows list and split as they were.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/issue/${thirdKey}$`));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('list-split')).toBeVisible();
  await expect(shownKey(page)).toHaveText(thirdKey);

  // Stays on in another list.
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page.getByTestId('list-split')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('list-split')).toHaveCount(0);
  await expect(page.getByTestId('split-detail')).toHaveCount(0);
});

test('On the board: the button opens it, a card click and arrows switch, × closes it', async ({ page }) => {
  await open(page, '/team/ORB/active?order=created&layout=board');
  await page.getByTestId('split-toggle').click();
  await expect(page.getByTestId('list-split')).toBeVisible();
  const card = page.getByTestId('issue-card').nth(1);
  const key = (await card.getAttribute('data-key'))!;
  await card.click();
  await expect(shownKey(page)).toHaveText(key);
  await page.keyboard.press('ArrowRight');
  await expect(shownKey(page)).not.toHaveText(key);
  await page.getByTestId('split-close').click();
  await expect(page.getByTestId('list-split')).toHaveCount(0);
});

test('The list width is its own and survives a reload', async ({ page }) => {
  await open(page, '/all?group=none&order=created');
  await page.keyboard.press('j');
  await page.keyboard.press('Shift+Space');
  await expect(page.getByTestId('list-split')).toBeVisible();
  const list = page.locator('.split-list');
  const handle = page.getByTestId('split-handle');
  const before = (await list.boundingBox())!.width;
  await handle.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  const width = (await list.boundingBox())!.width;
  expect(width).toBeGreaterThan(before + 60);
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('Shift+Space');
  await expect(page.getByTestId('list-split')).toBeVisible();
  expect(Math.abs((await list.boundingBox())!.width - width)).toBeLessThan(2);
  // The inbox keeps its own width.
  await page.keyboard.press('Escape');
  await open(page, '/inbox');
  expect(Math.abs((await page.locator('.split-list').boundingBox())!.width - width)).toBeGreaterThan(100);
});
