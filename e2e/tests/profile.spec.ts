// Profile: name and picture of the owner (settings → Profile). Crop dialog, rejection of other file
// types, display in the activity of an issue, and that agents keep their own identity.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

/** Other specs run afterwards on the same data: always clear the profile. */
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  await backend().mutation(api.profile.setName, { name: null });
  await backend().mutation(api.profile.removeAvatar, {});
});

/** A colorful PNG, painted in the browser. */
async function pngBytes(page: Page, width = 600, height = 400) {
  const data = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      const gradient = g.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#e8590c');
      gradient.addColorStop(1, '#5e6ad2');
      g.fillStyle = gradient;
      g.fillRect(0, 0, w, h);
      const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [width, height],
  );
  return Buffer.from(data);
}

async function freshIssue() {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Profile ${Date.now()}` }] });
  await backend().mutation(api.comments.add, { issueId: issues[0].id, body: 'A comment by the owner' });
  return issues[0];
}

test('Name and picture: set in the settings, shown in the activity, removed again', async ({ page }) => {
  const issue = await freshIssue();
  await page.goto('/settings/profile');
  await expect(page.getByTestId('settings-page')).toHaveAttribute('data-section', 'profile');

  // Without a profile: neutral glyph and "You"
  await expect(page.getByTestId('profile-picture-row').getByTestId('avatar')).toBeVisible();
  await expect(page.getByTestId('profile-name')).toHaveValue('');

  // Name: Enter saves; the whitespace is tidied
  await page.getByTestId('profile-name').fill('  Jane   Doe ');
  await page.getByTestId('profile-name').press('Enter');
  await expect(page.getByTestId('profile-picture-row').getByTestId('avatar')).toContainText('JD');
  await expect.poll(async () => (await backend().query(api.meta.get, {})).owner.name).toBe('Jane Doe');

  // A file that is not a picture is turned down before the dialog
  await page.getByTestId('profile-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByTestId('profile-error')).toContainText('PNG, JPEG or WebP');
  await expect(page.getByTestId('avatar-crop-dialog')).toHaveCount(0);

  // Picture: crop dialog, zoom, save
  await page.getByTestId('profile-file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: await pngBytes(page) });
  await expect(page.getByTestId('avatar-crop-dialog')).toBeVisible();
  await page.getByTestId('avatar-zoom').fill('2');
  await page.getByTestId('avatar-crop').focus();
  await page.keyboard.press('ArrowLeft');
  await page.getByTestId('avatar-save').click();
  await expect(page.getByTestId('avatar-crop-dialog')).toHaveCount(0);
  await expect(page.getByTestId('profile-picture-row').locator('img')).toBeVisible();

  const { avatarUrl } = (await backend().query(api.meta.get, {})).owner;
  expect(avatarUrl).toMatch(/\/img\/[A-Za-z0-9_-]{43}$/);
  const response = await fetch(avatarUrl!);
  expect(response.headers.get('content-type')).toMatch(/image\/(webp|png|jpeg)/);
  expect((await response.arrayBuffer()).byteLength).toBeLessThan(256 * 1024);

  // Shown with the owner's comment and in the history
  await open(page, `/issue/${issue.identifier}`);
  const comment = page.locator('[data-testid="comment"][data-source="owner"]').first();
  await expect(comment.locator('.who')).toHaveText('Jane Doe');
  await expect(comment.locator('img')).toBeVisible();
  await expect(page.locator('[data-testid="activity-event"][data-source="owner"] .who').first()).toHaveText('Jane Doe');

  // Remove the picture: initials again; clear the name: "You"
  await page.goto('/settings/profile');
  await page.getByTestId('profile-remove-picture').click();
  await expect(page.getByTestId('profile-picture-row').locator('img')).toHaveCount(0);
  await expect(page.getByTestId('profile-picture-row').getByTestId('avatar')).toContainText('JD');
  await page.getByTestId('profile-name').fill('');
  await page.getByTestId('profile-name').press('Enter');
  await expect.poll(async () => (await backend().query(api.meta.get, {})).owner).toEqual({ name: null, avatarUrl: null });
  await open(page, `/issue/${issue.identifier}`);
  await expect(page.locator('[data-testid="comment"][data-source="owner"] .who').first()).toHaveText('You');
});

test('The profile page is in the command menu and the settings navigation', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as { __selfbound: { app: { palette: { open(kind: string): void } } } }).__selfbound.app.palette.open('command'));
  await page.getByTestId('palette-input').fill('Settings: Profile');
  await page.locator('[data-testid="palette-item"]', { hasText: 'Settings: Profile' }).first().click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(page.getByTestId('settings-nav-profile')).toBeVisible();
});
