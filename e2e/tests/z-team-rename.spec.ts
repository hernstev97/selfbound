// Renaming the key of a team with issues (XLR8-72): confirmation, old identifiers keep working.
// The file name starts with "z-" so it runs last: it creates a team that must not show up in the
// other tests. All specs run serially against one backend.
import { expect, test } from '@playwright/test';
import { api, backend, open, resolve, setRejectWrites, settled } from '../support/helpers.ts';

test('Settings: renaming asks first; old URLs, mentions and identifiers lead to the renamed issues', async ({ page }) => {
  // Keys unique per run (a retry runs against the same backend).
  const stamp = String(Date.now() % 100000).padStart(5, '0');
  const [oldKey, newKey] = [`R${stamp}`, `S${stamp}`];
  const { teamId } = await backend().mutation(api.teams.create, { key: oldKey, name: `Rename ${stamp}` });
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId, title: `Target ${stamp}`, status: 'todo' }] });
  const target = issues[0];
  expect(target.identifier).toBe(`${oldKey}-1`);
  const { issues: hosts } = await backend().mutation(api.issues.create, { issues: [{ teamId, title: `Host ${stamp}`, description: `Written before the rename: ${oldKey}-1.` }] });

  // Settings has no list: wait for the team page and for all issues (the count decides the dialog).
  await page.goto(`/settings/teams/${oldKey}`);
  await expect(page.getByTestId('team-detail')).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __selfbound?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__selfbound?.app?.store.sync.get().phase === 'live');
  const field = page.getByTestId('team-key');
  await field.fill(newKey.toLowerCase());
  await field.press('Enter');
  const dialog = page.getByTestId('team-rename-dialog');
  await expect(dialog).toContainText(`${oldKey}-2 becomes ${newKey}-2`);
  await expect(dialog).toContainText(`${oldKey} stays reserved for this team`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath('confirmation.png') });

  // Cancel changes nothing; confirming renames and the address follows the new key.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(field).toHaveValue(oldKey);

  // A key another team holds: an error right away, no dialog.
  await field.fill('ORB');
  await field.press('Enter');
  await expect(page.getByTestId('toast').filter({ hasText: 'The key ORB is already taken.' })).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // The server says no: the page stays on (or returns to) the team under its old key.
  // Error toasts stay until closed.
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await setRejectWrites(true);
  try {
    await field.fill(newKey);
    await field.press('Enter');
    await page.getByTestId('team-rename-confirm').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Team not updated' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/settings/teams/${oldKey}$`));
    await expect(field).toHaveValue(oldKey);
  } finally {
    await setRejectWrites(false);
  }

  await field.fill(newKey);
  await field.press('Enter');
  await page.getByTestId('team-rename-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/settings/teams/${newKey}$`));
  await expect(page.getByTestId('team-previous-keys')).toHaveText(`Previously: ${oldKey}`);
  await settled(page);

  // Server: the old identifier resolves to the renamed issue.
  expect(await resolve(`${oldKey}-1`)).toEqual({ id: target.id, identifier: `${newKey}-1` });

  // Old issue URL → current identifier; old team URL → current key.
  await open(page, `/issue/${oldKey}-1`);
  await expect(page).toHaveURL(new RegExp(`/issue/${newKey}-1$`));
  await expect(page.getByTestId('detail-key')).toHaveText(`${newKey}-1`);
  await open(page, `/team/${oldKey}/all`);
  await expect(page).toHaveURL(new RegExp(`/team/${newKey}/all`));

  // A mention written with the old key shows the current key and the issue's status; hover names the typed form.
  await open(page, `/issue/${hosts[0].identifier.replace(oldKey, newKey)}`);
  const mention = page.getByTestId('detail-description').locator('a.mention', { hasText: `${newKey}-1` });
  await expect(mention).toHaveText(`${newKey}-1`);
  await expect(mention).toHaveAttribute('data-typed', `${oldKey}-1`);
  await expect(mention.locator('.mention-icon svg')).toBeVisible();
  await expect(mention).toHaveAttribute('data-title', new RegExp(`^${newKey}-1 · Target ${stamp}.* · written as ${oldKey}-1$`));
  await page.screenshot({ path: test.info().outputPath('mention.png') });
  await mention.hover();
  await expect.poll(async () => mention.evaluate((el) => getComputedStyle(el, '::after').opacity), { timeout: 3000 }).toBe('1');
  await page.screenshot({ path: test.info().outputPath('mention-tooltip.png') });
  await mention.click();
  await expect(page).toHaveURL(new RegExp(`/issue/${newKey}-1$`));
  // One history entry for the old link: Back returns to the text.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/issue/${newKey}-2$`));

  // The old key is reserved: a new team cannot take it.
  await expect(backend().mutation(api.teams.create, { key: oldKey, name: 'Copy' })).rejects.toThrow(/used by/);
});
