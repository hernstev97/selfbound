// Wiki: enable the area, create and write a page, reload, image, conflict with a second client,
// subpage by dragging, trash, deep link, G W. Test data only in team ORB.
import { expect, test, type Page } from '@playwright/test';
import { agentCall, api, backend, expectMarkdown, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

async function orb() {
  const meta = await backend().query(api.meta.get, {});
  return meta.teams.find((t) => t.key === 'ORB')!;
}

/** Wiki area for ORB (via the server) and a fresh page. */
async function freshPage(title: string, markdown = '', parentId?: string) {
  const team = await orb();
  if (!team.wiki) await backend().mutation(api.teams.update, { teamId: team._id, wiki: 'on' });
  const { articleId } = await backend().mutation(api.wiki.create, { teamId: team._id, title, markdown, ...(parentId ? { parentId: parentId as never } : {}) });
  return articleId;
}

const bodyOf = async (id: string) => (await backend().query(api.wiki.get, { id }))!.body;

async function openArticle(page: Page, id: string) {
  await page.goto(`/wiki/${id}`);
  await expect(page.getByTestId('article')).toHaveAttribute('data-id', id);
}

test('Enable, create a page, write title and text; still there after a reload', async ({ page }) => {
  // Fresh seed: ORB has no wiki yet (other tests may have enabled it before).
  const enabled = !!(await orb()).wiki;
  await page.goto('/team/ORB/wiki');
  if (!enabled) await page.getByTestId('wiki-enable').click();
  await expect(page.getByTestId('nav-team-ORB-wiki')).toBeVisible();
  // The wiki item comes before "Settings", which is last.
  await expect(page.getByTestId('current-team-nav').locator('.nav-item').last()).toContainText('Settings');

  await page.getByTestId('wiki-new').click();
  const title = page.getByTestId('article-title');
  await expect(title).toBeFocused();
  await page.keyboard.type('Test page basics');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('wiki-row').filter({ hasText: 'Test page basics' })).toBeVisible();

  await page.getByTestId('article-body').click();
  const editor = page.getByTestId('article-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.type('First paragraph from the test.');
  await expect(page.getByTestId('article-state')).toHaveText('Saved automatically', { timeout: 8000 });
  const id = (await page.getByTestId('article').getAttribute('data-id'))!;
  await expect.poll(async () => (await bodyOf(id)).markdown).toContain('First paragraph from the test.');

  await page.reload();
  await expect(page.getByTestId('article-body')).toContainText('First paragraph from the test.');
  await expect(title).toHaveValue('Test page basics');
  await expect(page).toHaveTitle(/Test page basics · Knowledge/);
});

test('Image via the button: uploaded and saved in the page text', async ({ page }) => {
  const id = await freshPage(`Images ${Date.now()}`, 'Before');
  await openArticle(page, id);
  await page.getByTestId('article-body').click();
  await expect(page.getByTestId('article-editor')).toBeFocused();
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    c.getContext('2d')!.fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('article-editor-wrap').getByTestId('image-button').click();
  await (await chooser).setFiles({ name: 'Sketch.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expectMarkdown(page.getByTestId('article-editor'), /!\[Sketch\]\(http:\/\/127\.0\.0\.1:\d+\/img\/[A-Za-z0-9_-]{43}\)/, 20_000);
  await expect.poll(async () => (await bodyOf(id)).markdown, { timeout: 8000 }).toMatch(/!\[Sketch\]\(http/);
});

test('Someone else changes the page while typing: notice, keep mine, nothing lost', async ({ page }) => {
  const id = await freshPage(`Conflict ${Date.now()}`, 'Initial');
  await openArticle(page, id);
  await page.getByTestId('article-body').click();
  const editor = page.getByTestId('article-editor');
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await page.keyboard.type('\n\nMy addition.');
  const body = await bodyOf(id);
  await backend().mutation(api.wiki.setBody, { id: id as never, markdown: 'Other text from the second client.', baseVersion: body.version });
  const banner = page.getByTestId('article-conflict');
  await expect(banner).toBeVisible();
  await expectMarkdown(editor, /My addition\./);
  await page.getByTestId('article-keep-mine').click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await bodyOf(id)).markdown, { timeout: 8000 }).toContain('My addition.');
});

test('Nest a subpage by dragging; a deep link opens it with its path', async ({ page }) => {
  const stamp = Date.now();
  const parent = await freshPage(`Upper ${stamp}`);
  const child = await freshPage(`Lower ${stamp}`);
  await openArticle(page, parent);
  const source = page.getByTestId('wiki-row').filter({ hasText: `Lower ${stamp}` });
  const target = page.getByTestId('wiki-row').filter({ hasText: `Upper ${stamp}` });
  await source.dragTo(target);
  await expect.poll(async () => (await backend().query(api.wiki.get, { id: child }))!.article.parentId).toBe(parent);
  await expect(source).toHaveAttribute('aria-level', '2');

  await page.goto(`/wiki/${child}`);
  await expect(page.getByTestId('article-title')).toHaveValue(`Lower ${stamp}`);
  await expect(page.getByTestId('location-bar')).toContainText(`Upper ${stamp}`);
  await expect(page.getByTestId('nav-team-ORB-wiki')).toHaveClass(/active/);
});

test('Delete with a subpage, restore from the trash', async ({ page }) => {
  const stamp = Date.now();
  const parent = await freshPage(`Gone ${stamp}`);
  await freshPage(`Gone-child ${stamp}`, '', parent);
  await openArticle(page, parent);
  await page.getByTestId('article-remove').click();
  await expect(page).toHaveURL(/\/team\/ORB\/wiki$/);
  await expect(page.getByTestId('wiki-row').filter({ hasText: `Gone ${stamp}` })).toHaveCount(0);
  await page.getByTestId('wiki-trash').click();
  const entry = page.getByTestId('wiki-trash-row').filter({ hasText: `Gone ${stamp}` });
  await expect(entry).toContainText('with 1 subpage');
  await entry.getByTestId('wiki-restore').click();
  await expect(entry).toHaveCount(0);
  await expect(page.getByTestId('wiki-row').filter({ hasText: `Gone ${stamp}` })).toBeVisible();
});

test('G W opens the current team\'s wiki; status keys hit no issue there', async ({ page }) => {
  await freshPage(`Key ${Date.now()}`);
  await page.goto('/team/ORB');
  await expect(page.locator('[data-testid="issue-row"]').first()).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('w');
  await expect(page).toHaveURL(/\/team\/ORB\/wiki$/);
  await expect(page.getByTestId('wiki-page')).toBeVisible();
  // On the wiki page "s" (status) affects nothing: no status picker.
  await page.mouse.click(900, 600);
  await page.keyboard.press('s');
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

test('Search (/) finds pages in the wiki section; an agent creates and appends via MCP', async ({ page }) => {
  await freshPage(`Placeholder ${Date.now()}`);
  const stamp = Date.now();
  const created = await agentCall('create_article', {
    requestId: `e2e-wiki-${stamp}`,
    team: 'ORB',
    title: `Agent page ${stamp}`,
    markdown: 'First finding: amberchamber.',
    sources: [{ url: 'https://example.org/source', title: 'Test source' }],
  });
  const id = (JSON.parse(created!.content![0]!.text) as { id: string }).id;
  await agentCall('update_article', { requestId: `e2e-wiki-${stamp}-2`, id, append: 'Second finding.' });
  await page.goto('/team/ORB');
  await expect(page.locator('[data-testid="issue-row"]').first()).toBeVisible();
  await page.keyboard.press('/');
  await page.keyboard.type('amberchamber');
  const hit = page.getByTestId('palette').getByText(`Agent page ${stamp}`);
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${id}$`));
  await expect(page.getByTestId('article-body')).toContainText('Second finding.');
  await expect(page.getByTestId('article-meta')).toContainText('E2E-Agent');
  await expect(page.getByTestId('article-sources')).toContainText('Test source');
});
