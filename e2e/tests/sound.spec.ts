// UI sounds. A test cannot hear whether something sounds; it checks what the app reports
// (`__selfbound.cues`), what actually plays after rate limiting (`__selfbound.sound.played`), and that the
// AudioContext is created only after a gesture and does not hold up startup or input.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, focusedRow, open, settled } from '../support/helpers.ts';

type Hooks = { cues: string[]; sound?: { played: string[]; state(): string } };
const hooks = (page: Page) => ({
  cues: () => page.evaluate(() => (window as unknown as { __selfbound: Hooks }).__selfbound.cues.slice()),
  played: () => page.evaluate(() => (window as unknown as { __selfbound: Hooks }).__selfbound.sound?.played.slice() ?? []),
  state: () => page.evaluate(() => (window as unknown as { __selfbound: Hooks }).__selfbound.sound?.state() ?? 'none'),
  clear: () =>
    page.evaluate(() => {
      const h = (window as unknown as { __selfbound: Hooks }).__selfbound;
      h.cues.length = 0;
      h.sound?.played.splice(0);
    }),
});

/** Page open and the sound chunk loaded (it arrives when idle after startup). */
async function ready(page: Page, path?: string) {
  await open(page, path);
  await page.waitForFunction(() => !!(window as unknown as { __selfbound: Hooks }).__selfbound.sound);
}

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('Startup: no audio chunk at startup and no AudioContext before the first gesture', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __contexts: number; AudioContext: typeof AudioContext };
    w.__contexts = 0;
    const Real = w.AudioContext;
    w.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.__contexts++;
      }
    };
  });
  await open(page);
  await page.waitForFunction(() => !!(window as unknown as { __selfbound: Hooks }).__selfbound.sound);
  // Loaded and ready, but no context without a gesture.
  expect(await page.evaluate(() => (window as unknown as { __contexts: number }).__contexts)).toBe(0);
  expect(await hooks(page).state()).toBe('none');
  // The audio part is its own chunk, loaded after the list, not at startup.
  const html = await (await page.request.get('/')).text();
  expect(html).not.toMatch(/sound-[\w-]+\.js/);
  // First gesture: the context is created and runs.
  await page.keyboard.press('j');
  await expect.poll(() => hooks(page).state()).toBe('running');
  expect(await page.evaluate(() => (window as unknown as { __contexts: number }).__contexts)).toBe(1);
});

test('Mapping: J/K tap, command menu open/command/close, status done success', async ({ page }) => {
  await ready(page);
  const h = hooks(page);
  await h.clear();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  expect(await h.cues()).toEqual(['tap', 'tap']);

  // Picker by keyboard: open, select, success. Closing after the selection stays silent.
  await h.clear();
  await page.keyboard.press('s');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.keyboard.type('done');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect.poll(() => h.cues()).toEqual(['open', 'select', 'success']);
  await page.keyboard.press('z'); // undo
  await settled(page);

  // Esc without a selection closes with close. (Playwright is faster than any hand: wait briefly so
  // the previous selection no longer counts as "just selected".)
  await page.waitForTimeout(250);
  await h.clear();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  expect(await h.cues()).toEqual(['open', 'close']);
});

test('Mouse: click on a row select, right click open, context menu entry select; a click that opens a menu adds no open', async ({ page }) => {
  await ready(page);
  const h = hooks(page);
  const first = page.locator('[data-testid="issue-row"]').first();
  await h.clear();
  await first.locator('.row-title').click(); // opens the issue
  await expect(page.getByTestId('detail')).toBeVisible();
  expect(await h.cues()).toEqual(['select']);
  await page.keyboard.press('Escape');
  await expect(first).toBeVisible();
  await page.waitForTimeout(250); // otherwise the previous click still counts as "just clicked"

  await h.clear();
  await first.click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  expect(await h.cues()).toEqual(['open']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('context-menu')).toHaveCount(0);

  // A click on the status cell opens the picker: one sound (tap), no second "open" after it.
  await h.clear();
  await first.getByTestId('row-status').click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await h.cues()).toEqual(['tap']);
  await page.keyboard.press('Escape');
});

