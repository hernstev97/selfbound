// Sidebar with team cards: the current team with its navigation on top, below it the other active
// teams in a fixed order, then the dormant ones. Switching by click, Enter or O T; content and
// focus switch at once, the motion runs alongside.
import { expect, test, type Page } from '@playwright/test';
import { focusedRow, open } from '../support/helpers.ts';

const cardKeys = (page: Page, section: 'teams' | 'dormant') =>
  page.evaluate((section) => {
    const head = document.querySelector(`[data-testid="nav-${section}"]`);
    const keys: string[] = [];
    // "Teams" shares a row with the "Add team" button.
    for (let el = (head?.closest('.nav-section-row') ?? head)?.nextElementSibling; el && el.matches('a.team-card'); el = el.nextElementSibling) keys.push(el.getAttribute('data-testid')!.slice('nav-team-'.length));
    return keys;
  }, section);

test('Layout: current team on top with navigation, teams and dormant as small rows without numbers', async ({ page }) => {
  await open(page);
  const current = page.locator('.team-card.current');
  await expect(current).toHaveAttribute('data-testid', 'nav-team-ORB');
  await expect(page.getByTestId('nav-team-ORB-issues')).toBeVisible();
  await expect(page.getByTestId('nav-team-ORB-backlog')).toBeVisible();
  await expect(page.getByTestId('nav-team-ORB-projects')).toBeVisible();
  expect(await cardKeys(page, 'teams')).toEqual(['NOVA', 'PX', 'FLUX', 'KITE', 'ZEN', 'MOSAIK']);
  expect(await cardKeys(page, 'dormant')).toEqual(['RIFF', 'LUMA', 'QB']);
  // Numbers only on the current team: sprint progress or open issues by status type (they arrive
  // batched shortly after loading). The others show them in the tooltip.
  await expect(current.getByTestId('team-stats')).toHaveText(/^Sprint \d+% done$|^\d+ to do · \d+ in progress$/);
  await expect(page.getByTestId('team-stats')).toHaveCount(1);
  await expect(page.getByTestId('nav-team-RIFF')).toHaveAttribute('title', /^Riff: \d+ not started, \d+ started$/);
  const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('a.team-card')].map((el) => [el.offsetHeight, el.querySelector<HTMLElement>('.team-logo')!.offsetWidth]));
  for (const size of sizes) expect(size).toEqual([36, 24]);
  expect(await current.evaluate((el: HTMLElement) => [el.offsetHeight, el.querySelector<HTMLElement>('.team-logo')!.offsetWidth])).toEqual([52, 40]);
});

test('Settings › General: large sidebar teams with numbers, survives a reload', async ({ page }) => {
  await page.goto('/settings');
  const toggle = page.getByTestId('sidebar-teams-switch');
  await expect(toggle.getByRole('button', { name: 'Small' })).toHaveClass(/on/);
  await toggle.getByRole('button', { name: 'Large' }).click();
  await expect(toggle.getByRole('button', { name: 'Large' })).toHaveClass(/on/);
  await page.goto('/team/ORB');
  await expect(page.getByTestId('nav-team-RIFF').getByTestId('team-stats')).toHaveText(/^\d+ to do · \d+ in progress$/);
  await expect(page.getByTestId('team-stats')).toHaveCount(10);
  for (const text of await page.getByTestId('team-stats').allTextContents()) expect(text.trim()).toMatch(/^Sprint \d+% done$|^\d+ to do · \d+ in progress$/);
  expect(await page.getByTestId('nav-team-NOVA').evaluate((el: HTMLElement) => [el.offsetHeight, el.querySelector<HTMLElement>('.team-logo')!.offsetWidth])).toEqual([52, 40]);
  await page.reload();
  await expect(page.getByTestId('team-stats')).toHaveCount(10);
  // And back to small.
  await page.goto('/settings');
  await page.getByTestId('sidebar-teams-switch').getByRole('button', { name: 'Small' }).click();
  await page.goto('/team/ORB');
  await expect(page.getByTestId('nav-team-ORB')).toBeVisible();
  await expect(page.getByTestId('team-stats')).toHaveCount(1);
});

test('The current team docks onto the content panel; in the phone drawer it stands free', async ({ page, browser }) => {
  await open(page);
  const geo = () =>
    page.evaluate(() => {
      const card = document.querySelector('.team-card.current')!.getBoundingClientRect();
      const dock = document.querySelector('.team-card.current .tc-dock')!.getBoundingClientRect();
      const panel = document.querySelector('[data-testid="panel"]')!.getBoundingClientRect();
      return { cardRight: card.right, panelLeft: panel.left, dock: [dock.width, dock.top - card.top, card.bottom - dock.bottom] };
    });
  const desk = await geo();
  expect(desk.cardRight).toBe(desk.panelLeft);
  expect(desk.dock).toEqual([12, -12, -12]);
  // Other pages in the panel (inbox as a split view, issue) change nothing about it.
  await page.getByTestId('nav-inbox').click();
  expect((await geo()).cardRight).toBe(desk.panelLeft);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  await open(phone);
  await phone.evaluate(() => (globalThis as unknown as { __xlr8: { app: { mobileDrawer: { set(v: boolean): void } } } }).__xlr8.app.mobileDrawer.set(true));
  const card = phone.locator('.team-card.current');
  await expect(card).toBeVisible();
  const free = await card.evaluate((el) => ({ gap: el.closest('.sidebar')!.getBoundingClientRect().right - el.getBoundingClientRect().right, dock: getComputedStyle(el.querySelector('.tc-dock')!).display }));
  expect(free).toEqual({ gap: 14, dock: 'none' });
  await context.close();
});

