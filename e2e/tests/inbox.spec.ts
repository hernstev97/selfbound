// Split inbox: list on the left, issue on the right, removing and reading entries.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, focusedRow, open, settled } from '../support/helpers.ts';

const split = (page: Page) => page.getByTestId('split-detail');
const shownKey = (page: Page) => split(page).getByTestId('detail-key');
const rows = (page: Page) => page.getByTestId('issue-row');

async function issue(id: string) {
  for (let bucket = 0; ; bucket++) {
    const docs = await backend().query(api.issues.bucket, { bucket });
    const hit = docs.find((d) => d._id === id);
    if (hit || docs.length === 0) return hit;
  }
}

test('A click shows the issue on the right, J/K move entry and right side together, read is marked', async ({ page }) => {
  await open(page, '/inbox');
  await expect(page.getByTestId('inbox-split')).toBeVisible();
  await expect(page.getByTestId('split-empty')).toBeVisible();
  const second = rows(page).nth(1);
  const key = (await second.getAttribute('data-key'))!;
  await second.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(shownKey(page)).toHaveText(key);
  // The list stays visible; the entry is marked read after a short look.
  await expect(rows(page).first()).toBeVisible();
  await expect(second).toHaveClass(/seen/);
  await page.keyboard.press('j');
  const third = (await rows(page).nth(2).getAttribute('data-key'))!;
  await expect(shownKey(page)).toHaveText(third);
  await expect(focusedRow(page)).toHaveAttribute('data-key', third);
  await page.keyboard.press('k');
  await expect(shownKey(page)).toHaveText(key);
  // U: unread again
  await page.keyboard.press('u');
  await expect(second).not.toHaveClass(/seen/);
  await page.keyboard.press('u');
  await expect(second).toHaveClass(/seen/);
  // Esc closes the right side, the focus stays.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('split-empty')).toBeVisible();
  await expect(focusedRow(page)).toHaveAttribute('data-key', key);
  await settled(page);
});

test('Remove takes only the entry out of the inbox, the issue stays unchanged; undo brings it back', async ({ page }) => {
  await open(page, '/inbox');
  const first = rows(page).first();
  const [id, key] = await first.evaluate((el) => [el.getAttribute('data-id')!, el.getAttribute('data-key')!]);
  const before = (await issue(id))!;
  await first.click();
  await expect(shownKey(page)).toHaveText(key);
  const next = (await rows(page).nth(1).getAttribute('data-key'))!;
  await page.keyboard.press('Backspace');
  await expect(page.locator(`[data-testid="issue-row"][data-id="${id}"]`)).toHaveCount(0);
  // The next entry shows on the right.
  await expect(shownKey(page)).toHaveText(next);
  await expect(page.getByTestId('toast').last()).toContainText(`${key} removed from inbox`);
  await settled(page);
  const after = (await issue(id))!;
  expect(after.reviewedAt).toBeDefined();
  expect({ ...after, reviewedAt: 0, readAt: 0 }).toEqual({ ...before, reviewedAt: 0, readAt: 0 });
  // Undo (Ctrl Z): back in the inbox.
  await page.keyboard.press('Control+z');
  await expect(page.locator(`[data-testid="issue-row"][data-id="${id}"]`)).toHaveCount(1);
  await settled(page);
  expect((await issue(id))!.reviewedAt).toBeUndefined();
  // Also via the row button (without looking at the issue).
  const row = page.locator(`[data-testid="issue-row"][data-id="${id}"]`);
  await row.hover();
  await row.getByTestId('inbox-remove').click();
  await expect(row).toHaveCount(0);
  await page.getByTestId('toast').last().getByRole('button', { name: 'Undo' }).click();
  await expect(row).toHaveCount(1);
  await settled(page);
});

test('"Done for today" clears the inbox, undo restores all entries', async ({ page }) => {
  await open(page, '/inbox');
  const count = await rows(page).count();
  expect(count).toBeGreaterThan(1);
  await page.getByTestId('inbox-clear').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('toast').last()).toContainText('Inbox cleared');
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(rows(page)).toHaveCount(count);
  await settled(page);
});

test('Command menu: inbox actions are there, with shortcuts', async ({ page }) => {
  await open(page, '/inbox');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('inbox');
  const palette = page.getByTestId('palette');
  await expect(palette).toContainText('Remove from inbox');
  await expect(palette).toContainText('Done for today: clear inbox');
  await page.keyboard.press('Escape');
});

test('The split width can be dragged and survives a reload', async ({ page }) => {
  await open(page, '/inbox');
  const list = page.locator('.split-list');
  const handle = page.getByTestId('split-handle');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 121, box.y + 200, { steps: 6 });
  await page.mouse.up();
  const width = (await list.boundingBox())!.width;
  expect(width).toBeGreaterThan(500);
  await page.reload();
  await expect(page.getByTestId('inbox-split')).toBeVisible();
  expect(Math.abs((await list.boundingBox())!.width - width)).toBeLessThan(2);
  // Double click resets it.
  await handle.dblclick();
  expect((await list.boundingBox())!.width).toBeLessThan(width - 50);
});

test('The right side is the normal detail: changing a property in the inbox affects the shown issue', async ({ page }) => {
  await open(page, '/inbox');
  await rows(page).first().click();
  const id = (await split(page).getByTestId('detail').getAttribute('data-id'))!;
  await page.keyboard.press('p');
  await page.keyboard.type('low');
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-testid="issue-row"][data-id="${id}"]`)).toHaveAttribute('data-priority', '4');
  await settled(page);
  expect((await issue(id))!.priority).toBe(4);
  await page.keyboard.press('Control+z');
  await settled(page);
});
