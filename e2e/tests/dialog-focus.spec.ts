// Dialogs trap the keyboard focus: Tab cycles inside the dialog, the background is inert, Esc closes,
// focus returns to the trigger. Per dialog type: create, add team, settings dialogs (key, revoke),
// command menu and pickers (also inside the create dialog).
import { expect, test, type Page } from '@playwright/test';
import { open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

/** Is the focus inside the element with this test id? */
const focusIn = (page: Page, testid: string) => page.evaluate((id) => !!document.activeElement?.closest(`[data-testid="${id}"]`), testid);
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '');
const inert = (page: Page, testid: string) => page.evaluate((id) => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.inert ?? null, testid);

/** Presses Tab (or Shift Tab) until the focus is back at the start; no step leaves the dialog. */
async function cycle(page: Page, dialog: string, key = 'Tab') {
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(key);
    expect(await focusIn(page, dialog), `step ${i + 1} (${key}) stays in the dialog, focus: ${await focusedId(page)}`).toBe(true);
    const id = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      el.dataset.seenByTest ??= String(Math.random());
      return el.dataset.seenByTest;
    });
    if (seen.includes(id)) return seen.length;
    seen.push(id);
  }
  throw new Error(`${key} did not cycle within 40 steps`);
}

/** Everything outside the dialog is inert: sidebar, main panel; the screen reader announcements (aria-live) stay live. */
async function backgroundLocked(page: Page, locked: boolean, { panel = true } = {}) {
  // Settings dialogs live inside the main panel: there the siblings are made inert, not the panel itself.
  if (panel) expect(await inert(page, 'panel')).toBe(locked);
  expect(await inert(page, 'sidebar')).toBe(locked);
  expect(await inert(page, 'toasts')).toBe(false);
}

test('Create: Tab cycles, background inert, Esc closes and the focus returns to the button', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.getByTestId('nav-create').click();
  const dialog = page.getByTestId('create-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('create-title')).toBeFocused();
  await backgroundLocked(page, true);
  expect(await cycle(page, 'create-dialog')).toBeGreaterThan(8);
  expect(await cycle(page, 'create-dialog', 'Shift+Tab')).toBeGreaterThan(8);
  // Shift Tab from the first element jumps to the end, Tab from the last to the start.
  await page.getByTestId('create-team').focus();
  await page.keyboard.press('Shift+Tab');
  expect(await focusIn(page, 'create-dialog')).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('create-team')).toBeFocused();
  // A click outside the dialog closes it, the focus returns to the button
  await page.mouse.click(40, 400);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('nav-create')).toBeFocused();
  await backgroundLocked(page, false);
  // Esc as well
  await page.getByTestId('nav-create').click();
  await expect(page.getByTestId('create-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('nav-create')).toBeFocused();
});

test('Create with shortcut C: focus in the title, Esc closes, page shortcuts work again', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-title')).toBeFocused();
  // Page shortcuts (g a) are just letters in the title while the dialog is open
  await page.keyboard.type('ga');
  await expect(page.getByTestId('create-title')).toHaveValue('ga');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await backgroundLocked(page, false);
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/all/);
});

test('Picker in the create dialog: Esc closes only the picker, focus back on the chip, the dialog keeps trapping', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.keyboard.press('c');
  await page.getByTestId('create-priority').click();
  const palette = page.getByTestId('palette');
  await expect(palette).toBeVisible();
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  // The dialog behind is inert; Tab keeps selecting entries (no focus jump)
  expect(await inert(page, 'create-dialog')).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  expect(await inert(page, 'create-dialog')).toBe(false);
  await expect(page.getByTestId('create-priority')).toBeFocused();
  // The dialog traps Tab again
  expect(await cycle(page, 'create-dialog')).toBeGreaterThan(8);
  // Choosing in the picker: focus also returns to the chip
  await page.getByTestId('create-priority').click();
  await page.keyboard.type('high');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('create-priority')).toContainText('High');
  await expect(page.getByTestId('create-priority')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await backgroundLocked(page, false);
});

test('Add team: Tab cycles, background inert, Esc closes, focus back on the plus', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-teams').hover();
  await page.getByTestId('nav-team-add').click();
  const dialog = page.getByTestId('new-team-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('new-team-name')).toBeFocused();
  await backgroundLocked(page, true);
  expect(await cycle(page, 'new-team-dialog')).toBeGreaterThanOrEqual(3);
  expect(await cycle(page, 'new-team-dialog', 'Shift+Tab')).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('nav-team-add')).toBeFocused();
  await backgroundLocked(page, false);
});

test('Add team via O N: Esc closes, shortcuts work again', async ({ page }) => {
  await open(page);
  await page.keyboard.press('o');
  await page.keyboard.press('n');
  await expect(page.getByTestId('new-team-name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-team-dialog')).toHaveCount(0);
  await backgroundLocked(page, false);
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/all/);
});

