// Detail: deep link, comments, description with conflict, copying, pickers in the properties column.
import { expect, test } from '@playwright/test';
import { api, backend, expectMarkdown, focusedRow, open, resolve, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('Deep link /issue/XXX-n; a reload lands in the same place', async ({ page }) => {
  await open(page, '/team/KITE');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  await page.goto(`/issue/${key}`);
  await expect(page.getByTestId('detail-key')).toHaveText(key);
  await page.reload();
  await expect(page.getByTestId('detail-key')).toHaveText(key);
  await expect(page.getByTestId('activity')).toBeVisible();
});

test('An old identifier (PIX-n) redirects to the issue', async ({ page }) => {
  const hit = await backend().query(api.issues.resolve, { identifier: 'PIX-1' });
  test.skip(!hit, 'No alias in the dataset');
  await page.goto('/issue/PIX-1');
  await expect(page.getByTestId('detail-key')).toHaveText(hit!.identifier);
  await expect(page).toHaveURL(new RegExp(`/issue/${hit!.identifier}$`));
});

test('An unknown identifier shows a clear notice', async ({ page }) => {
  await page.goto('/issue/ORB-99999');
  await expect(page.getByTestId('detail-missing')).toContainText('ORB-99999 does not exist');
});

test('Writing a comment (Ctrl Enter) survives a reload', async ({ page }) => {
  await open(page, '/team/FLUX');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail')).toBeVisible();
  await page.getByTestId('comment-input').fill('E2E comment with **bold**');
  await page.getByTestId('comment-input').press('Control+Enter');
  const comment = page.getByTestId('comment').filter({ hasText: 'E2E comment with' });
  await expect(comment).toBeVisible();
  await expect(comment.locator('strong')).toHaveText('bold');
  await settled(page);
  await page.reload();
  await expect(page.getByTestId('comment').filter({ hasText: 'E2E comment with' })).toBeVisible();
  // Edit and delete
  const again = page.getByTestId('comment').filter({ hasText: 'E2E comment with' });
  await again.hover();
  await again.getByTestId('comment-edit').click();
  await page.getByTestId('comment-edit-input').fill('E2E comment changed');
  await page.getByTestId('comment-edit-input').press('Control+Enter');
  await expect(page.getByTestId('comment').filter({ hasText: 'E2E comment changed' })).toContainText('edited');
  const edited = page.getByTestId('comment').filter({ hasText: 'E2E comment changed' });
  await edited.hover();
  await edited.getByTestId('comment-delete').click();
  await edited.getByTestId('comment-delete-confirm').click();
  await expect(page.getByTestId('comment').filter({ hasText: 'E2E comment changed' })).toHaveCount(0);
});

test('Description: someone else changes it while typing → notice, keep mine, nothing lost', async ({ page }) => {
  await open(page, '/team/MOSAIK');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-description')).toBeVisible();
  const hit = (await resolve(key))!;
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  await page.getByTestId('detail-description').click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await page.keyboard.type('\n\nMy addition from the test.');
  // A second client (like an agent) writes at the same time.
  const client = backend();
  const doc = (await client.query(api.issues.detail, { id: hit.id }))!;
  await client.mutation(api.issues.setDescription, { id: hit.id, markdown: 'Other text from the second client.', baseVersion: doc.body.version });
  const banner = page.getByTestId('desc-conflict');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Your text is not lost');
  await expectMarkdown(editor, /My addition from the test\./);
  await page.getByTestId('desc-keep-mine').click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await client.query(api.issues.detail, { id: hit.id }))!.body.markdown, { timeout: 8000 }).toContain('My addition from the test.');
  await page.getByTestId('desc-done').click();
  await expect(page.getByTestId('detail-description')).toContainText('My addition from the test.');
});

test('Description: take theirs', async ({ page }) => {
  await open(page, '/team/MOSAIK');
  await page.keyboard.press('j');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  await page.keyboard.press('Enter');
  const hit = (await resolve(key))!;
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  await page.getByTestId('detail-description').click();
  // The editor loads on first edit; type only after that.
  await expect(page.getByTestId('desc-editor')).toBeFocused();
  await page.keyboard.type('Gets discarded ');
  const client = backend();
  const doc = (await client.query(api.issues.detail, { id: hit.id }))!;
  // Unique, so their version surely differs from the starting version.
  const theirs = `Valid now (${Date.now()}).`;
  await client.mutation(api.issues.setDescription, { id: hit.id, markdown: theirs, baseVersion: doc.body.version });
  await expect(page.getByTestId('desc-conflict')).toBeVisible();
  await page.getByTestId('desc-take-theirs').click();
  await expectMarkdown(page.getByTestId('desc-editor'), theirs);
});

test('Edit the title inline and set a property from the column', async ({ page }) => {
  await open(page, '/team/ORB');
  await page.keyboard.press('Enter');
  const title = page.getByTestId('detail-title');
  await title.click();
  await title.fill('E2E renamed');
  await title.press('Enter');
  await page.getByTestId('detail-priority').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'priority');
  await page.keyboard.type('urg');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-priority')).toContainText('Urgent');
  await page.getByTestId('detail-due').click();
  await page.keyboard.type('tomorrow');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-due')).not.toContainText('Set due date');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-row').filter({ hasText: 'E2E renamed' })).toHaveAttribute('data-priority', '1');
});

test('Copy branch name (Ctrl Shift .) and copy link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, '/team/PX');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-key')).toHaveText(key);
  await page.keyboard.press('Control+Shift+Period');
  await expect(page.getByTestId('toast').filter({ hasText: 'Branch name copied' })).toBeVisible();
  const branch = await page.evaluate(() => navigator.clipboard.readText());
  expect(branch).toMatch(new RegExp(`^${key.toLowerCase()}-[a-z0-9-]+$`));
  await page.getByTestId('copy-link').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Link copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/issue/${key}$`));
});

test('Create a sub-issue from the detail view', async ({ page }) => {
  await open(page, '/team/KITE');
  await page.keyboard.press('Enter');
  const parentKey = (await page.getByTestId('detail-key').textContent())!;
  await page.getByTestId('add-subissue').click();
  await expect(page.getByTestId('create-dialog')).toContainText(`Sub-issue of ${parentKey}`);
  await page.keyboard.type('E2E subtask');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('subissues')).toContainText('E2E subtask');
});
