// Pull requests in Selfbound: list on the issue, PR next to the issue, full view.
// The sample PRs come from backend/data/pullRequests.ts (local backend without a GitHub token:
// reading works, actions are hidden, see "not set up").
import { expect, test } from '@playwright/test';
import { generateDataset } from '../../backend/data/generate.ts';
import { samplePullRequests } from '../../backend/data/pullRequests.ts';
import { open } from '../support/helpers.ts';

const data = generateDataset('small');
const samples = samplePullRequests(data.issues, Date.now());
const keyOf = (seq: number) => {
  const issue = data.issues.find((i) => i.seq === seq)!;
  return `${issue.teamKey}-${issue.number}`;
};
const twoPrs = keyOf(samples[0]!.issueSeqs[0]!);

test('An issue shows its PRs with state and checks; a click opens the PR alongside, Esc closes it', async ({ page }) => {
  await open(page, `/issue/${twoPrs}`);
  const list = page.getByTestId('issue-prs');
  await expect(list.getByTestId('issue-pr')).toHaveCount(2);
  const open128 = list.getByTestId('issue-pr').filter({ hasText: '#128' });
  await expect(open128).toContainText('Open');
  await expect(open128.locator('.pr-dot.failure')).toBeVisible();
  await expect(list.getByTestId('issue-pr').filter({ hasText: '#121' })).toContainText('Merged');

  await open128.locator('.pr-row-main').click();
  const pane = page.getByTestId('pr-pane');
  await expect(pane.getByTestId('pr-title')).toContainText('Team cards: show sprint progress');
  await expect(page).toHaveURL(new RegExp(`/issue/${twoPrs}$`));
  // The issue stays visible and usable on the left.
  await expect(page.getByTestId('detail')).toBeVisible();
  // Description (sanitized HTML), checks expanded because one fails.
  await expect(pane.getByTestId('pr-description').locator('h2').first()).toHaveText('What');
  await expect(pane.getByTestId('pr-description').locator('img').first()).toHaveAttribute('loading', 'lazy');
  await expect(pane.getByTestId('pr-checks')).toContainText('CI / check');
  await expect(pane.getByTestId('pr-checks').getByRole('link', { name: 'Log' }).first()).toHaveAttribute('target', '_blank');
  // Timeline: bot, review, line comment with reply.
  await expect(pane.getByTestId('pr-item')).toHaveCount(5);
  await expect(pane.getByTestId('pr-item').filter({ hasText: 'coderabbitai[bot]' }).first()).toContainText('Bot');
  await expect(pane.locator('.pr-item.reply')).toContainText('Fixed');
  // Without a token: notice instead of actions.
  await expect(pane.getByTestId('pr-unconfigured')).toBeVisible();
  await expect(pane.getByTestId('pr-actions')).toHaveCount(0);

  // Another PR of the same issue replaces the one on the right.
  await list.getByTestId('issue-pr').filter({ hasText: '#121' }).locator('.pr-row-main').click();
  await expect(pane.getByTestId('pr-state')).toHaveText('Merged');
  await page.mouse.move(2, 890);
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  // Esc closes the PR first, the issue stays open.
  await expect(page.getByTestId('detail')).toBeVisible();
});

test('Open full size from the PR alongside', async ({ page }) => {
  await open(page, `/issue/${twoPrs}`);
  await page.getByTestId('issue-pr').filter({ hasText: '#128' }).locator('.pr-row-main').click();
  const pane = page.getByTestId('pr-pane');
  await expect(pane.getByTestId('pr-title')).toBeVisible();
  await pane.getByTestId('pr-full').click();
  await expect(page).toHaveURL(/\/pr\/acme\/orbit-app\/128$/);
  await expect(page.getByTestId('pr-title')).toContainText('Team cards');
  await expect(page.getByTestId('pr-pane')).toHaveCount(0);

  // Also via the row button while the PR alongside is open.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/issue/${twoPrs}$`));
  await page.getByTestId('issue-pr').filter({ hasText: '#121' }).locator('.pr-row-main').click();
  await expect(page.getByTestId('pr-pane').getByTestId('pr-state')).toHaveText('Merged');
  const row = page.getByTestId('issue-pr').filter({ hasText: '#128' });
  await row.hover();
  await row.getByTestId('issue-pr-full').click();
  await expect(page).toHaveURL(/\/pr\/acme\/orbit-app\/128$/);
});

