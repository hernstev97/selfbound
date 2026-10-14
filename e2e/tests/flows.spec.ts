// Triage, trash with undo, inbox, live changes from a second client.
import { expect, test } from '@playwright/test';
import { agentCall, api, backend, focusedRow, open, resolve, row, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('Triage: accept (1 → Todo) and decline (3)', async ({ page }) => {
  await open(page, '/triage');
  const count = Number(await page.getByTestId('view-count').textContent());
  const first = focusedRow(page);
  const id = (await first.getAttribute('data-id'))!;
  await page.keyboard.press('1');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'move');
  await page.keyboard.type('todo');
  await page.keyboard.press('Enter');
  await expect(row(page, id)).toHaveCount(0);
  await expect(page.getByTestId('view-count')).toHaveText(String(count - 1));
  const second = (await focusedRow(page).getAttribute('data-id'))!;
  await page.keyboard.press('3');
  await expect(row(page, second)).toHaveCount(0);
  await expect(page.getByTestId('view-count')).toHaveText(String(count - 2));
  await settled(page);
  const accepted = (await backend().query(api.issues.bucket, { bucket: 0 })).concat(...(await Promise.all([1, 2, 3, 4, 5, 6].map((b) => backend().query(api.issues.bucket, { bucket: b })))));
  expect(accepted.find((i) => i._id === id)).toMatchObject({ status: 'todo' });
  // Accepting marks an inbox entry as read but does not remove it.
  const entry = (await backend().query(api.inbox.list, {})).find((e) => e.issueId === id);
  expect(entry?.readAt).toBeDefined();
  expect(accepted.find((i) => i._id === second)).toMatchObject({ status: 'canceled' });
});

test('Triage: accept into another team; the old identifier redirects', async ({ page }) => {
  await open(page, '/triage');
  const [key, id] = await focusedRow(page).evaluate((el) => [el.getAttribute('data-key')!, el.getAttribute('data-id')!]);
  const targetTeam = key.startsWith('KITE-') ? 'Zenith' : 'Kite';
  await page.keyboard.press('1');
  await page.keyboard.type(`Accept into ${targetTeam}`);
  await expect(page.getByTestId('palette-item').first()).toContainText(`Accept into ${targetTeam}`);
  await page.keyboard.press('Enter');
  await expect(row(page, id)).toHaveCount(0);
  const toast = page.getByTestId('toast').filter({ hasText: `${key} is now` });
  await expect(toast).toBeVisible();
  const next = (await toast.textContent())!.match(/is now ([A-Z0-9]+-\d+)/)![1];
  await settled(page);
  await page.goto(`/issue/${key}`);
  await expect(page.getByTestId('detail-key')).toHaveText(next);
  await expect(page.getByTestId('activity')).toContainText(`moved it from ${key} to ${next}`);
});

test('Delete (Ctrl Del), undo, trash and restore', async ({ page }) => {
  await open(page, '/team/NOVA/backlog');
  const target = focusedRow(page);
  const id = (await target.getAttribute('data-id'))!;
  const title = (await target.getByTestId('row-title').textContent())!;
  await page.keyboard.press('Control+Delete');
  await expect(row(page, id)).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'trash' })).toBeVisible();
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(row(page, id)).toHaveCount(1);
  await settled(page);
  // Delete again, then restore from the trash.
  await focusedRow(page).click({ button: 'right', position: { x: 600, y: 20 } });
  await page.getByTestId('context-item').filter({ hasText: 'Delete' }).click();
  await expect(row(page, id)).toHaveCount(0);
  await settled(page);
  await page.getByTestId('nav-trash').click();
  const trashed = page.getByTestId('issue-row').filter({ hasText: title });
  await expect(trashed).toBeVisible();
  await trashed.getByTestId('row-restore').click();
  await expect(trashed).toHaveCount(0);
  await settled(page);
  await page.goto('/team/NOVA/backlog');
  await expect(row(page, id)).toHaveCount(1);
});

