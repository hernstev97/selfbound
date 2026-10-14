// Sign-in page (welcome.html): plain, no marketing, loads nothing from the app. There is no Clerk
// in the test: sign-in only shows a notice. In production Vercel routes `/` without the signed-in
// cookie and `/sign-in` here (deploy/web/vercel.json); locally the page is at /welcome and /sign-in.
import { expect, test } from '@playwright/test';

test('Sign-in page: plain content, not indexable, nothing from the app', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Selfbound' })).toBeAttached();
  await expect(page.getByRole('status')).toContainText('Sign-in is not set up here');
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  // Sign-in only, no registration, no link to a public page
  await expect(page.getByRole('link', { name: /sign up|register/i })).toHaveCount(0);
  expect(await page.getAttribute('meta[name="robots"]', 'content')).toBe('noindex, nofollow');
  expect(await page.getAttribute('html', 'lang')).toBe('en');
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/assets\/.*\.js$/.test(n)));
  expect(scripts.some((s) => /\/(start|index)-[\w-]+\.js$/.test(s))).toBe(false);
});

test('Opening sign-in directly keeps the way back', async ({ page }) => {
  await page.goto('/sign-in?redirect_url=%2Fissue%2FFOO-1');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Selfbound' })).toBeAttached();
  await page.getByRole('status').getByRole('link', { name: 'open the app' }).click();
  await expect(page).toHaveURL(/\/issue\/FOO-1$/);
});
