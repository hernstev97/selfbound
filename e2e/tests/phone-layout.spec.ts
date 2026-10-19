// Phone layout: on narrow screens (360 and 412 px) no main page gets wider than the screen,
// important elements stay readable, and open popovers, pickers and menus lie fully on screen.
// Runs in the desktop project with its own phone profile.
import { expect, test, type Page } from '@playwright/test';
import { agentCall, api, backend, open, settled } from '../support/helpers.ts';

const WIDTHS = [360, 412];

/** Tag in all titles of this test so everything can be cleaned up (other tests count rows from the top). */
const TAG = 'Phone-layout-test';

/** Moves everything this test created to the trash (including the agent issues in the inbox). */
async function cleanup() {
  const ids: string[] = [];
  for (let bucket = 0; ; bucket++) {
    const docs = await backend().query(api.issues.bucket, { bucket });
    if (docs.length === 0) break;
    for (const d of docs) if (d.title.includes(TAG) && d.deletedAt === undefined) ids.push(d._id);
  }
  if (ids.length) await backend().mutation(api.issues.remove, { ids: ids as never });
}

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  await cleanup();
});

const LONG = 'Alternative to a very long title that will never fit on one line on a phone and still must not break anything';

/** An issue with a parent issue (both with overlong titles), plus agent issues for the inbox. */
async function fixtures() {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const stamp = Date.now();
  const parent = (await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `${LONG} (parent ${stamp}) ${TAG}` }] })).issues[0];
  const child = (await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `${LONG} (child ${stamp}) ${TAG}`, parentId: parent.id }] })).issues[0];
  await agentCall('create_issues', { requestId: `phone-${stamp}`, issues: [{ team: 'ORB', title: `${LONG} (inbox ${stamp}) ${TAG}`, status: 'todo' }] });
  return { parent, child };
}

/** Intentional horizontal scroll containers: board, tabs, budget strip, tables and code blocks. */
const SCROLLERS = '[data-testid="board"], .tabs, .budget-strip, .md table, .md pre, .code-block, .tbl-wrap, .mobile-tabs';

/** How wide the page really is: document, scroll containers and all elements past the right edge. */
async function overflow(page: Page) {
  return await page.evaluate((scrollers) => {
    const width = window.innerWidth;
    const name = (el: Element) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
    const wide: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest(scrollers) || !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > width + 0.5) wide.push(`${name(el)} → ${Math.round(r.right)}`);
      // A container that can be swiped sideways although it should not (e.g. because overflow-y is auto).
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1) wide.push(`${name(el)} swipeable (${el.scrollWidth} > ${el.clientWidth})`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: width, wide: wide.slice(0, 8) };
  }, SCROLLERS);
}

async function expectNoOverflow(page: Page, label: string) {
  // Wait briefly for enter animations to finish (otherwise an element is still outside).
  await page.waitForTimeout(350);
  const o = await overflow(page);
  expect(o.scrollWidth, `${label}: page wider than the screen (${o.wide.join('; ')})`).toBeLessThanOrEqual(o.innerWidth);
  expect(o.wide, `${label}: elements stick out past the right edge`).toEqual([]);
}

