// Touch and keyboard: tools that appear on hover on desktop are always shown on touch devices, and
// on desktop on keyboard focus. On phones, status and priority in a list row are not separate
// targets (tapping opens the issue), and important targets have a hit area of at least 44 px,
// measured with elementFromPoint (which includes ::after).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { agentCall, api, backend, open, settled } from '../support/helpers.ts';

/** Tag in all titles of this test so everything can be cleaned up (other tests count rows from the top). */
const TAG = 'Touch-targets-test';

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

/** An issue with your own comment, a relation and a change by an agent (revertible). */
async function fixture() {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const stamp = Date.now();
  const [main, other] = (
    await backend().mutation(api.issues.create, {
      issues: [
        { teamId: team._id, title: `Tools ${stamp} ${TAG}`, status: 'todo' },
        { teamId: team._id, title: `Neighbor ${stamp} ${TAG}`, status: 'todo' },
      ],
    })
  ).issues;
  await backend().mutation(api.comments.add, { issueId: main.id as never, body: 'Comment with tools' });
  await backend().mutation(api.relations.add, { fromId: main.id as never, toId: other.id as never, type: 'related' });
  await agentCall('set_status', { identifiers: [main.identifier], status: 'in_progress' });
  return main.identifier;
}

/** Opacity including all ancestors (tools inherit it from their container). */
const opacity = (el: Locator) =>
  el.evaluate((node) => {
    let o = 1;
    for (let e: Element | null = node; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  });

/** Hit area: from the center as far as elementFromPoint still returns the element (or a child, ::after). */
const hitSize = (el: Locator) =>
  el.evaluate(async (node) => {
    node.scrollIntoView({ block: 'center' });
    await new Promise((r) => requestAnimationFrame(r));
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const owns = (x: number, y: number) => {
      const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
      return !!hit && (hit === node || node.contains(hit));
    };
    const span = (dx: number, dy: number) => {
      let n = 0;
      while (n < 40 && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
      return n;
    };
    return { width: span(-1, 0) + span(1, 0) + 1, height: span(0, -1) + span(0, 1) + 1 };
  });

async function expectHit(el: Locator, label: string, min = 44) {
  await expect(el, label).toBeVisible();
  const size = await hitSize(el);
  expect(Math.min(size.width, size.height), `${label}: hit area ${size.width} × ${size.height}`).toBeGreaterThanOrEqual(min);
}

const live = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __selfbound?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__selfbound?.app?.store.sync.get().phase === 'live');

for (const width of [360, 412]) {
  test.describe(`${width} px, touch`, () => {
    test.use({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

    test('Tools visible, hit areas in the issue at least 44 px', async ({ page }) => {
      const key = await fixture();
      await page.goto(`/issue/${key}`);
      await expect(page.getByTestId('comment').first()).toBeVisible();
      await live(page);
      const tools = {
        'edit comment': page.getByTestId('comment-edit'),
        'delete comment': page.getByTestId('comment-delete'),
        'revert change': page.getByTestId('activity-revert').first(),
        'remove relation': page.getByRole('button', { name: 'Remove relation' }),
      };
      for (const [label, el] of Object.entries(tools)) {
        // Poll: the page is still fading in when it opens (ancestor opacity).
        await expect.poll(() => opacity(el), { message: `${label}: invisible` }).toBeGreaterThan(0.9);
        await expectHit(el, label);
      }
      await expectHit(page.getByTestId('detail-back-mobile'), 'back');
      for (const chip of await page.locator('.mobile-props .chip').all()) await expectHit(chip, `Chip ${await chip.textContent()}`);
    });

    test('List: status and priority open no picker, header and groups with 44 px', async ({ page }) => {
      await open(page, '/team/ORB');
      for (const id of ['row-status', 'row-priority']) {
        // Tap where the icon is (Playwright rightly reports that the row receives the tap).
        const box = (await page.getByTestId(id).first().boundingBox())!;
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.getByTestId('detail'), `${id}: tapping opens the issue`).toBeVisible();
        await expect(page.getByTestId('palette')).toHaveCount(0);
        await page.getByTestId('detail-back-mobile').tap();
        await expect(page.getByTestId('issue-row').first()).toBeVisible();
      }
      await expectHit(page.getByTestId('layout-toggle'), 'board/list');
      await expectHit(page.getByTestId('filter-button'), 'filter');
      await expectHit(page.getByTestId('tab-all'), 'tab');
      await expectHit(page.locator('.group-chevron').first(), 'collapse group');
      await expectHit(page.locator('.group-add').first(), 'create issue in group');

      // Board card: the same
      await open(page, '/team/ORB/all?order=created&layout=board');
      const card = page.getByTestId('issue-card').first();
      const box = (await card.getByTestId('row-status').boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByTestId('detail'), 'card: tapping opens the issue').toBeVisible();
      await expect(page.getByTestId('palette')).toHaveCount(0);
      await page.getByTestId('detail-back-mobile').tap();

      await page.getByTestId('mobile-menu').tap();
      await expect(page.getByTestId('sidebar')).toBeInViewport();
      await page.waitForTimeout(300);
      for (const id of ['nav-search', 'nav-create', 'nav-inbox', 'nav-teams', 'nav-team-add']) await expectHit(page.getByTestId(id), id);
      await expect.poll(() => opacity(page.getByTestId('nav-team-add'))).toBeGreaterThan(0.9);
    });
  });
}

test('Desktop: tools visible on keyboard focus, status and priority clickable', async ({ page }) => {
  const key = await fixture();
  await page.goto(`/issue/${key}`);
  await expect(page.getByTestId('comment').first()).toBeVisible();
  await live(page);
  await page.mouse.move(2, 890);
  const edit = page.getByTestId('comment-edit');
  const revert = page.getByTestId('activity-revert').first();
  const unlink = page.getByRole('button', { name: 'Remove relation' });
  for (const el of [edit, revert, unlink]) expect(await opacity(el)).toBe(0);
  // Focus as if by Tab: after a key press, programmatic focus counts as :focus-visible.
  await page.keyboard.press('Shift');
  for (const [label, el] of [['edit comment', edit], ['revert', revert], ['remove relation', unlink]] as const) {
    await el.focus();
    await expect.poll(() => opacity(el), { message: `${label}: invisible on focus` }).toBeGreaterThan(0.9);
  }

  await open(page, '/team/ORB');
  await page.getByTestId('row-priority').first().click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
});
