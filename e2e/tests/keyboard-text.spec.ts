// Keyboard and undo: editing a description and a wiki page text without a mouse, × in the create
// dialog keeps the draft, "Discard" with undo.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, expectMarkdown, open, settled } from '../support/helpers.ts';

/** Cleanup after the test, even if it fails. */
const cleanups: (() => Promise<void>)[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  for (const run of cleanups.splice(0)) await run();
});

async function freshIssue(title: string, description: string) {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const created = await client.mutation(api.issues.create, { issues: [{ teamId: team._id, title, description }] });
  return created.issues[0];
}

const bodyOfIssue = async (id: string) => (await backend().query(api.issues.detail, { id: id as never }))!.body.markdown;

/** Presses Tab until the element has focus (at most `max` steps). */
async function tabTo(page: Page, testid: string, max = 30) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testid)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`${testid} not reached by Tab`);
}

test('Description: Tab, Enter, type, Esc saves; focus back on the view, E edits at the end', async ({ page }) => {
  const issue = await freshIssue('E2E keyboard description', 'First line.');
  await page.goto(`/issue/${issue.identifier}`);
  const view = page.getByTestId('detail-description');
  await expect(view).toContainText('First line.');
  await expect(view).toHaveAttribute('role', 'group');
  await expect(view).toHaveAccessibleName('Description');
  await expect(view).toHaveAccessibleDescription(/Press Enter or E to edit/);

  await page.getByTestId('detail-title').focus();
  await tabTo(page, 'detail-description');
  await page.keyboard.press('Enter');
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  // Cursor at the end: typed text is appended.
  await page.keyboard.type(' By keyboard.');
  await page.keyboard.press('Escape');
  await expect(view).toBeFocused();
  await expect(view).toContainText('First line. By keyboard.');
  await expect.poll(() => bodyOfIssue(issue.id)).toBe('First line. By keyboard.');

  // Focus is on the view: E edits again, also at the end.
  await page.keyboard.press('e');
  await expect(editor).toBeFocused();
  await page.keyboard.type(' With E.');
  await expectMarkdown(editor, 'First line. By keyboard. With E.');
  await page.getByTestId('desc-done').click();
  await expect(view).toBeFocused();
  await expect.poll(() => bodyOfIssue(issue.id)).toBe('First line. By keyboard. With E.');
  await backend().mutation(api.issues.remove, { ids: [issue.id] });
});

