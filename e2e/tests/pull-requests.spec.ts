// Pull requests in XLR8: list on the issue, PR next to the issue, full view.
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
