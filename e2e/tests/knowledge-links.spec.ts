// Wiki: linking pages and issues. A "Wiki" section on the issue, "Mentioned in" on the page, links
// open inside the app without a reload, bare identifiers become links, "[[" in the editor.
import { expect, test } from '@playwright/test';
import { APP_URL } from '../playwright.config.ts';
import { api, backend, expectMarkdown, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

async function setupLinks() {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  if (!team.wiki) await client.mutation(api.teams.update, { teamId: team._id, wiki: 'on' });
  const stamp = Date.now();
  const { articleId } = await client.mutation(api.wiki.create, { teamId: team._id, title: `Reference page ${stamp}`, markdown: 'Initial content' });
  const { issues } = await client.mutation(api.issues.create, {
    issues: [{ teamId: team._id, title: `With docs ${stamp}`, description: `See [reference page](${APP_URL}/wiki/${articleId}) for details.` }],
  });
  await client.mutation(api.wiki.setBody, { id: articleId, markdown: `Concerns ${issues[0].identifier} and UTF-8.`, baseVersion: 1 });
  return { articleId, issue: issues[0], stamp };
}

test('The issue shows "Wiki"; clicking the link opens the page in the app; there "Mentioned in" and the identifier as a link', async ({ page }) => {
  const { articleId, issue, stamp } = await setupLinks();
  await page.goto(`/issue/${issue.identifier}`);
  await expect(page.getByTestId('issue-knowledge')).toContainText(`Reference page ${stamp}`);
  // Marker on the window: a reload would clear it.
  await page.evaluate(() => ((window as unknown as { __stay: boolean }).__stay = true));
  const chip = page.getByTestId('detail-description').locator('a.xlink-wiki');
  await expect(chip).toHaveAttribute('href', `/wiki/${articleId}`);
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${articleId}$`));
  await expect(page.getByTestId('article-mentioned-in')).toContainText(issue.identifier);
  expect(await page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
  // "ORB-n" in the text is a link, "UTF-8" is not.
  const ref = page.getByTestId('article-body').locator('a.xlink-issue');
  await expect(ref).toHaveText(issue.identifier);
  await expect(page.getByTestId('article-body').locator('a')).toHaveCount(1);
  await ref.click();
  await expect(page).toHaveURL(new RegExp(`/issue/${issue.identifier}$`));
  expect(await page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
});

test('"[[" in the editor: search a page, Enter inserts the link and saves', async ({ page }) => {
  const { stamp } = await setupLinks();
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { articleId } = await backend().mutation(api.wiki.create, { teamId: team._id, title: `Writing page ${stamp}`, markdown: 'Text' });
  await page.goto(`/wiki/${articleId}`);
  await page.getByTestId('article-body').click();
  const editor = page.getByTestId('article-editor');
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await page.keyboard.type(' [[');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'article');
  await page.keyboard.type(`Reference page ${stamp}`);
  await expect(page.getByTestId('palette').getByText(`Reference page ${stamp}`)).toBeVisible();
  await page.keyboard.press('Enter');
  await expectMarkdown(editor, new RegExp(`\\[Reference page ${stamp}\\]\\(${APP_URL.replace(/[\\^$.*+?()[\]{}|/:]/g, '\\$&')}/wiki/[a-z0-9]+\\)`));
  await expect.poll(async () => (await backend().query(api.wiki.get, { id: articleId }))!.body.markdown, { timeout: 8000 }).toContain(`[Reference page ${stamp}]`);
});
