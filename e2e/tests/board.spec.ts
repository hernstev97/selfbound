// Board: Ctrl B toggles list ↔ board and keeps the focus, keyboard between columns,
// moving a card with Shift → and by dragging, collapsed columns, undo.
import { expect, test, type Page } from '@playwright/test';
import { focusedRow, open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const focusedCard = (page: Page) => page.locator('[data-testid="issue-card"].focused');
const column = (page: Page, name: string) => page.locator('[data-testid="board-column"]').filter({ has: page.getByTestId('column-name').getByText(name, { exact: true }) });

test('Ctrl B: board with a column per status, focus stays, back to the list; the URL remembers the board', async ({ page }) => {
  await open(page, '/team/ORB/all?order=created');
  // Triage is in the list but not on the board: pick a focus outside triage.
  await page.locator('[data-testid="issue-row"]:not([data-status="triage"])').first().hover();
  const id = (await focusedRow(page).getAttribute('data-id'))!;
  await page.keyboard.press('Control+b');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page).toHaveURL(/layout=board/);
  await expect(focusedCard(page)).toHaveAttribute('data-id', id);
  const names = await page.getByTestId('column-name').allInnerTexts();
  expect(names.slice(0, 4)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review']);
  // Done is collapsed (count only); a click expands it.
  const done = column(page, 'Done');
  await expect(done).toHaveAttribute('data-collapsed', 'true');
  await expect(done.getByTestId('issue-card')).toHaveCount(0);
  await done.locator('.column-head').click();
  await expect(done.getByTestId('issue-card').first()).toBeVisible();
  await done.locator('.column-head').click();
  await page.keyboard.press('Control+b');
  await expect(page.getByTestId('list')).toBeVisible();
  await expect(focusedRow(page)).toHaveAttribute('data-id', id);
  await expect(page).not.toHaveURL(/layout=board/);
});

test('Keyboard: → next column, Shift → moves the card, Ctrl Z undoes', async ({ page }) => {
  await open(page, '/team/ORB/all?order=created&layout=board');
  await expect(page.getByTestId('board')).toBeVisible();
  const todo = column(page, 'Todo');
  await todo.getByTestId('issue-card').first().hover();
  const id = (await focusedCard(page).getAttribute('data-id'))!;
  await page.mouse.move(2, 890);
  await page.keyboard.press('ArrowRight');
  await expect(focusedCard(page)).not.toHaveAttribute('data-id', id);
  await expect(column(page, 'In Progress').locator('[data-testid="issue-card"].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect(focusedCard(page)).toHaveAttribute('data-id', id);
  await page.keyboard.press('Shift+ArrowRight');
  await expect(column(page, 'In Progress').locator(`[data-testid="issue-card"][data-id="${id}"]`)).toBeVisible();
  await expect(focusedCard(page)).toHaveAttribute('data-id', id);
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(todo.locator(`[data-testid="issue-card"][data-id="${id}"]`)).toBeVisible();
});

test('Dragging with the mouse into another column sets the status; undo', async ({ page }) => {
  await open(page, '/team/ORB/all?order=created&layout=board');
  const card = column(page, 'Backlog').getByTestId('issue-card').first();
  const id = (await card.getAttribute('data-id'))!;
  await card.dragTo(column(page, 'In Review').locator('.column-scroll'));
  const moved = column(page, 'In Review').locator(`[data-testid="issue-card"][data-id="${id}"]`);
  await expect(moved).toBeVisible();
  await expect(moved.getByTestId('row-status')).toHaveAttribute('aria-label', 'In Review');
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(column(page, 'Backlog').locator(`[data-testid="issue-card"][data-id="${id}"]`)).toBeVisible();
});

test('Board columns by priority: Shift → sets the priority, Ctrl Z undoes, the setting is remembered', async ({ page }) => {
  await open(page, '/team/ORB/active?order=created&layout=board');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.keyboard.press('Shift+V');
  await page.getByTestId('display-boardcolumns').selectOption('priority');
  await expect(page.getByTestId('column-name')).toHaveText(['Urgent', 'High', 'Medium', 'Low', 'No priority']);
  // A card from the first column with cards that is not "No priority"; Shift → puts it one column to the right.
  const first = page.locator('[data-testid="board-column"]:not([data-priority="0"])').filter({ has: page.getByTestId('issue-card') }).first();
  await first.getByTestId('issue-card').first().hover();
  const id = (await focusedCard(page).getAttribute('data-id'))!;
  const target = { 1: 2, 2: 3, 3: 4, 4: 0 }[Number(await first.getAttribute('data-priority')) as 1 | 2 | 3 | 4];
  await page.mouse.move(2, 890);
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator(`[data-testid="board-column"][data-priority="${target}"] [data-testid="issue-card"][data-id="${id}"]`)).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(first.locator(`[data-testid="issue-card"][data-id="${id}"]`)).toBeVisible();
  // Remembered per view
  await page.reload();
  await expect(page.getByTestId('column-name').first()).toHaveText('Urgent');
});