/** Everything open lies fully on screen. */
async function expectInside(page: Page, selector: string, label: string) {
  const el = page.locator(selector).first();
  await expect(el, `${label}: not visible`).toBeVisible();
  await page.waitForTimeout(350);
  const box = (await el.boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(box.x, `${label}: outside on the left`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y, `${label}: outside at the top`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${label}: outside on the right`).toBeLessThanOrEqual(width + 0.5);
  expect(box.y + box.height, `${label}: outside at the bottom`).toBeLessThanOrEqual(height + 0.5);
}

for (const width of WIDTHS) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

    test('Main pages: never wider than the screen', async ({ page }) => {
      const { child } = await fixtures();
      const pages = [
        '/inbox',
        '/pulls',
        '/triage',
        '/all?group=none&order=created',
        '/team/ORB',
        '/team/ORB/backlog',
        '/team/ORB/all?layout=board',
        '/sprint',
        '/sprint/plan',
        '/sprints',
        '/team/ORB/projects',
        '/drafts',
        `/issue/${child.identifier}`,
        '/settings/general',
        '/settings/appearance',
        '/settings/notifications',
        '/settings/teams',
        '/settings/teams/ORB',
        '/settings/projects',
        '/settings/labels',
        '/settings/recurrences',
        '/settings/agents',
        '/settings/ops',
      ];
      for (const path of pages) {
        await page.goto(path);
        await expect(page.locator('.panel, [data-testid="detail"], [data-testid="settings-page"]').first()).toBeVisible();
        await page.waitForFunction(() => (window as unknown as { __selfbound?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__selfbound?.app?.store.sync.get().phase === 'live');
        await expectNoOverflow(page, path);
      }
    });

    test('List rows: pills fully visible and not over the title', async ({ page }) => {
      for (const path of ['/sprint', '/team/ORB', '/all?group=none&order=created']) {
        await open(page, path);
        const problems = await page.getByTestId('issue-row').evaluateAll((rows) => {
          const out: string[] = [];
          for (const row of rows) {
            const title = row.querySelector('[data-testid="row-title"]')!.getBoundingClientRect();
            const cols = row.querySelector('.row-cols')?.getBoundingClientRect();
            for (const el of row.querySelectorAll<HTMLElement>('.row-cols .pill, .row-end .pill, .row-end .row-date')) {
              if (!el.checkVisibility()) continue;
              const b = el.getBoundingClientRect();
              if (cols && b.top >= cols.bottom - 1) continue; // wrapped and dropped
              const key = (row as HTMLElement).dataset.key;
              if (b.left < title.right - 0.5) out.push(`${key}: "${el.textContent}" over the title`);
              if (cols && el.closest('.row-cols') && b.left < cols.left - 0.5) out.push(`${key}: "${el.textContent}" clipped on the left`);
            }
          }
          return out;
        });
        expect(problems, path).toEqual([]);
      }
    });

    test('Issue page: the parent line truncates with an ellipsis, title and chips stay on screen', async ({ page }) => {
      const { parent, child } = await fixtures();
      await page.goto(`/issue/${child.identifier}`);
      const crumb = page.getByTestId('detail-parent-link');
      await expect(crumb).toBeVisible();
      const box = (await crumb.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await crumb.locator('.parent-title').evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true);
      await expectNoOverflow(page, 'issue page');
      for (const chip of await page.locator('.mobile-props .chip').all()) {
        const b = (await chip.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(width);
      }
    });

    test('Inbox: title readable, actions reachable as icons', async ({ page }) => {
      await open(page, '/inbox');
      const title = page.getByTestId('view-title');
      await expect(title).toHaveText('Inbox');
      expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      for (const id of ['inbox-read-all', 'inbox-clear']) {
        const button = page.getByTestId(id);
        await expect(button).toBeVisible();
        const b = (await button.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(width);
        expect(b.width).toBeGreaterThanOrEqual(32);
        await expect(button).toHaveAttribute('aria-label', /.+/);
      }
      await expectNoOverflow(page, 'inbox');
    });

    test('Search, command menu and filters stay on screen, even with the peek state on', async ({ page }) => {
      for (const path of ['/sprint', '/team/ORB', '/inbox', '/settings/general', '/sprint/plan']) {
        await open(page, path).catch(() => page.goto(path));
        await page.waitForFunction(() => (window as unknown as { __selfbound?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__selfbound?.app?.store.sync.get().phase === 'live');
        for (const kind of ['search', 'command'] as const) {
          // Peek state on: it used to push the palette half off screen.
          await page.evaluate((k) => {
            const app = (window as unknown as { __selfbound: { app: { palette: { open(kind: string): void }; detail: { peekOpen: { get(): boolean }; togglePeek(): void } } } }).__selfbound.app;
            if (!app.detail.peekOpen.get()) app.detail.togglePeek();
            app.palette.open(k);
          }, kind);
          await expectInside(page, '[data-testid="palette"]', `${path} ${kind}`);
          await expectNoOverflow(page, `${path} ${kind}`);
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('palette')).toHaveCount(0);
        }
      }
    });

    test('Pickers, menus and dialogs lie on screen', async ({ page }) => {
      const { child, parent } = await fixtures();
      await page.goto(`/issue/${child.identifier}`);
      await expect(page.getByTestId('detail')).toBeVisible();
      const chips = page.locator('.mobile-props .chip');
      for (let i = 0; i < (await chips.count()); i++) {
        await chips.nth(i).tap();
        const palette = page.getByTestId('palette');
        if (await palette.count()) {
          await expectInside(page, '[data-testid="palette"]', `Chip ${i}`);
          await page.keyboard.press('Escape');
          await expect(palette).toHaveCount(0);
        }
        await expectNoOverflow(page, `Chip ${i}`);
      }
      // Context menu in the list
      await open(page, '/team/ORB');
      await page.getByTestId('issue-row').first().dispatchEvent('contextmenu', { clientX: width - 20, clientY: 300 });
      await expectInside(page, '[data-testid="context-menu"]', 'context menu');
      await page.keyboard.press('Escape');
      // Display popover and filters
      const display = page.getByTestId('display-button').first();
      if (await display.count()) {
        await display.tap();
        await expectInside(page, '.display-pop', 'display');
        await page.keyboard.press('Escape');
      }
      // Create
      await page.getByTestId('mobile-create').tap();
      await expectInside(page, '[data-testid="create-dialog"]', 'create');
      await expectNoOverflow(page, 'create');
    });
  });
}