test('Command menu and search: background inert, Esc closes, focus back on the search button', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.getByTestId('nav-search').click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await backgroundLocked(page, true);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('nav-search')).toBeFocused();
  await backgroundLocked(page, false);

  // Command menu by keyboard, then "New issue" from it: the dialog traps the focus
  await page.mouse.click(700, 500);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.type('new issue');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  await expect(page.getByTestId('create-title')).toBeFocused();
  expect(await cycle(page, 'create-dialog')).toBeGreaterThan(8);
  await backgroundLocked(page, true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await backgroundLocked(page, false);
});

test('Settings dialogs (key, revoke): Tab cycles, background inert, Esc closes, focus returns', async ({ page }) => {
  await page.goto('/settings/agents');
  await page.getByTestId('agent-add').click();
  await page.getByTestId('agent-name').fill('E2E focus test');
  await page.getByTestId('agent-create').click();
  const key = page.getByTestId('agent-key-dialog');
  await expect(key).toBeVisible();
  await expect(key).toHaveAttribute('aria-modal', 'true');
  await expect(key).toBeFocused();
  await backgroundLocked(page, true, { panel: false });
  expect(await cycle(page, 'agent-key-dialog')).toBe(3);
  expect(await cycle(page, 'agent-key-dialog', 'Shift+Tab')).toBe(3);
  await page.keyboard.press('Escape');
  await expect(key).toHaveCount(0);
  await backgroundLocked(page, false);

  const row = page.locator('[data-testid="agent-row"][data-name="E2E focus test"]');
  await row.getByTestId('agent-revoke').click();
  const revoke = page.getByTestId('agent-revoke-dialog');
  await expect(revoke).toBeVisible();
  await backgroundLocked(page, true, { panel: false });
  expect(await cycle(page, 'agent-revoke-dialog')).toBe(2);
  expect(await cycle(page, 'agent-revoke-dialog', 'Shift+Tab')).toBe(2);
  await page.keyboard.press('Escape');
  await expect(revoke).toHaveCount(0);
  await expect(row.getByTestId('agent-revoke')).toBeFocused();
  await backgroundLocked(page, false);

  // Once more with the mouse, and this time really revoke so the key does not stay around.
  await row.getByTestId('agent-revoke').click();
  await page.getByTestId('agent-revoke-confirm').click();
  await expect(row.getByTestId('agent-revoked')).toBeVisible();
  await backgroundLocked(page, false);
});

test('Context menu: Esc closes, arrow keys select', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.getByTestId('issue-row').first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/all/);
});

test('Opening stays fast: key press to dialog visible and focused in at most 100 ms', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  // Like a slow machine (CI runner): CPU throttled so races on quick reopening show up
  if (process.env.E2E_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_THROTTLE) });
  // Overlays are loaded before measuring
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);

  /**
   * Time from the trigger (key press or call) until the target gets focus (event time, not rounded to a frame).
   * The listener is in place before triggering: on a slow machine the key press would otherwise overtake the script.
   */
  const timeToFocus = async (selector: string, trigger: () => Promise<void>) => {
    await page.evaluate((sel) => {
      const rec = { begin: 0, focus: 0 };
      (window as unknown as { __focus: typeof rec }).__focus = rec;
      addEventListener('keydown', (e) => (rec.begin ||= e.timeStamp), { once: true, capture: true });
      document.addEventListener('focusin', (e) => (rec.focus ||= e.target instanceof Element && e.target.matches(sel) ? e.timeStamp : 0), { capture: true });
    }, selector);
    await trigger();
    await page.waitForFunction(() => (window as unknown as { __focus: { focus: number } }).__focus.focus > 0, null, { timeout: 5000 });
    return page.evaluate(() => {
      const rec = (window as unknown as { __focus: { begin: number; focus: number } }).__focus;
      return rec.focus - rec.begin;
    });
  };
  const results: Record<string, number[]> = { create: [], palette: [], team: [] };
  for (let i = 0; i < 8; i++) {
    for (const [name, key, ready] of [
      ['create', 'c', '[data-testid="create-title"]'],
      ['palette', 'Control+k', '[data-testid="palette-input"]'],
      ['team', null, '[data-testid="new-team-name"]'],
    ] as const) {
      const ms = await timeToFocus(ready, async () => {
        if (key) await page.keyboard.press(key);
        else
          await page.evaluate(() => {
            (window as unknown as { __focus: { begin: number } }).__focus.begin = performance.now();
            (window as unknown as { __selfbound: { app: { openNewTeam(): void } } }).__selfbound.app.openNewTeam();
          });
      });
      results[name].push(ms);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="create-dialog"], [data-testid="palette"], [data-testid="new-team-dialog"]')).toHaveCount(0);
    }
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const [name, xs] of Object.entries(results)) {
    console.log(`Open ${name}: median ${median(xs).toFixed(1)} ms, max ${Math.max(...xs).toFixed(1)} ms`);
    expect(median(xs), `${name} median`).toBeLessThanOrEqual(100);
  }
});
