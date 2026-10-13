// Motion runs only alongside: state, focus and rows are right at once; ghost copies used for
// fading out are already gone for tests, keyboard and mouse; reduced motion = short fades.
import { expect, test } from '@playwright/test';
import { focusedRow, open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('Collapsing a group: rows gone at once, the ghost has no test ids and is inert, cleaned up afterwards', async ({ page }) => {
  await open(page, '/all?group=status');
  const head = page.getByTestId('group-header').first();
  const status = (await head.getAttribute('data-status'))!;
  const inGroup = page.locator(`[data-testid="issue-row"][data-status="${status}"]`);
  expect(await inGroup.count()).toBeGreaterThan(0);
  const result = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-testid="group-header"]')!;
    header.click();
    // Still in the same tick: Svelte renders in a microtask, the ghost is already there.
    const ghost = document.querySelector<HTMLElement>('.list-ghost');
    return {
      ghost: !!ghost,
      inert: ghost?.inert ?? null,
      testids: ghost ? ghost.querySelectorAll('[data-testid]').length : null,
      ids: ghost ? ghost.querySelectorAll('[data-id]').length : null,
    };
  });
  expect(result).toMatchObject({ ghost: true, inert: true, testids: 0, ids: 0 });
  await expect(head.locator('.group-chevron')).toHaveClass(/closed/);
  // After the microtask the list is done: the group's rows are gone, focus on a real row.
  await expect(inGroup).toHaveCount(0);
  await expect(focusedRow(page)).toHaveCount(1);
  await expect(page.locator('.list-ghost')).toHaveCount(0);
  await expect(page.getByTestId('list')).not.toHaveClass(/sliding/);
});

test('Expanding: new rows fade in, pressing T twice in a row stays usable', async ({ page }) => {
  await open(page, '/all?group=status');
  await page.keyboard.press('t');
  await page.keyboard.press('t');
  await expect(page.getByTestId('group-header').first().locator('.group-chevron')).not.toHaveClass(/closed/);
  await expect(page.locator('.list-ghost')).toHaveCount(0);
  await page.keyboard.press('j');
  await expect(focusedRow(page)).toHaveCount(1);
});

test('Reduced motion: all transitions at most 100 ms, no sliding', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  await open(page, '/all?group=status');
  const durations = await page.evaluate(() => {
    const els = [document.querySelector('.row')!, document.querySelector('.row-cols > .c')!, document.querySelector('.group-cols')!, document.querySelector('.group-chevron .icon')!];
    return els.map((el) => getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d) * 1000));
  });
  for (const list of durations) for (const d of list) expect(d).toBeLessThanOrEqual(100);
  // Collapsing without sliding: no animation on `translate`.
  const moved = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-testid="group-header"]')!.click();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return document.getAnimations().filter((a) => JSON.stringify((a.effect as KeyframeEffect).getKeyframes()).includes('translate')).length;
  });
  expect(moved).toBe(0);
  await context.close();
});

test('Closing a picker fades out but is gone at once; reopening right away gives a fresh field with focus', async ({ page }) => {
  await open(page);
  await page.keyboard.press('s');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  // At once: no test id, no focus in the fading field (the next key is a shortcut).
  expect(await page.getByTestId('palette').count()).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.closest('.palette') === null)).toBe(true);
  await page.keyboard.press('p');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'priority');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await expect(page.getByTestId('palette')).toHaveCount(1);
  await page.keyboard.press('Escape');
});
