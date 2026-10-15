// UI regression tests: focus in the create dialog, pickers above the dialog, multi-word search in
// descriptions, task lists, relations with undo.
import { expect, test } from '@playwright/test';
import { api, backend, expectMarkdown, focusedRow, open, resolve, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('Create: title, Tab, type the description (keyboard.type); the focus does not jump back', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.keyboard.press('c');
  const title = page.getByTestId('create-title');
  const desc = page.getByTestId('create-description');
  await expect(title).toBeFocused();
  await page.keyboard.type('E2E typed title');
  await page.keyboard.press('Tab');
  await expect(desc).toBeFocused();
  await page.keyboard.type('First line of the description, key by key.');
  await expect(desc).toBeFocused();
  await expect(title).toHaveValue('E2E typed title');
  await expectMarkdown(desc, 'First line of the description, key by key.');
  await page.getByTestId('create-discard').click();
});

test('A picker in the create dialog lies above the dialog; after choosing, focus returns to the chip', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.keyboard.press('c');
  await page.keyboard.type('E2E with parent');
  await page.getByTestId('create-parent').click();
  const input = page.getByTestId('palette-input');
  await expect(input).toBeFocused();
  // Nothing covers the search field (the dialog used to lie on top).
  const box = (await input.boundingBox())!;
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), [box.x + box.width / 2, box.y + box.height / 2]);
  expect(top).toBe('palette-input');
  // With a query the match is active, not "No parent"; Enter sets it.
  await page.keyboard.type('ORB-1');
  await expect(page.locator('[data-testid="palette-item"].active')).toHaveAttribute('data-id', /^i:/);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('create-parent')).toContainText('ORB-1');
  await expect(page.getByTestId('create-parent')).toBeFocused();
  // Same via another chip.
  await page.getByTestId('create-priority').click();
  await page.keyboard.type('high');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('create-priority')).toContainText('High');
  await expect(page.getByTestId('create-priority')).toBeFocused();
  await expect(page.getByTestId('create-title')).toHaveValue('E2E with parent');
  await page.getByTestId('create-discard').click();
});

test('Search: several words from a description find the issue', async ({ page }) => {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const created = await client.mutation(api.issues.create, {
    issues: [{ teamId: team._id, title: 'E2E full text', description: 'The font flickers briefly on first opening the view.' }],
  });
  await open(page, '/all');
  await page.keyboard.press('/');
  await page.keyboard.type('flickers briefly on first');
  const hit = page.getByTestId('palette-item').filter({ hasText: 'E2E full text' });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('flickers briefly on first');
  await page.keyboard.press('Escape');
  await client.mutation(api.issues.remove, { ids: [created.issues[0].id] });
});

test('Markdown: task list as checkboxes, clickable in the view (without the editor)', async ({ page }) => {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const created = await client.mutation(api.issues.create, { issues: [{ teamId: team._id, title: 'E2E tasks', description: '- [ ] Open\n- [x] Done\n\n<input type="text" value="gone">' }] });
  await page.goto(`/issue/${created.issues[0].identifier}`);
  const boxes = page.getByTestId('detail-description').locator('input');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toHaveAttribute('type', 'checkbox');
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  // Clicking saves the description without switching to the editor.
  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  const id = created.issues[0].id;
  await expect.poll(async () => (await client.query(api.issues.detail, { id }))!.body.markdown).toBe('- [x] Open\n- [x] Done\n\n<input type="text" value="gone">');
  await client.mutation(api.issues.remove, { ids: [created.issues[0].id] });
});

test('"Related to …" creates a related relation (not a duplicate), Ctrl Z reverts it', async ({ page }) => {
  await open(page, '/team/ORB?group=none&order=created');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  const status = await focusedRow(page).getAttribute('data-status');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Related to');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'relation');
  await page.keyboard.type('ORB-2');
  await page.keyboard.press('Enter');
  await settled(page);
  const id = (await resolve(key))!.id;
  const client = backend();
  const relations = async () => (await client.query(api.issues.detail, { id }))!.relations.map((r) => r.type);
  await expect.poll(relations).toContain('related');
  expect(await relations()).not.toContain('duplicate');
  await expect(focusedRow(page)).toHaveAttribute('data-status', status!);
  await page.keyboard.press('Control+z');
  await settled(page);
  await expect.poll(relations).not.toContain('related');
});

test('Triage 2: duplicate with a typed identifier, suggestions without input; Ctrl Z reverts status and relation', async ({ page }) => {
  await open(page, '/triage');
  const id = (await focusedRow(page).getAttribute('data-id'))!;
  const status = (await focusedRow(page).getAttribute('data-status'))!;
  const other = (await page.getByTestId('issue-row').nth(1).getAttribute('data-key'))!;
  await page.keyboard.press('2');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'duplicate');
  // Without input: suggestions instead of "No results".
  await expect(page.getByTestId('palette-empty')).toHaveCount(0);
  await expect(page.getByTestId('palette-item').first()).toBeVisible();
  await page.keyboard.type(other);
  await expect(page.locator('[data-testid="palette-item"].active')).toContainText(other);
  await page.keyboard.press('Enter');
  await settled(page);
  const client = backend();
  const detail = async () => (await client.query(api.issues.detail, { id: id as never }))!;
  await expect.poll(async () => (await detail()).relations.map((r) => r.type)).toEqual(['duplicate']);
  const statusOf = async () => (await Promise.all(Array.from({ length: 32 }, (_, bucket) => bucket).map((bucket) => client.query(api.issues.bucket, { bucket })))).flat().find((i) => i._id === id)?.status;
  await expect.poll(statusOf).toBe('duplicate');
  await page.keyboard.press('Control+z');
  await settled(page);
  await expect.poll(async () => (await detail()).relations.length).toBe(0);
  await expect.poll(statusOf).toBe(status);
});

test('Labels: after Enter the query is empty, the next search starts fresh', async ({ page }) => {
  await open(page, '/team/ORB?group=none&order=created');
  await page.keyboard.press('l');
  const input = page.getByTestId('palette-input');
  await page.keyboard.type('bug');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('');
  await page.keyboard.type('doc');
  await expect(input).toHaveValue('doc');
  await page.keyboard.press('Escape');
});

test('The "Undo" toast disappears after Ctrl Z (no stale step)', async ({ page }) => {
  await open(page, '/team/ORB?group=none&order=created');
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+j');
  await page.keyboard.press('Shift+e');
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  const toast = page.getByTestId('toast').filter({ hasText: '2 issues changed' });
  await expect(toast).toBeVisible();
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(toast).toHaveCount(0);
});

test('A comment draft survives navigating away', async ({ page }) => {
  await open(page, '/team/ORB?group=none&order=created');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail')).toBeVisible();
  await page.getByTestId('comment-input').click();
  await page.keyboard.type('Not sent yet');
  await page.goBack();
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
  await page.goForward();
  await expectMarkdown(page.getByTestId('comment-input'), 'Not sent yet');
  await page.getByTestId('comment-input').fill('');
});
