// Issue mentions show the issue's live status icon and title, in the rendered text and in the editor.
import { expect, test } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  if (created.length) await backend().mutation(api.issues.remove, { ids: created.splice(0) as never[] });
});

test('Mentions carry status and title, differ for done, follow changes live, unknown ones stay text', async ({ page }) => {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const stamp = Date.now();
  const { issues } = await backend().mutation(api.issues.create, {
    issues: [
      { teamId: team._id, title: `Open target ${stamp}`, description: '' },
      { teamId: team._id, title: `Done target ${stamp}`, description: '' },
    ],
  });
  created.push(issues[0].id, issues[1].id);
  await backend().mutation(api.issues.update, { ids: [issues[1].id], patch: { status: 'done' } });
  const [open1, done1] = [issues[0].identifier, issues[1].identifier];
  const text = `See ${open1} and ${done1}, but not ORB-99999.`;
  const { issues: host } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Host ${stamp}`, description: text }] });
  created.push(host[0].id);

  await open(page, `/issue/${host[0].identifier}`);
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  const description = page.getByTestId('detail-description');
  const first = description.locator('a.mention', { hasText: open1 });
  const second = description.locator('a.mention', { hasText: done1 });
  await expect(first.locator('.mention-icon svg')).toBeVisible();
  await expect(first).toHaveAttribute('data-title', new RegExp(`Open target ${stamp}`));
  await expect(second).toHaveClass(/mention-done/);
  await expect(first).not.toHaveClass(/mention-done/);
  await expect(description.locator('a.mention-unknown')).toHaveText('ORB-99999');

  // The title shows on hover.
  await first.hover();
  const tip = await first.evaluate((el) => getComputedStyle(el, '::after').opacity);
  await expect.poll(async () => first.evaluate((el) => getComputedStyle(el, '::after').opacity), { timeout: 3000 }).toBe('1');
  expect(tip).toBeDefined();

  // Live: the status of the target changes in another client.
  await backend().mutation(api.issues.update, { ids: [issues[0].id], patch: { status: 'canceled' } });
  await expect(first).toHaveClass(/mention-canceled/);

  // The editor shows the icon too.
  await description.click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await expect(editor.locator('.mention-icon')).toHaveCount(2);
  await expect(editor.locator('.mention-text.mention-done')).toHaveText(done1);
});
