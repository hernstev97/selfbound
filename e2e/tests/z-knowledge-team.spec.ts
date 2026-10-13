// Knowledge-only teams: create in the dialog, sidebar with only the wiki and settings, /team/KEY
// leads to the wiki, the team is missing when creating an issue. Prefixed "z-" so the new team does
// not show up in the other tests (cards, sprint planning).
import { expect, test } from '@playwright/test';
import { api, backend, open } from '../support/helpers.ts';

test('"Knowledge only" in the dialog: the card shows the wiki instead of numbers, only wiki and settings', async ({ page }) => {
  await open(page);
  await page.keyboard.press('o');
  await page.keyboard.press('n');
  await page.getByTestId('new-team-name').fill('Policy');
  await page.getByTestId('new-team-wiki').locator('[data-value="only"]').click();
  await page.getByTestId('new-team-submit').click();
  await expect(page).toHaveURL(/\/team\/POLI\/wiki$/);
  await expect(page.getByTestId('wiki-page')).toBeVisible();
  const nav = page.getByTestId('current-team-nav').locator('.nav-item');
  await expect(nav).toHaveText(['Knowledge', 'Settings']);
  await expect(page.locator('.team-card.current [data-testid="team-stats"]')).toHaveText('Knowledge');
  expect((await backend().query(api.meta.get, {})).teams.find((t) => t.key === 'POLI')?.wiki).toBe('only');

  // /team/POLI (issues) redirects to the wiki.
  await page.goto('/team/POLI');
  await expect(page).toHaveURL(/\/team\/POLI\/wiki$/);

  // New issue from here: the team is not prefilled and not in the picker.
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-title')).toBeVisible();
  await expect(page.getByTestId('create-team')).not.toContainText('Policy');
  await page.getByTestId('create-team').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'team');
  await expect(page.getByTestId('palette').getByText('Policy')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Settings: "Knowledge only" is selected, no workflow.
  await page.goto('/settings/teams/POLI');
  await expect(page.getByTestId('team-wiki').locator('button.on')).toHaveText('Knowledge only');
  await expect(page.getByText('Workflow', { exact: true })).toHaveCount(0);
});
