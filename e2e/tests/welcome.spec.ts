// Welcome page and sign-in (welcome.html): content, keyboard, switching to sign-in and back, a
// frugal background (still image with reduced motion, paused in a hidden tab). There is no Clerk in
// the test: sign-in only shows a notice. In production Vercel routes `/` (deploy/web/vercel.json);
// locally the welcome page is at /welcome.
import { expect, test, type Page } from '@playwright/test';
import { PUBLIC_URL } from '../support/env.ts';

/** Counts frames of the animation loop (the page's requestAnimationFrame calls). */
async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    (window as unknown as { __frames: number }).__frames = 0;
    window.requestAnimationFrame = (cb) => {
      (window as unknown as { __frames: number }).__frames++;
      return raf(cb);
    };
  });
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __frames: number }).__frames);

test('Welcome page: content, headings, metadata', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'A personal issue tracker, built for speed.' })).toBeVisible();
  await expect(page.locator('h1:visible')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['What it does', 'Written by AI agents, directed by a person.']);
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(4);
  // Sign-in only, no registration
  await expect(page.getByRole('link', { name: /sign up|register/i })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /Sample data/ })).toBeVisible();
  // Link previews: the e2e build sets XLR8_PUBLIC_URL (support/global-setup.ts), so the paths become absolute.
  expect(await page.getAttribute('meta[property="og:image"]', 'content')).toBe(`${PUBLIC_URL}/brand/og-welcome.png`);
  expect(await page.getAttribute('meta[property="og:url"]', 'content')).toBe(`${PUBLIC_URL}/`);
  expect(await page.getAttribute('html', 'lang')).toBe('en');
  // No part of the app loaded
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/assets\/.*\.js$/.test(n)));
  expect(scripts.some((s) => /\/(start|index)-[\w-]+\.js$/.test(s))).toBe(false);
});

test('Welcome page: keyboard, Sign in and back', async ({ page }) => {
  await page.goto('/welcome');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'XLR8, home' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.locator('main.sign-in')).toBeVisible();
  await expect(page.locator('main.landing')).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Sign-in is not set up here');
  await page.goBack();
  await expect(page.locator('main.landing')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /built for speed/ })).toBeVisible();
});

test('Opening sign-in directly keeps the way back', async ({ page }) => {
  await page.goto('/sign-in?redirect_url=%2Fissue%2FFOO-1');
  await expect(page.locator('main.sign-in')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to XLR8' })).toBeAttached();
  await page.getByRole('status').getByRole('link', { name: 'open the app' }).click();
  await expect(page).toHaveURL(/\/issue\/FOO-1$/);
});

test('Background: runs, pauses in a hidden tab', async ({ page }) => {
  await countFrames(page);
  await page.goto('/welcome');
  await expect(page.locator('.fx-wrap canvas.ready')).toBeAttached();
  // Without WebGL 2 (some test browsers) there is only the still image and nothing runs.
  test.skip(!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))), 'no WebGL 2');
  // Running: frames keep coming. No fixed frame rate, CI renders slowly without a GPU.
  const a = await frames(page);
  await expect.poll(() => frames(page), { timeout: 5000 }).toBeGreaterThan(a + 3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  const b = await frames(page);
  await page.waitForTimeout(800);
  expect(await frames(page)).toBeLessThanOrEqual(b + 1);
});

test('Background: still image with reduced motion', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await countFrames(page);
  await page.goto('/welcome');
  await expect(page.locator('.fx-wrap canvas.ready')).toBeAttached();
  const a = await frames(page);
  await page.waitForTimeout(600);
  expect(await frames(page)).toBeLessThanOrEqual(a + 1);
  await context.close();
});