test('Images open large in the same tab, ←/→ page, Esc closes only the image viewer', async ({ page }) => {
  await open(page, `/issue/${twoPrs}`);
  await page.getByTestId('issue-pr').filter({ hasText: '#128' }).locator('.pr-row-main').click();
  const pane = page.getByTestId('pr-pane');
  const images = pane.getByTestId('pr-description').locator('img');
  await expect(images).toHaveCount(2);
  const pages = page.context().pages().length;
  await images.nth(1).click();
  const viewer = page.getByTestId('image-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId('image-viewer-img')).toHaveAttribute('alt', 'Team card light');
  await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 2');
  expect(page.context().pages().length).toBe(pages);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('image-viewer-img')).toHaveAttribute('alt', 'Team card dark');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  // The PR alongside stays open, the URL stays on the issue.
  await expect(pane.getByTestId('pr-title')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issue/${twoPrs}$`));
  // A click beside the image closes it too.
  await images.first().click();
  await expect(viewer).toBeVisible();
  await page.mouse.click(200, 300);
  await expect(viewer).toHaveCount(0);
});

test('Full view via the button and as a URL; Back leads to the issue', async ({ page }) => {
  await open(page, `/issue/${twoPrs}`);
  const row = page.getByTestId('issue-pr').filter({ hasText: '#128' });
  await row.hover();
  await row.getByTestId('issue-pr-full').click();
  await expect(page).toHaveURL(/\/pr\/acme\/orbit-app\/128$/);
  await expect(page.getByTestId('pr-title')).toContainText('Team cards');
  await expect(page.getByTestId('pr-files')).toHaveAttribute('href', 'https://github.com/acme/orbit-app/pull/128/files');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/issue/${twoPrs}$`));

  // Conflicts and requested changes on the second issue.
  await page.goto('/pr/acme/orbit-app/130');
  await expect(page.getByTestId('pr-conflict')).toBeVisible();
  await expect(page.getByTestId('pr-merge-state')).toContainText('Conflicts with main');
  await expect(page.getByTestId('pr-item')).toContainText('requested changes');

  // Unknown PR: notice with a link to GitHub.
  await page.goto('/pr/acme/orbit-app/9999');
  await expect(page.getByTestId('pr-missing')).toBeVisible();
});

// ---------------------------------------------------------------- Pull requests page (SELF-100)

const prRow = (page: import('@playwright/test').Page, number: number) => page.locator(`[data-testid="pull-row"][data-pr="acme/orbit-app#${number}"]`);
const group = (page: import('@playwright/test').Page, name: string) => page.locator(`[data-testid="pulls-group"][data-group="${name}"]`);

