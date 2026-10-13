// More rules: issues filtered out by your own change, relations, old identifier in search, offline indicator.
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { api, backend, focusedRow, open, row, settled } from '../support/helpers.ts';
import { BACKEND_PORT } from '../support/env.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('An issue drops out of the view after your own change: toast with undo, focus on the next one', async ({ page }) => {
  await open(page, '/team/KITE');
  await page.keyboard.press('j');
  const id = (await focusedRow(page).getAttribute('data-id'))!;
  const index = await page.getByTestId('issue-row').evaluateAll((rows, target) => rows.findIndex((r) => r.getAttribute('data-id') === target), id);
  await page.keyboard.press('s');
  await page.keyboard.type('done');
  await page.keyboard.press('Enter');
  await expect(row(page, id)).toHaveCount(0);
  const toast = page.getByTestId('toast').filter({ hasText: 'is no longer in this view' });
  await expect(toast).toBeVisible();
  await expect(focusedRow(page)).toHaveCount(1);
  const now = await page.getByTestId('issue-row').evaluateAll((rows) => rows.findIndex((r) => r.classList.contains('focused')));
  expect(now).toBe(index);
  await settled(page);
  await toast.getByTestId('toast-action').click();
  await expect(row(page, id)).toHaveCount(1);
});

test('Relation "Blocks …" via the command menu, removal in the detail', async ({ page }) => {
  await open(page, '/team/ZEN');
  const otherKey = (await page.getByTestId('issue-row').nth(2).getAttribute('data-key'))!;
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('blocks');
  await expect(page.getByTestId('palette-item').first()).toContainText('Blocks …');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'relation');
  await page.keyboard.type(otherKey);
  await expect(page.getByTestId('palette-item').first()).toContainText(otherKey);
  await page.keyboard.press('Enter');
  const relations = page.locator('.section-title', { hasText: 'Relations' });
  await expect(relations).toBeVisible();
  const entry = page.locator('.sub-row', { hasText: otherKey });
  await expect(entry).toBeVisible();
  await settled(page);
  await entry.hover();
  await entry.getByRole('button', { name: 'Remove relation' }).click();
  await expect(page.locator('.sub-row', { hasText: otherKey })).toHaveCount(0);
});

test('An old identifier in search (/) finds the issue via the server', async ({ page }) => {
  const hit = await backend().query(api.issues.resolve, { identifier: 'PIX-2' });
  test.skip(!hit, 'No alias in the dataset');
  await open(page);
  await page.keyboard.press('/');
  await page.keyboard.type('pix2');
  await expect(page.getByTestId('palette-item').first()).toContainText('formerly PIX2');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-key')).toHaveText(hit!.identifier);
});

test('Offline: changes visible at once, indicator "Offline · n pending", saved afterwards', async ({ page }) => {
  // Cut the backend connection through a routed WebSocket (Chromium does not reliably close
  // existing WebSockets on setOffline).
  let offline = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(new RegExp(`127\\.0\\.0\\.1:${BACKEND_PORT}`), (ws) => {
    if (offline) return void ws.close();
    ws.connectToServer();
    sockets.add(ws);
  });
  await open(page);
  await expect(page.getByTestId('sync-state')).toHaveCount(0);
  const ids: [string, number][] = [];
  offline = true;
  for (const ws of sockets) await ws.close();
  // Convex notices the dropped connection only after a moment.
  await expect(page.getByTestId('sync-state')).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 3; i++) {
    const id = (await focusedRow(page).getAttribute('data-id'))!;
    const target = (await focusedRow(page).getAttribute('data-priority')) === '4' ? 2 : 4;
    ids.push([id, target]);
    await page.keyboard.press('p');
    await page.keyboard.type(target === 4 ? 'low' : 'high');
    await page.keyboard.press('Enter');
    await expect(row(page, id)).toHaveAttribute('data-priority', String(target));
    await page.keyboard.press('j');
  }
  await expect(page.getByTestId('sync-state')).toContainText('3 pending');
  offline = false;
  await expect(page.getByTestId('sync-state')).toHaveCount(0, { timeout: 20000 });
  await settled(page);
  const docs = (await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((bucket) => backend().query(api.issues.bucket, { bucket })))).flat();
  for (const [id, target] of ids) expect(docs.find((d) => d._id === id)?.priority).toBe(target);
});

test('Shortcut tour: Shift E, Shift D (calendar), Ctrl Shift P, hold Space, Alt ↓ in the backlog', async ({ page }) => {
  await open(page, '/team/FLUX/backlog');
  const first = focusedRow(page);
  const [id, key] = await first.evaluate((el) => [el.getAttribute('data-id')!, el.getAttribute('data-key')!]);
  // Estimate
  await page.keyboard.press('Shift+E');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'estimate');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await expect(row(page, id).locator('.row-est')).toContainText('5');
  // Due date via the calendar
  await page.keyboard.press('Shift+D');
  await expect(page.getByTestId('calendar')).toBeVisible();
  await page.getByTestId('calendar').locator('.cal-day:not(.other)').nth(20).click();
  await expect(row(page, id).locator('.p-due')).toBeVisible();
  // Parent (Ctrl Shift P) set to the second issue
  const parentKey = (await page.getByTestId('issue-row').nth(1).getAttribute('data-key'))!;
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'parent');
  await page.keyboard.type(parentKey);
  // With a query the match is on top and active ("No parent" only without a query).
  await expect(page.locator('[data-testid="palette-item"].active')).toContainText(parentKey);
  await page.keyboard.press('Enter');
  await settled(page);
  // Hold Space: peek only while held
  await page.keyboard.down(' ');
  await expect(page.getByTestId('peek')).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.up(' ');
  await expect(page.getByTestId('peek')).toHaveCount(0);
  // Alt ↓: one rank down (the backlog is sorted manually)
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByTestId('issue-row').nth(1)).toHaveAttribute('data-id', id);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId('issue-row').nth(1)).toHaveAttribute('data-id', id);
  // The parent shows in the detail
  await page.goto(`/issue/${key}`);
  await expect(page.getByTestId('detail-parent')).toContainText(parentKey);
});