test('A held key does not pile up: many cues, few sounds, the context runs', async ({ page }) => {
  await ready(page);
  const h = hooks(page);
  await page.keyboard.press('j'); // first gesture
  await expect.poll(() => h.state()).toBe('running');
  await h.clear();
  const start = Date.now();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.down('j'); // without up: Playwright sends repeat=true, like a held key
    await page.waitForTimeout(16);
  }
  await page.keyboard.up('j');
  const seconds = (Date.now() - start) / 1000;
  const cues = await h.cues();
  const played = await h.played();
  expect(cues.length).toBe(60);
  expect(played.length).toBeGreaterThan(3);
  expect(played.length).toBeLessThanOrEqual(Math.ceil((seconds * 1000) / 65) + 1);
  expect(played.every((c) => c === 'tap')).toBe(true);
  await expect(focusedRow(page)).toHaveCount(1);
});

test('Typing in the editor: key per character (rate limited), deleting too; the command menu search stays silent', async ({ page }) => {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Sound ${Date.now()}`, description: '' }] });
  try {
    await ready(page, `/issue/${issues[0].identifier}`);
    const h = hooks(page);
    await expect(page.getByTestId('detail-loading')).toHaveCount(0);
    await page.getByTestId('detail-description').click();
    const editor = page.getByTestId('desc-editor');
    await expect(editor).toBeFocused();
    await h.clear();
    await page.keyboard.type('Hello world', { delay: 70 });
    await page.keyboard.press('Backspace');
    const cues = await h.cues();
    expect(cues.filter((c) => c === 'key').length).toBeGreaterThanOrEqual(10);
    expect(cues.every((c) => c === 'key')).toBe(true);
    expect((await h.played()).length).toBeGreaterThan(3);
    await settled(page);

    // The search field in the command menu only filters: silent
    await page.keyboard.press('Escape');
    await page.getByTestId('nav-search').click();
    await expect(page.getByTestId('palette')).toBeVisible();
    await h.clear();
    await page.keyboard.type('status');
    expect(await h.cues()).toEqual([]);
    await page.keyboard.press('Escape');
  } finally {
    await backend().mutation(api.issues.remove, { ids: [issues[0].id as never] });
  }
});

test('Settings: sounds off → silent and no audio chunk on the next start; the volume applies and persists', async ({ page }) => {
  await ready(page);
  const h = hooks(page);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('sound-switch')).toBeVisible();
  // Default: on, half volume
  await expect(page.getByTestId('sound-switch').locator('button.on')).toHaveText('On');
  await expect(page.getByTestId('sound-volume')).toHaveValue('0.5');

  // Slider: sliderTick per step, value stored per device
  await h.clear();
  await page.getByTestId('sound-volume').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('sound-volume')).toHaveValue('0.55');
  expect((await h.cues()).includes('sliderTick')).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('selfbound:prefs')!).soundVolume)).toBe(0.55);

  // Off: nothing plays any more although cues keep coming
  await page.getByTestId('sound-switch').getByText('Off', { exact: true }).click();
  await h.clear();
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('theme-switch').getByText('Light', { exact: true }).click();
  await page.getByTestId('theme-switch').getByText('Dark', { exact: true }).click();
  expect((await h.cues()).length).toBeGreaterThan(0);
  expect(await h.played()).toEqual([]);

  // Reload: the audio chunk is not loaded at all
  await page.goto('/settings/general');
  await expect(page.getByTestId('sound-switch')).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __selfbound?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__selfbound?.app?.store.sync.get().phase === 'live');
  await page.waitForTimeout(3500); // at most this long does startup wait before fetching lazy chunks
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /sound-[\w-]+\.js/.test(e.name)))).toBe(false);
  expect(await page.evaluate(() => !!(window as unknown as { __selfbound: Hooks }).__selfbound.sound)).toBe(false);

  // On again: the chunk loads, switching on sounds (swoosh)
  await page.getByTestId('sound-switch').getByText('On', { exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { __selfbound: Hooks }).__selfbound.sound);
  await expect.poll(() => hooks(page).cues()).toContain('swoosh');
  await expect.poll(() => hooks(page).played()).toContain('swoosh');
  await page.evaluate(() => localStorage.removeItem('selfbound:prefs'));
});