for (const size of ['small', 'large'] as const) {
  test(`Switching (${size}): the row grows into the card at the panel, the old card shrinks, only translate, scale and opacity`, async ({ page }) => {
    await page.addInitScript((size) => {
      if (sessionStorage.getItem('size-set')) return;
      sessionStorage.setItem('size-set', '1');
      localStorage.setItem('xlr8:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('xlr8:prefs') ?? '{}'), sidebarTeams: size }));
    }, size);
    await open(page);
    const result = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('[data-testid="nav-team-KITE"]')!.click();
      for (let i = 0; i < 10 && !document.querySelector('.flip-ghost'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const sidebar = document.querySelector('[data-testid="sidebar"]')!;
      const anims = document.getAnimations().filter((a) => !(a instanceof CSSTransition) && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && sidebar.contains(a.effect.target));
      const props = new Set<string>();
      for (const a of anims) for (const frame of (a.effect as KeyframeEffect).getKeyframes()) for (const key of Object.keys(frame)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(key)) props.add(key);
      const scaleOf = (team: string) => {
        const bg = document.querySelector(`[data-testid="nav-team-${team}"] [data-part="bg"]`)!;
        const a = anims.find((x) => (x.effect as KeyframeEffect).target === bg);
        return a ? String((a.effect as KeyframeEffect).getKeyframes()[0].scale) : null;
      };
      return { props: [...props].sort(), kite: scaleOf('KITE'), orb: scaleOf('ORB'), dockFades: anims.some((a) => (a.effect as KeyframeEffect).target === document.querySelector('.team-card.current [data-part="dock"]')) };
    });
    expect(result.props).toEqual(['opacity', 'scale', 'translate', 'zIndex']);
    // Kite starts smaller (or narrower, without docking), Orbit larger than at the target.
    const [kx, ky] = result.kite!.split(' ').map(Number);
    const [ox, oy] = result.orb!.split(' ').map(Number);
    expect(kx).toBeLessThan(1);
    expect(ox).toBeGreaterThan(1);
    if (size === 'small') {
      expect(ky).toBeLessThan(1);
      expect(oy).toBeGreaterThan(1);
    }
    expect(result.dockFades).toBe(true);
    await expect(page.locator('.team-card.current')).toHaveAttribute('data-testid', 'nav-team-KITE');
    await expect(page.locator('.flip-ghost')).toHaveCount(0);
  });
}

test('A click switches at once; the old team returns to its fixed place, ghosts are inert', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-testid="nav-team-FLUX"]')!.click();
    const path = location.pathname;
    // The sidebar follows one frame after the content; then the old team collapses. Ghosts: no test
    // ids, inert, no keys.
    for (let i = 0; i < 10 && !document.querySelector('.flip-ghost'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const ghosts = [...document.querySelectorAll<HTMLElement>('.flip-ghost')].map((g) => ({ inert: g.inert, testids: g.querySelectorAll('[data-testid]').length + (g.dataset.testid ? 1 : 0), flip: g.hasAttribute('data-flip') }));
    return { path, ghosts };
  });
  expect(result.path).toBe('/team/FLUX');
  expect(result.ghosts.length).toBeGreaterThan(0);
  for (const g of result.ghosts) expect(g).toEqual({ inert: true, testids: 0, flip: false });
  await expect(page.getByTestId('view-title')).toHaveText('Active');
  await expect(page.locator('.team-card.current')).toHaveAttribute('data-testid', 'nav-team-FLUX');
  await expect(page.getByTestId('nav-team-ORB-issues')).toHaveCount(0);
  await expect(page.getByTestId('nav-team-FLUX-issues')).toBeVisible();
  expect(await cardKeys(page, 'teams')).toEqual(['ORB', 'NOVA', 'PX', 'KITE', 'ZEN', 'MOSAIK']);
  await expect(page.locator('.flip-ghost')).toHaveCount(0);
  // After a reload Flux stays the current team.
  await page.goto('/inbox');
  await expect(page.locator('.team-card.current')).toHaveAttribute('data-testid', 'nav-team-FLUX');
});

test('Backlog stays backlog: switching from the backlog lands in the other team\'s backlog', async ({ page }) => {
  await open(page, '/team/ORB/backlog');
  await page.getByTestId('nav-team-NOVA').click();
  await expect(page).toHaveURL(/\/team\/NOVA\/backlog$/);
  await expect(page.getByTestId('nav-team-NOVA-backlog')).toHaveClass(/active/);
});