test('Description: E from anywhere on the page; "Edit description" in the command menu; Space starts editing too', async ({ page }) => {
  const issue = await freshIssue('E2E key E', 'Text.');
  await page.goto(`/issue/${issue.identifier}`);
  await expect(page.getByTestId('detail-description')).toContainText('Text.');
  await page.keyboard.press('e');
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  // The E itself does not end up in the text.
  await expectMarkdown(editor, 'Text.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('detail-description')).toBeFocused();

  await page.keyboard.press('Space');
  await expect(editor).toBeFocused();
  await expectMarkdown(editor, 'Text.');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await page.keyboard.type('Edit description');
  const item = page.getByTestId('palette-item').filter({ hasText: 'Edit description' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('E');
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await page.keyboard.type(' From the menu.');
  await page.keyboard.press('Escape');
  await expect.poll(() => bodyOfIssue(issue.id)).toBe('Text. From the menu.');
  await backend().mutation(api.issues.remove, { ids: [issue.id] });
});

test('Description: checkboxes and links in the view keep click and key behaviour, without editing', async ({ page }) => {
  const issue = await freshIssue('E2E checkbox and link', '- [ ] Open\n\nSee [ORB-1](/issue/ORB-1).');
  await page.goto(`/issue/${issue.identifier}`);
  const view = page.getByTestId('detail-description');
  const box = view.getByTestId('task-box');
  await expect(box).toBeVisible();
  // Space on the checkbox: checked, no editor.
  await box.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => bodyOfIssue(issue.id)).toBe('- [x] Open\n\nSee [ORB-1](/issue/ORB-1).');
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  // A click on the checkbox too.
  await box.click();
  await expect.poll(() => bodyOfIssue(issue.id)).toBe('- [ ] Open\n\nSee [ORB-1](/issue/ORB-1).');
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  // Enter on the link follows the link (inside the app) instead of editing.
  await view.locator('a').first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/issue\/ORB-1$/);
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  await backend().mutation(api.issues.remove, { ids: [issue.id] });
});

test('Wiki page: E edits at the end, Esc saves and leaves the focus on the text; Tab and Enter too', async ({ page }) => {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const wikiBefore = team.wiki ?? null;
  if (!wikiBefore) await backend().mutation(api.teams.update, { teamId: team._id, wiki: 'on' });
  const { articleId } = await backend().mutation(api.wiki.create, { teamId: team._id, title: 'E2E keyboard page', markdown: 'Start.' });
  // Clean up even on failure: page to the trash, wiki setting as before.
  cleanups.push(async () => {
    await backend().mutation(api.wiki.remove, { id: articleId as never });
    if (!wikiBefore) await backend().mutation(api.teams.update, { teamId: team._id, wiki: null });
  });
  const bodyOf = async () => (await backend().query(api.wiki.get, { id: articleId }))!.body.markdown;
  await page.goto(`/wiki/${articleId}`);
  const view = page.getByTestId('article-body');
  await expect(view).toContainText('Start.');
  await expect(view).toHaveAccessibleName('Page text');

  await page.keyboard.press('e');
  const editor = page.getByTestId('article-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.type(' With E.');
  await page.keyboard.press('Escape');
  await expect(view).toBeFocused();
  await expect.poll(bodyOf).toBe('Start. With E.');

  await page.getByTestId('article-title').focus();
  await tabTo(page, 'article-body');
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await page.keyboard.type(' With Enter.');
  await page.keyboard.press('Escape');
  await expect(view).toBeFocused();
  await expect.poll(bodyOf).toBe('Start. With E. With Enter.');
});

test('Create: × closes and keeps the draft (like Esc)', async ({ page }) => {
  await open(page, '/all');
  await page.keyboard.press('c');
  await page.keyboard.type('E2E stays on close');
  await page.getByTestId('create-close').click();
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved as draft' })).toBeVisible();
  await page.getByTestId('nav-drafts').click();
  const draft = page.getByTestId('draft-row').filter({ hasText: 'E2E stays on close' });
  await expect(draft).toBeVisible();
  await draft.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('create-title')).toHaveValue('E2E stays on close');
  await page.getByTestId('create-discard').click();
  await expect(page.getByTestId('draft-row').filter({ hasText: 'E2E stays on close' })).toHaveCount(0);
});

test('Create: Discard in the footer, undo restores the dialog with its content; empty without a toast', async ({ page }) => {
  await open(page, '/all');
  await page.keyboard.press('c');
  await page.getByTestId('create-discard').click();
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);

  await page.keyboard.press('c');
  await page.keyboard.type('E2E almost discarded');
  await page.keyboard.press('Tab');
  await page.keyboard.type('With a description.');
  await expectMarkdown(page.getByTestId('create-description'), 'With a description.');
  await page.getByTestId('create-discard').click();
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  const toast = page.getByTestId('toast').filter({ hasText: 'Draft discarded' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  await expect(page.getByTestId('create-title')).toHaveValue('E2E almost discarded');
  await expect(page.getByTestId('create-title')).toBeFocused();
  await expectMarkdown(page.getByTestId('create-description'), 'With a description.');
  await page.keyboard.press('Control+Enter');
  const created = page.getByTestId('issue-row').filter({ hasText: 'E2E almost discarded' });
  await expect(created).toHaveCount(1);
  // Cleanup: other specs count rows.
  await settled(page);
  const id = await created.getAttribute('data-id');
  await backend().mutation(api.issues.remove, { ids: [id as never] });
});