test('Pull requests page: entry right under the inbox with the count of ready and failing PRs; grouped by next step', async ({ page }) => {
  await open(page);
  const entry = page.getByTestId('nav-pulls');
  await expect(entry).toBeVisible();
  expect(await page.getByTestId('nav-inbox').evaluate((el) => (el.nextElementSibling as HTMLElement | null)?.dataset.testid)).toBe('nav-pulls');
  // #131 is ready to merge, #128 has a failing check; running, blocked and draft ones do not count.
  await expect(page.getByTestId('pulls-count')).toHaveText('2');
  await expect(page.getByTestId('pulls-count')).toHaveAttribute('title', '1 ready to merge · 1 with failing checks');

  await entry.click();
  await expect(page).toHaveURL(/\/pulls$/);
  await expect(entry).toHaveClass(/active/);
  await expect(page.getByTestId('pulls-group')).toHaveCount(6);
  expect(await page.getByTestId('pulls-group').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.group))).toEqual(['ready', 'failing', 'running', 'blocked', 'draft', 'done']);
  await expect(group(page, 'ready').getByTestId('pull-row')).toHaveCount(1);
  // A PR with two issues appears once, with both issues as chips.
  await expect(prRow(page, 131).getByTestId('pull-issue')).toHaveCount(2);
  await expect(prRow(page, 131).getByTestId('pull-issue').first()).toHaveText(keyOf(samples[3]!.issueSeqs[0]!));
  await expect(group(page, 'failing')).toContainText('#128');
  await expect(prRow(page, 128).getByTestId('pull-checks')).toHaveText('1 failed');
  await expect(prRow(page, 132).getByTestId('pull-checks')).toHaveText('1 running');
  await expect(prRow(page, 130).getByTestId('pull-blocker')).toHaveText(['Conflicts', 'Changes requested']);
  await expect(group(page, 'draft')).toContainText('#126');
  // Done collapsed; open it, it stays open after a reload.
  await expect(prRow(page, 121)).toHaveCount(0);
  await page.getByTestId('pulls-done-toggle').click();
  await expect(prRow(page, 121)).toContainText('Merged');
  await page.reload();
  await expect(prRow(page, 121)).toBeVisible();
  await page.getByTestId('pulls-done-toggle').click();
  await expect(prRow(page, 121)).toHaveCount(0);
  // Without a token: a note instead of a reload button.
  await expect(page.getByTestId('pulls-unconfigured')).toBeVisible();
});

test('Pull requests page: a click opens the PR beside the list, J/K follow, Enter opens it full size, Back and Esc', async ({ page }) => {
  await page.goto('/pulls');
  await expect(prRow(page, 128)).toBeVisible();
  await expect(page).toHaveTitle(/^Pull requests · Selfbound/);
  await prRow(page, 128).locator('.pull-title').click();
  const pane = page.getByTestId('pr-pane');
  await expect(pane.getByTestId('pr-title')).toContainText('Team cards: show sprint progress');
  await expect(page).toHaveURL(/\/pulls$/);
  await expect(prRow(page, 128)).toHaveClass(/active/);
  // A second click closes it.
  await prRow(page, 128).locator('.pull-title').click();
  await expect(pane).toHaveCount(0);

  // Keyboard: the clicked row has the focus; K moves up, Enter opens it beside the list, J moves on with it.
  await page.mouse.move(2, 890);
  await expect(prRow(page, 128)).toHaveClass(/focused/);
  await page.keyboard.press('k');
  await expect(prRow(page, 131)).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(pane.getByTestId('pr-title')).toContainText('Board: drag cards between columns');
  await page.keyboard.press('j');
  await expect(pane.getByTestId('pr-title')).toContainText('Team cards: show sprint progress');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(pane.getByTestId('pr-title')).toContainText('Team cards');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/pr\/acme\/orbit-app\/128$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/pulls$/);
  await expect(prRow(page, 128)).toBeVisible();
  await expect(page.getByTestId('pr-pane')).toHaveCount(0);

  // G P from anywhere.
  await open(page);
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/pulls$/);

  // An issue chip opens the issue.
  await prRow(page, 131).getByTestId('pull-issue').first().click();
  await expect(page).toHaveURL(new RegExp(`/issue/${keyOf(samples[3]!.issueSeqs[0]!)}$`));
});

test.describe('Pull requests page in a narrow window', () => {
  test.use({ viewport: { width: 1000, height: 800 } });
  test('a click opens the PR as its own page, Back returns to the list', async ({ page }) => {
    await page.goto('/pulls');
    await prRow(page, 130).locator('.pull-title').click();
    await expect(page).toHaveURL(/\/pr\/acme\/orbit-app\/130$/);
    await expect(page.getByTestId('pr-conflict')).toBeVisible();
    await page.goBack();
    await expect(prRow(page, 130)).toBeVisible();
  });
});
