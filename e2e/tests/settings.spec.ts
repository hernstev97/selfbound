// Settings: team logo with rejection of unsafe SVGs, creating and revoking agent keys,
// recurrences (also from an issue), ops page, older comments.
import { expect, test } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';
import { BACKEND_PORT } from '../support/env.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#e8590c"/><circle cx="16" cy="16" r="8" fill="#fff"/></svg>';
const SCRIPT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><script>alert(1)</script><rect width="32" height="32"/></svg>';

test('Uploading a team logo: SVG accepted and visible everywhere, SVG with a script rejected with a message', async ({ page }) => {
  await open(page, '/team/NOVA');
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await page.getByTestId('settings-nav-teams').click();
  await page.locator('[data-testid="team-row"][data-key="NOVA"] .row-link').click();
  await expect(page).toHaveURL(/\/settings\/teams\/NOVA$/);

  await page.getByTestId('logo-file-light').setInputFiles({ name: 'nova.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SQUARE_SVG) });
  await expect(page.getByTestId('toast').filter({ hasText: 'Logo for Nova set' })).toBeVisible();
  await expect(page.getByTestId('logo-light')).toContainText('Set');
  await expect(page.getByTestId('logo-preview').locator('img')).toHaveCount(8);

  // Unsafe SVG: the server rejects it, the message shows at the field, the old logo stays.
  await page.getByTestId('logo-file-dark').setInputFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SCRIPT_SVG) });
  await expect(page.getByTestId('logo-error-dark')).toContainText('not allowed');
  await expect(page.getByTestId('logo-dark')).toContainText('Not set');

  // Visible in the sidebar and in cross-team rows.
  await page.getByTestId('settings-back').click();
  await open(page, '/all?group=none&order=created');
  await expect(page.getByTestId('nav-team-NOVA').locator('img')).toHaveCount(1);
  const novaRow = page.locator('[data-testid="issue-row"][data-key^="NOVA-"]').first();
  await expect(novaRow.locator('.p-team img')).toHaveCount(1);
  const src = (await novaRow.locator('.p-team img').getAttribute('src'))!;
  expect(src).toContain('/logo/');
  expect((await fetch(src)).headers.get('content-type')).toContain('image/svg+xml');

  // Remove: placeholder again
  await page.goto('/settings/teams/NOVA');
  await page.getByTestId('logo-remove-light').click();
  await expect(page.getByTestId('logo-light')).toContainText('Not set');
});

test('Create an agent key (shown once, with a command) and revoke it', async ({ page }) => {
  await page.goto('/settings/agents');
  await page.getByTestId('agent-add').click();
  await page.getByTestId('agent-name').fill('E2E key test');
  await page.getByTestId('agent-create').click();
  const dialog = page.getByTestId('agent-key-dialog');
  await expect(dialog).toBeVisible();
  const key = (await page.getByTestId('agent-key').textContent())!;
  expect(key).toMatch(/^xlr8_/);
  await expect(page.getByTestId('agent-command')).toHaveText(`claude mcp add --transport http xlr8 http://127.0.0.1:${BACKEND_PORT + 1}/mcp --header "Authorization: Bearer ${key}"`);

  const call = () =>
    fetch(`http://127.0.0.1:${BACKEND_PORT + 1}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_teams', arguments: {} } }),
    });
  expect((await call()).status).toBe(200);

  await page.getByTestId('agent-key-done').click();
  await expect(dialog).toHaveCount(0);
  // Afterwards only the prefix
  await expect(page.getByText(key)).toHaveCount(0);
  const row = page.locator('[data-testid="agent-row"][data-name="E2E key test"]');
  await expect(row).toContainText(key.slice(0, 8));
  await row.getByTestId('agent-revoke').click();
  await expect(page.getByTestId('agent-revoke-dialog')).toContainText('cannot be undone');
  await page.getByTestId('agent-revoke-confirm').click();
  await expect(row.getByTestId('agent-revoked')).toBeVisible();
  await settled(page);
  expect((await call()).status).toBe(401);
  // Ops: revoked but with calls today, so it stays under "Agents today".
  // Only once the dialog has left its history entry: otherwise its Back would run into page.goto.
  await expect(page.getByTestId('agent-revoke-dialog')).toHaveCount(0);
  await page.waitForFunction(() => !(history.state as { xlr8Overlay?: boolean } | null)?.xlr8Overlay);
  await page.goto('/settings/ops');
  const ops = page.locator('[data-testid="ops-agent"]').filter({ hasText: 'E2E key test' });
  await expect(ops).toHaveAttribute('data-revoked', 'true');
  await expect(ops).toContainText('revoked');
});

test('Create and pause a recurrence; "Repeat …" in an issue', async ({ page }) => {
  await page.goto('/settings/recurrences');
  await page.getByTestId('recurrence-add').click();
  await page.getByTestId('recurrence-title').fill('E2E weekly review');
  await page.getByTestId('recurrence-weekday').selectOption('5');
  await page.getByTestId('recurrence-create').click();
  const row = page.locator('[data-testid="recurrence-row"][data-title="E2E weekly review"]');
  await expect(row).toContainText('Every week on Friday');
  await row.getByTestId('recurrence-pause').click();
  await expect(row).toContainText('paused');
  await settled(page);
  const list = await backend().query(api.recurrences.list, {});
  expect(list.find((r) => r.title === 'E2E weekly review')).toMatchObject({ cadence: 'weekly', weekday: 5, active: false });

  // From an issue: the more menu or the command menu "Repeat …"
  await open(page, '/team/KITE/backlog');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail')).toBeVisible();
  const title = await page.getByTestId('detail-title').inputValue();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('repeat weekly');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'repeat');
  await page.keyboard.type('monthly 15');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast').filter({ hasText: 'repeats on day 15 of every month' })).toBeVisible();
  await settled(page);
  const after = await backend().query(api.recurrences.list, {});
  expect(after.find((r) => r.title === title && r.cadence === 'monthly')).toMatchObject({ monthDay: 15, active: true });
});

test('The ops page loads and explains the state', async ({ page }) => {
  await page.goto('/settings/ops');
  await expect(page.getByTestId('ops-page')).toBeVisible();
  await expect(page.getByTestId('ops-backup')).toBeVisible();
  await expect(page.getByTestId('ops-storage')).toContainText(/File storage: [\d.,]+ MB of 1 GB/);
  await expect(page.getByTestId('ops-health')).toContainText('Local test sign-in is active');
  await expect(page.getByTestId('ops-health')).toContainText('Test switches available');
  // Also reachable via the command menu
  await open(page, '/inbox');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Ops');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/ops$/);
});

test('Loading older comments (comments.page)', async ({ page }) => {
  const client = backend();
  const bucket = await client.query(api.issues.bucket, { bucket: 1 });
  const issue = bucket.find((i) => i.deletedAt === undefined)!;
  // More than 100 comments: the detail returns the newest 100, the rest loads on demand.
  await Promise.all(Array.from({ length: 105 }, (_, n) => client.mutation(api.comments.add, { issueId: issue._id, body: `E2E comment ${n}` })));
  const detail = (await client.query(api.issues.detail, { id: issue._id }))!;
  await page.goto(`/issue/${detail.identifier}`);
  await expect(page.getByTestId('comments-older')).toBeVisible();
  const before = await page.getByTestId('comment').count();
  await page.getByTestId('comments-older').click();
  await expect.poll(async () => await page.getByTestId('comment').count()).toBeGreaterThan(before);
});
