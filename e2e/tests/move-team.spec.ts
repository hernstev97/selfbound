// Move to team: Ctrl Shift M, confirmation listing what gets lost, several issues.
import { expect, test } from '@playwright/test';
import { api, backend, open, resolve, row, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

async function fresh(title: string, withProject: boolean) {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  let projectId = meta.projects.find((p) => p.teamId === team._id)?._id;
  if (!projectId) projectId = (await backend().mutation(api.projects.create, { teamId: team._id, name: 'Move test' })).projectId;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, status: 'todo', ...(withProject ? { projectId } : {}) }] });
  return issues[0];
}

test('Detail page: team in the properties, confirmation names the project, new identifier, the old one stays valid', async ({ page }) => {
  const issue = await fresh(`Move ${Date.now()}`, true);
  await open(page, `/issue/${issue.identifier}`);
  await page.getByTestId('detail-team').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'team');
  await page.getByTestId('palette-item').filter({ hasText: 'PX' }).click();
  await expect(page.getByTestId('palette-item').first()).toContainText('Move to Pixelworks');
  await expect(page.locator('.palette-hint')).toContainText('Project');
  await expect(page.locator('.palette-hint')).toContainText(`${issue.identifier} stays valid as a link`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: test.info().outputPath('confirmation.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-key')).toHaveText(/^PX-\d+$/);
  await expect(page.getByTestId('toast').filter({ hasText: `${issue.identifier} is now` })).toBeVisible();
  await settled(page);
  const moved = await resolve(issue.identifier);
  expect(moved?.identifier).toMatch(/^PX-/);
});

test('List: Ctrl Shift M moves the selection; without losses right away, Back in the confirmation', async ({ page }) => {
  const a = await fresh(`Move A ${Date.now()}`, false);
  const b = await fresh(`Move B ${Date.now()}`, true);
  await open(page, '/team/ORB?group=none&order=created');
  await row(page, a.id).hover();
  await page.keyboard.press('Control+Shift+m');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'team');
  await expect(page.getByTestId('palette-target')).toHaveText(a.identifier);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);

  // Select two issues, one with a project: one confirmation for both.
  await row(page, a.id).hover();
  await page.keyboard.press('x');
  await row(page, b.id).hover();
  await page.keyboard.press('x');
  await page.keyboard.press('Control+Shift+m');
  await expect(page.getByTestId('palette-target')).toHaveText('2 issues');
  await page.getByTestId('palette-item').filter({ hasText: 'PX' }).click();
  await expect(page.getByTestId('palette-item').first()).toContainText('Move 2 issues to Pixelworks');
  await page.waitForTimeout(600);
  await page.screenshot({ path: test.info().outputPath('list-selection.png') });
  await page.locator('.palette-parent').click();
  await expect(page.locator('[data-id="mvc:ok"]')).toHaveCount(0);
  await page.getByTestId('palette-item').filter({ hasText: 'PX' }).click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast').filter({ hasText: '2 issues moved' })).toBeVisible();
  await settled(page);
  expect((await resolve(a.identifier))?.identifier).toMatch(/^PX-/);
  expect((await resolve(b.identifier))?.identifier).toMatch(/^PX-/);
});
