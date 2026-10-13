// Wiki: project and topics on a page, filters in the tree, editing sources, viewing and restoring
// earlier revisions, page count per project. Test data only in team ORB.
import { expect, test } from '@playwright/test';
import { agentCall, api, backend, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

async function orbPage(title: string, markdown = '') {
  const client = backend();
  const team = (await client.query(api.meta.get, {})).teams.find((t) => t.key === 'ORB')!;
  if (!team.wiki) await client.mutation(api.teams.update, { teamId: team._id, wiki: 'on' });
  const { articleId } = await client.mutation(api.wiki.create, { teamId: team._id, title, markdown });
  return articleId;
}

test('Set project and topic, filter the tree by topic, page count in the project overview', async ({ page }) => {
  const stamp = Date.now();
  const id = await orbPage(`Topic page ${stamp}`);
  await orbPage(`Other ${stamp}`);
  // The old German path still works and redirects to /wiki/<id>.
  await page.goto(`/wissen/${id}`);
  await expect(page.getByTestId('article')).toHaveAttribute('data-id', id);
  await expect(page).toHaveURL(new RegExp(`/wiki/${id}$`));
  const meta = await backend().query(api.meta.get, {});
  const project = meta.projects.find((p) => p.teamId === meta.teams.find((t) => t.key === 'ORB')!._id)!;
  await page.getByTestId('article-project').selectOption(project._id);
  await page.getByTestId('article-topics').click();
  await page.getByTestId('topic-input').fill(`Topic ${stamp}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('article-topic')).toHaveText(`Topic ${stamp}`);
  await expect.poll(async () => (await backend().query(api.wiki.get, { id }))!.article.projectId).toBe(project._id);

  // Filter by topic: only this page in the tree.
  await page.mouse.click(5, 880);
  const topicId = (await backend().query(api.wiki.get, { id }))!.article.topicIds[0]!;
  await page.getByTestId('wiki-filter-topic').selectOption(topicId);
  await expect(page.getByTestId('wiki-row')).toHaveText([`Topic page ${stamp}`]);
  await page.getByTestId('wiki-filter-topic').selectOption('');
  await expect(page.getByTestId('wiki-row').filter({ hasText: `Other ${stamp}` })).toBeVisible();

  // The project overview lists the pages and leads into the wiki, filtered.
  await page.goto('/team/ORB/projects');
  const link = page.getByTestId('project-pages').first();
  await expect(link).toContainText('page');
  await link.click();
  await expect(page).toHaveURL(/\/team\/ORB\/wiki$/);
  await expect(page.getByTestId('wiki-filter-project')).toHaveValue(project._id);
});

test('Sources: add, edit, reorder, remove', async ({ page }) => {
  const id = await orbPage(`Sources page ${Date.now()}`);
  await page.goto(`/wiki/${id}`);
  await page.getByTestId('source-add').click();
  await page.getByTestId('source-url').fill('https://example.org/one');
  await page.getByTestId('source-title').fill('First source');
  await page.getByTestId('source-published').fill('2025-03');
  await page.getByTestId('source-save').click();
  await page.getByTestId('source-add').click();
  await page.getByTestId('source-title').fill('Second book');
  await page.getByTestId('source-author').fill('Test Author');
  await page.getByTestId('source-save').click();
  const sources = page.getByTestId('source');
  await expect(sources).toHaveCount(2);
  await expect(sources.nth(0)).toContainText('2025-03');
  await sources.nth(1).hover();
  await sources.nth(1).getByLabel('Move up').click();
  await expect(sources.nth(0)).toContainText('Second book');
  await sources.nth(0).hover();
  await sources.nth(0).getByTestId('source-edit').click();
  await page.getByTestId('source-note').fill('Supports section 2');
  await page.getByTestId('source-save').click();
  await expect(sources.nth(0)).toContainText('Supports section 2');
  await sources.nth(1).hover();
  await sources.nth(1).getByTestId('source-remove').click();
  await expect(sources).toHaveCount(1);
  expect((await backend().query(api.wiki.get, { id }))!.sources.map((s) => s.title)).toEqual(['Second book']);
});

test('View and restore an earlier revision', async ({ page }) => {
  const stamp = Date.now();
  const id = await orbPage(`Revisions page ${stamp}`, 'Original text.');
  const version = (await backend().query(api.wiki.get, { id }))!.body.version;
  // An agent overwrites it: the old text is kept as a revision.
  await agentCall('update_article', { requestId: `e2e-rev-${stamp}`, id, markdown: 'Replaced by the agent.', expectedVersion: version });
  await page.goto(`/wiki/${id}`);
  await expect(page.getByTestId('article-body')).toContainText('Replaced by the agent.');
  await page.getByTestId('article-revisions-toggle').click();
  await page.getByTestId('revision-row').first().click();
  await expect(page.getByTestId('revision-preview')).toContainText('Original text.');
  await page.getByTestId('revision-restore').click();
  await expect(page.getByTestId('article-body')).toContainText('Original text.');
  // The replaced text is now a revision itself.
  await expect(page.getByTestId('revision-row')).toHaveCount(2);
});