test('Keyboard: Enter on a card switches, then the focus is on the card on top, J drives the list', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-team-PX').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/team\/PX$/);
  const current = page.locator('.team-card.current');
  await expect(current).toHaveAttribute('data-testid', 'nav-team-PX');
  await expect(current).toBeFocused();
  // Tab leads into the team's navigation.
  await page.keyboard.press('Tab');
  await expect(page.locator('.team-nav a').first()).toBeFocused();
  await page.locator('.team-card.current').focus();
  await page.keyboard.press('j');
  await expect(focusedRow(page)).toHaveCount(1);
});

test('O T: "Switch team" in the command menu', async ({ page }) => {
  await open(page);
  await page.keyboard.press('o');
  await page.keyboard.press('t');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'switchTeam');
  await page.keyboard.type('zenith');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/team\/ZEN$/);
  await expect(page.locator('.team-card.current')).toHaveAttribute('data-testid', 'nav-team-ZEN');
});

test('Teams and dormant collapse; the cards are gone at once, the state survives a reload', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-teams').click();
  await expect(page.getByTestId('nav-teams')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('nav-team-NOVA')).toHaveCount(0);
  await page.getByTestId('nav-dormant').click();
  await expect(page.getByTestId('nav-team-RIFF')).toHaveCount(0);
  await expect(page.locator('.flip-ghost')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('nav-teams')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('nav-team-NOVA')).toHaveCount(0);
  await page.getByTestId('nav-teams').click();
  await expect(page.getByTestId('nav-team-NOVA')).toBeVisible();
});

test('Reduced motion: team switch without sliding, only short fades', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  await open(page);
  const anims = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-testid="nav-team-KITE"]')!.click();
    for (let i = 0; i < 10 && !document.querySelector('.team-card.current[data-testid="nav-team-KITE"]'); i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const sidebar = document.querySelector('[data-testid="sidebar"]')!;
    return document
      .getAnimations()
      // Only web animations of the sidebar (no CSS transitions such as hover)
      .filter((a) => !(a instanceof CSSTransition) && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && sidebar.contains(a.effect.target))
      .map((a) => ({ translate: JSON.stringify((a.effect as KeyframeEffect).getKeyframes()).includes('translate'), duration: Number((a.effect as KeyframeEffect).getTiming().duration) }));
  });
  expect(anims.length).toBeGreaterThan(0);
  for (const a of anims) expect(a).toEqual({ translate: false, duration: expect.any(Number) });
  for (const a of anims) expect(a.duration).toBeLessThanOrEqual(100);
  await expect(page.locator('.flip-ghost')).toHaveCount(0);
  await context.close();
});

test('Nothing moves in the sidebar while loading (the first frames belong to the list)', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as { __sidebarAnims: number };
    w.__sidebarAnims = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      if (this.closest('[data-testid="sidebar"]')) w.__sidebarAnims++;
      return animate.apply(this, args);
    };
  });
  await open(page);
  await expect(page.locator('.team-card.current')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (globalThis as unknown as { __sidebarAnims: number }).__sidebarAnims)).toBe(0);
  // A switch does animate.
  await page.getByTestId('nav-team-PX').click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __sidebarAnims: number }).__sidebarAnims)).toBeGreaterThan(0);
});

test('Settings on the current team: last navigation item, opens the settings of exactly this team', async ({ page }) => {
  await open(page);
  const items = await page.getByTestId('current-team-nav').locator('.nav-item .label').allTextContents();
  expect(items.at(-1)).toBe('Settings');
  await page.getByTestId('nav-team-ORB-settings').click();
  await expect(page).toHaveURL(/\/settings\/teams\/ORB$/);
  await expect(page.getByTestId('team-detail')).toBeVisible();
  await expect(page.getByTestId('team-name')).toHaveValue('Orbit');
  // Back in the app: Orbit stays the current team. After a team switch the item applies to the new team.
  await page.getByTestId('settings-back').click();
  await page.getByTestId('nav-team-NOVA').click();
  await page.getByTestId('nav-team-NOVA-settings').click();
  await expect(page).toHaveURL(/\/settings\/teams\/NOVA$/);
});

test('Team settings by keyboard (Tab, Enter) and via O S', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-team-ORB-settings').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/teams\/ORB$/);
  await open(page, '/team/NOVA');
  await page.keyboard.press('o');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/\/settings\/teams\/NOVA$/);
});

test('"Add team": the plus in the "Teams" header shows on hover and on focus', async ({ page }) => {
  await open(page);
  const add = page.getByTestId('nav-team-add');
  await expect(add).toHaveCSS('opacity', '0');
  await page.getByTestId('nav-teams').hover();
  await expect(add).toHaveCSS('opacity', '1');
  await page.mouse.move(2, 890);
  await expect(add).toHaveCSS('opacity', '0');
  await add.focus();
  await page.keyboard.press('Tab');
  await page.getByTestId('nav-team-add').focus();
  await expect(add).toHaveCSS('opacity', '1');
  // A click on the header still collapses; the button does not.
  await page.getByTestId('nav-teams').click();
  await expect(page.getByTestId('nav-team-NOVA')).toHaveCount(0);
  await page.getByTestId('nav-teams').click();
  await expect(page.getByTestId('nav-team-NOVA')).toBeVisible();
});