test('Inbox (narrow window): opening marks as read, the entry stays', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page, '/inbox');
  const count = Number(await page.getByTestId('inbox-count').textContent());
  expect(count).toBeGreaterThan(0);
  await expect(page.getByTestId('inbox-split')).toHaveCount(0);
  const seen = await page.locator('.inbox-row.seen').count();
  await page.locator('.inbox-row:not(.seen)').first().click();
  await expect(page.getByTestId('detail')).toBeVisible();
  await expect(page).toHaveURL(/\/issue\//);
  await expect(page.getByTestId('inbox-count')).toHaveText(String(count - 1));
  await page.keyboard.press('Escape');
  // Read entries stay in the inbox (dimmed) until removed.
  await expect(page.locator('.inbox-row.seen')).toHaveCount(seen + 1);
});

test('A change from a second client shows up live; the scroll position stays', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 25; i++) await page.keyboard.press('j');
  // Read identifier and id in one go (otherwise the locator is resolved twice).
  const [key, id] = await page.getByTestId('issue-row').nth(5).evaluate((el) => [el.getAttribute('data-key')!, el.getAttribute('data-id')!]);
  const scroll = await page.getByTestId('list').evaluate((el) => el.scrollTop);
  const focus = await focusedRow(page).getAttribute('data-id');
  const hit = (await resolve(key))!;
  expect(hit.id).toBe(id);
  await backend().mutation(api.issues.update, { ids: [hit.id], patch: { title: 'Live from the second client', labelIds: [] } });
  await expect(row(page, id).getByTestId('row-title')).toHaveText('Live from the second client', { timeout: 2000 });
  expect(await page.getByTestId('list').evaluate((el) => el.scrollTop)).toBe(scroll);
  await expect(focusedRow(page)).toHaveAttribute('data-id', focus!);
});

test('Agent via MCP: status and comment show up live, with the agent name in the activity', async ({ page }) => {
  await open(page, '/team/ORB/all?group=none&order=created');
  const [key, id] = await page.getByTestId('issue-row').nth(3).evaluate((el) => [el.getAttribute('data-key')!, el.getAttribute('data-id')!]);
  const scroll = await page.getByTestId('list').evaluate((el) => el.scrollTop);
  const status = (await row(page, id).getAttribute('data-status')) === 'in_review' ? 'todo' : 'in_review';
  await agentCall('set_status', { identifiers: [key], status });
  await expect(row(page, id)).toHaveAttribute('data-status', status, { timeout: 2000 });
  expect(await page.getByTestId('list').evaluate((el) => el.scrollTop)).toBe(scroll);
  await agentCall('add_comment', { requestId: `e2e-${Date.now()}`, identifier: key, body: 'Comment from the agent via MCP' });
  await row(page, id).click();
  const comment = page.getByTestId('comment').filter({ hasText: 'Comment from the agent via MCP' });
  await expect(comment).toBeVisible();
  await expect(comment).toHaveAttribute('data-source', 'agent');
  await expect(comment).toContainText('E2E-Agent');
  const event = page.getByTestId('activity-event').filter({ hasText: 'E2E-Agent' }).first();
  await expect(event).toBeVisible();
  // Revert the agent's change
  await event.hover();
  await event.getByTestId('activity-revert').click();
  await expect(page.getByTestId('detail-status')).not.toContainText(status === 'in_review' ? 'In Review' : 'Todo');
});

test('A new issue from outside shows up without a reload', async ({ page }) => {
  await open(page, '/team/PX');
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'PX')!;
  await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: 'Created from outside', status: 'todo' }] });
  await expect(page.getByTestId('issue-row').filter({ hasText: 'Created from outside' })).toBeVisible({ timeout: 3000 });
});

test('Help (?) is searchable and shows shortcuts', async ({ page }) => {
  await open(page);
  await page.keyboard.press('?');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'help');
  await page.keyboard.type('branch');
  await expect(page.getByTestId('palette-item').first()).toContainText('Copy branch name');
  await expect(page.getByTestId('palette-item').first().locator('.shortcut')).toContainText('.');
  await page.keyboard.press('Escape');
});

test('Settings: light/dark without a reload', async ({ page }) => {
  await open(page);
  await page.keyboard.press('j');
  const focus = await focusedRow(page).getAttribute('data-id');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('theme-switch').getByText('Light', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('theme-switch').getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goBack();
  await page.goBack();
  await expect(focusedRow(page)).toHaveAttribute('data-id', focus!);
});
