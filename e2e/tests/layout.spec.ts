// List row layout and behaviour on outside changes: scroll anchoring when an agent inserts above,
// pills never clipped or over the title, flat rows (few DOM nodes), only the changed row re-renders.
import { expect, test, type Page } from '@playwright/test';
import { agentCall, focusedRow, open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

/** For each visible row: pills fully visible and right of the title (columns: `.row-cols`, `.row-end`). */
async function pillProblems(page: Page) {
  return await page.getByTestId('issue-row').evaluateAll((rows) => {
    const problems: string[] = [];
    for (const row of rows) {
      const title = row.querySelector('[data-testid="row-title"]')!.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      for (const el of row.querySelectorAll<HTMLElement>('.row-cols .pill, .row-cols .row-est, .row-end .pill, .row-end .row-date')) {
        // Hidden (labels in the medium and narrow tiers) doesn't count.
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const b = el.getBoundingClientRect();
        // Dropped (second, clipped line of the columns or labels) doesn't count.
        const wrap = el.closest('.c-labels') ?? el.closest('.row-cols, .row-end')!;
        if (b.top >= wrap.getBoundingClientRect().bottom - 1 || b.width === 0) continue;
        // A "+n" hint covered by another label doesn't count.
        if (el.classList.contains('more')) {
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          if (!hit || !el.contains(hit)) continue;
        }
        const key = (row as HTMLElement).dataset.key;
        const cell = (el.closest('.c') ?? wrap).getBoundingClientRect();
        if (b.left < cell.left - 0.5) problems.push(`${key}: "${el.textContent}" clipped on the left`);
        if (b.right > Math.min(cell.right, rowBox.right) + 0.5) problems.push(`${key}: "${el.textContent}" clipped on the right`);
        if (b.left < title.right - 0.5) problems.push(`${key}: "${el.textContent}" over the title`);
      }
    }
    return problems;
  });
}

test('Pills at 1024 px with a large font: never clipped, never over the title; "+n" for dropped labels', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.addInitScript(() => localStorage.setItem('xlr8:prefs', JSON.stringify({ fontSize: 'large' })));
  await open(page, '/all');
  expect(await pillProblems(page)).toEqual([]);
  // Somewhere it is tight enough for labels to drop: then the remaining "+n" shows.
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('list').evaluate((el) => (el.scrollTop += 600));
    await page.waitForTimeout(50);
    expect(await pillProblems(page)).toEqual([]);
  }
});

test('Sprint planning (two columns) without clipped pills', async ({ page }) => {
  await open(page, '/sprint/plan');
  await expect(page.getByTestId('plan-sprint').getByTestId('issue-row').first()).toBeVisible();
  expect(await pillProblems(page)).toEqual([]);
});

test('A row has few DOM nodes, icons without inline SVG', async ({ page }) => {
  await open(page);
  const counts = await page.getByTestId('issue-row').evaluateAll((rows) =>
    rows.map((r) => {
      let n = 0;
      const walk = (node: Node) => {
        n++;
        node.childNodes.forEach(walk);
      };
      walk(r);
      return { n, svg: r.querySelectorAll('svg').length };
    }),
  );
  expect(Math.max(...counts.map((c) => c.n))).toBeLessThanOrEqual(40);
  expect(counts.every((c) => c.svg === 0)).toBe(true);
});

test('An agent creates 10 issues above; the visible rows and the focus stay in place', async ({ page }) => {
  await open(page, '/all?group=none&order=created');
  // Into the middle of the list: real keys, as when working.
  for (let i = 0; i < 30; i++) await page.keyboard.press('j');
  const focused = await focusedRow(page).getAttribute('data-id');
  const before = (await focusedRow(page).boundingBox())!.y;
  const list = page.getByTestId('list');
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await agentCall('create_issues', {
    requestId: `e2e-anchor-${Date.now()}`,
    issues: Array.from({ length: 10 }, (_, i) => ({ team: 'ORB', title: `Agent above ${i + 1}`, status: 'todo' })),
  });
  // New issues are at the top (newest first) …
  await expect(page.getByTestId('view-count')).not.toHaveText('0');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="row-title"]')].length > 0);
  await list.evaluate((el) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
  // … but the focused issue is still at the same place on screen.
  await expect(focusedRow(page)).toHaveAttribute('data-id', focused!);
  const after = (await focusedRow(page).boundingBox())!.y;
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  // Scrolled all the way up, the new issues are there.
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect(page.getByTestId('row-title').filter({ hasText: 'Agent above 10' })).toBeVisible();
});

test('An agent changes the priority: only that row changes, no row is recreated', async ({ page }) => {
  await open(page, '/all?group=none&order=created');
  const target = page.getByTestId('issue-row').nth(3);
  const key = (await target.getAttribute('data-key'))!;
  const priority = await target.getAttribute('data-priority');
  const snapshot = () => page.getByTestId('issue-row').evaluateAll((rows) => Object.fromEntries(rows.map((r) => [(r as HTMLElement).dataset.key, r.outerHTML])));
  // Mark all rows: a recreated row lacks the mark.
  await page.getByTestId('issue-row').evaluateAll((rows) => rows.forEach((r) => ((r as HTMLElement).dataset.mark = '1')));
  const before = await snapshot();
  await agentCall('update_issue', { identifier: key, priority: priority === '1' ? 'high' : 'urgent' });
  await expect(target).not.toHaveAttribute('data-priority', priority!);
  const after = await snapshot();
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  expect(changed).toEqual([key]);
  expect(await page.locator('[data-testid="issue-row"]:not([data-mark])').count()).toBe(0);
});
