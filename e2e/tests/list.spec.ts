// Core list flows: rows, groups, focus, pickers, filters, search, peek, context menu, rollback.
import { expect, test } from '@playwright/test';
import { focusedRow, open, row, setRejectWrites, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

// With 44 px rows, 22 rows fit at 1080p.
test('List: at least 22 rows at 1080p, header shows the count, virtualized', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page, '/all?group=none');
  // 440 test issues minus 1 in the trash, plus whatever other tests created.
  expect(Number(await page.getByTestId('view-count').textContent())).toBeGreaterThanOrEqual(420);
  const visible = await page.getByTestId('issue-row').evaluateAll((rows) => {
    const list = document.querySelector('[data-testid="list"]')!.getBoundingClientRect();
    return rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= list.top && b.bottom <= list.bottom;
    }).length;
  });
  expect(visible).toBeGreaterThanOrEqual(22);
  expect(await page.getByTestId('issue-row').count()).toBeLessThan(60);
});

test('Groups: by team in "All issues", T collapses', async ({ page }) => {
  await open(page, '/all');
  const first = page.getByTestId('group-header').first();
  await expect(first).toContainText('Orbit');
  const before = await page.getByTestId('issue-row').count();
  await page.keyboard.press('t');
  await expect(page.getByTestId('group-header').first().locator('.group-chevron')).toHaveClass(/closed/);
  await page.keyboard.press('t');
  await expect(page.getByTestId('group-header').first().locator('.group-chevron')).not.toHaveClass(/closed/);
  expect(await page.getByTestId('issue-row').count()).toBe(before);
});

test('Triage is the first status group in "All issues", collapsible, rows usable', async ({ page }) => {
  await open(page, '/all?group=status');
  const head = page.getByTestId('group-header').first();
  await expect(head).toHaveAttribute('data-status', 'triage');
  const rows = page.locator('[data-testid="issue-row"][data-status="triage"]');
  expect(await rows.count()).toBeGreaterThan(0);
  // The focus starts on the first row, i.e. in triage; the keyboard moves it as usual.
  await expect(focusedRow(page)).toHaveAttribute('data-status', 'triage');
  await page.keyboard.press('j');
  await expect(focusedRow(page)).toHaveCount(1);
  await head.click();
  await expect(head.locator('.group-chevron')).toHaveClass(/closed/);
  await expect(rows).toHaveCount(0);
  // The board has no triage.
  await open(page, '/team/ORB/all?layout=board');
  await expect(page.getByTestId('board-column').first()).toBeVisible();
  await expect(page.getByTestId('column-name').getByText('Triage', { exact: true })).toHaveCount(0);
});

test('J/K move the focus; the focus stays visible while paging far', async ({ page }) => {
  await open(page);
  const first = await focusedRow(page).getAttribute('data-id');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  expect(await focusedRow(page).getAttribute('data-id')).not.toBe(first);
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  await expect(focusedRow(page)).toHaveAttribute('data-id', first!);
  for (let i = 0; i < 60; i++) await page.keyboard.press('j');
  await expect(focusedRow(page)).toBeInViewport();
});

test('S + "prog" + Enter sets the status, undo reverts', async ({ page }) => {
  await open(page);
  const target = focusedRow(page);
  const id = (await target.getAttribute('data-id'))!;
  const before = (await target.getAttribute('data-status'))!;
  await page.keyboard.press('s');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'status');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.type(before === 'in_progress' ? 'review' : 'prog');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(row(page, id)).toHaveAttribute('data-status', before === 'in_progress' ? 'in_review' : 'in_progress');
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(row(page, id)).toHaveAttribute('data-status', before);
});

test('Multi-select + command menu, toast with undo', async ({ page }) => {
  await open(page);
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('[data-testid="issue-row"].selected')).toHaveCount(3);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-target')).toHaveText('3 issues');
  await page.keyboard.type('status: canceled');
  await expect(page.getByTestId('palette-item').first()).toContainText('Status: Canceled');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="issue-row"].selected[data-status="canceled"]')).toHaveCount(3);
  await expect(page.getByTestId('toast').filter({ hasText: 'issues changed' })).toBeVisible();
  await settled(page);
  await page.getByTestId('toast').filter({ hasText: 'issues changed' }).getByTestId('toast-action').click();
  await expect(page.locator('[data-testid="issue-row"].selected[data-status="canceled"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="issue-row"].selected')).toHaveCount(0);
});

test('Filter via F, stored in the URL, the chip removes it', async ({ page }) => {
  await open(page);
  const total = (await page.getByTestId('view-count').textContent())!;
  await page.keyboard.press('f');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'filter');
  await page.keyboard.type('high');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('filter-chip')).toContainText('Priority: High');
  await expect(page).toHaveURL(/prio=2/);
  const priorities = await page.getByTestId('issue-row').evaluateAll((rows) => [...new Set(rows.map((r) => r.getAttribute('data-priority')))]);
  expect(priorities).toEqual(['2']);
  // A reload lands in the same place
  await page.reload();
  await expect(page.getByTestId('filter-chip')).toContainText('Priority: High');
  await page.getByTestId('filter-chip-remove').click();
  await expect(page.getByTestId('filter-chip')).toHaveCount(0);
  await expect(page.getByTestId('view-count')).toHaveText(total);
});

test('Filter via the second level: Status ▸ In Progress', async ({ page }) => {
  await open(page);
  await page.keyboard.press('f');
  await page.getByTestId('palette-item').filter({ hasText: 'Status' }).first().click();
  await expect(page.getByTestId('palette-item').filter({ hasText: 'In Progress' })).toBeVisible();
  await page.getByTestId('palette-item').filter({ hasText: 'In Progress' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('filter-chip')).toContainText('Status: In Progress');
  await page.getByTestId('filter-chip-remove').click();
});

test('Empty state with "Reset filters"', async ({ page }) => {
  await open(page);
  const total = (await page.getByTestId('view-count').textContent())!;
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('quick-search')).toBeFocused();
  await page.keyboard.type('zzzz does not exist');
  await expect(page.getByTestId('empty-state')).toContainText('No issues match these filters');
  await page.getByTestId('empty-reset').click();
  await expect(page.getByTestId('view-count')).toHaveText(total);
});

test('Quick search filters, Esc restores the list', async ({ page }) => {
  await open(page);
  const total = (await page.getByTestId('view-count').textContent())!;
  await page.keyboard.press('Control+f');
  await page.keyboard.type('orb-1');
  await expect.poll(async () => Number(await page.getByTestId('view-count').textContent())).toBeLessThan(40);
  const keys = await page.getByTestId('issue-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-key')!.toLowerCase()));
  expect(keys.every((k) => k.startsWith('orb-1'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('view-count')).toHaveText(total);
  await expect(page.getByTestId('quick-search')).toHaveCount(0);
});

test('Peek via Space, ↓ follows along, Esc closes', async ({ page }) => {
  await open(page);
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  await page.keyboard.press(' ');
  await expect(page.getByTestId('peek')).toBeVisible();
  await expect(page.getByTestId('peek')).toContainText(key);
  await expect(page.getByTestId('peek-description')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('peek')).not.toContainText(key);
  const next = (await focusedRow(page).getAttribute('data-key'))!;
  await expect(page.getByTestId('peek')).toContainText(next);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('peek')).toHaveCount(0);
  await expect(focusedRow(page)).toHaveAttribute('data-key', next);
});

test('Enter opens the detail, Esc returns with the same focus and scroll', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 30; i++) await page.keyboard.press('j');
  await page.keyboard.press('x');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  const scroll = await page.getByTestId('list').evaluate((el) => el.scrollTop);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail')).toBeVisible();
  await expect(page.getByTestId('detail-description')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issue/${key}$`));
  await page.keyboard.press('Escape');
  await expect(focusedRow(page)).toHaveAttribute('data-key', key);
  expect(await page.getByTestId('list').evaluate((el) => el.scrollTop)).toBe(scroll);
  await expect(page.locator('[data-testid="issue-row"].selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('The command menu shows shortcuts and navigates', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'command');
  await expect(page.getByTestId('palette-item').filter({ hasText: 'Go to: All issues' }).locator('.shortcut')).toHaveText('G then A');
  await page.keyboard.type('backlog');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/backlog/);
  await expect(page.getByTestId('view-title')).toHaveText('Backlog');
});

test('G then I/T/A/B/S navigates', async ({ page }) => {
  await open(page);
  const go = async (key: string, url: RegExp) => {
    await page.keyboard.press('g');
    await page.keyboard.press(key);
    await expect(page).toHaveURL(url);
  };
  await go('i', /\/inbox/);
  await go('t', /\/triage/);
  await go('b', /\/backlog/);
  await go('s', /\/sprint/);
  await go('a', /\/all/);
});

test('Global search jumps by identifier without a hyphen', async ({ page }) => {
  await open(page);
  const key = (await page.getByTestId('issue-row').nth(10).getAttribute('data-key'))!;
  await page.keyboard.press('/');
  await page.keyboard.type(key.replace('-', '').toLowerCase());
  await expect(page.getByTestId('palette-item').first()).toContainText(key);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-key')).toHaveText(key);
});

test('Full-text search finds text from descriptions', async ({ page }) => {
  await open(page);
  await page.keyboard.press('/');
  await page.keyboard.type('dataset');
  await expect(page.locator('.palette-section').filter({ hasText: 'In descriptions' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Context menu with submenu and shortcuts', async ({ page }) => {
  await open(page);
  const target = page.getByTestId('issue-row').nth(3);
  const id = (await target.getAttribute('data-id'))!;
  await target.click({ button: 'right', position: { x: 500, y: 20 } });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await expect(page.getByTestId('context-item').filter({ hasText: 'Status' }).locator('.shortcut')).toHaveText('S');
  await page.getByTestId('context-item').filter({ hasText: 'Priority' }).hover();
  await expect(page.getByTestId('context-submenu')).toBeVisible();
  await page.getByTestId('context-subitem').filter({ hasText: 'Low' }).click();
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await expect(row(page, id)).toHaveAttribute('data-priority', '4');
});

test('Clicking the status icon opens the picker for that row', async ({ page }) => {
  await open(page);
  const target = page.getByTestId('issue-row').nth(4);
  const key = (await target.getAttribute('data-key'))!;
  await target.getByTestId('row-status').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'status');
  await expect(page.getByTestId('palette-target')).toHaveText(key);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

test('Server rejects: the value snaps back, the error toast with the reason stays', async ({ page }) => {
  await open(page);
  const target = focusedRow(page);
  const id = (await target.getAttribute('data-id'))!;
  const before = (await target.getAttribute('data-priority'))!;
  await setRejectWrites(true);
  try {
    await page.keyboard.press('p');
    await page.keyboard.type(before === '1' ? 'low' : 'urgent');
    await page.keyboard.press('Enter');
    const toast = page.locator('[data-testid="toast"][data-kind="error"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('not saved');
    await expect(toast.getByTestId('toast-detail')).toContainText('rejecting');
    await expect(toast.getByTestId('toast-action')).toHaveText('Try again');
    await expect(row(page, id)).toHaveAttribute('data-priority', before);
    await page.waitForTimeout(4500);
    await expect(toast).toBeVisible();
  } finally {
    await setRejectWrites(false);
  }
});

test('A status change touches exactly one row in the DOM', async ({ page }) => {
  await open(page);
  await page.waitForTimeout(300);
  const before = (await focusedRow(page).getAttribute('data-status'))!;
  await page.evaluate(() => {
    const touched = new Set<Element>();
    (window as unknown as { __touched: Set<Element> }).__touched = touched;
    new MutationObserver((records) => {
      for (const r of records) {
        const el = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest('[data-testid="issue-row"], [data-testid="group-header"]');
        touched.add(el ?? document.body);
      }
    }).observe(document.querySelector('[data-testid="list"]')!, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.keyboard.press('s');
  await page.keyboard.type(before === 'done' ? 'todo' : 'done');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const touched = await page.evaluate(() => [...(window as unknown as { __touched: Set<Element> }).__touched].map((e) => e.getAttribute('data-id') ?? e.tagName));
  expect(touched).toHaveLength(1);
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(focusedRow(page)).toHaveAttribute('data-status', before);
});

test('Display options: grouping by priority survives a reload', async ({ page }) => {
  await open(page, '/team/ORB');
  await page.keyboard.press('Shift+V');
  await page.getByTestId('display-grouping').selectOption('priority');
  await expect(page.getByTestId('group-header').first()).toContainText('Urgent');
  await page.goto('/inbox');
  await page.goto('/team/ORB');
  await expect(page.getByTestId('group-header').first()).toContainText('Urgent');
  await page.keyboard.press('Shift+V');
  await page.getByText('Restore defaults').click();
  await expect(page.getByTestId('group-header').first()).not.toContainText('Urgent');
});

test('Filtered view + open issue, reload, Esc: back to the same view with the filter', async ({ page }) => {
  await open(page, '/team/ORB/all?prio=2');
  await expect(page.getByTestId('filter-chip')).toContainText('Priority: High');
  await page.keyboard.press('Enter');
  const key = (await page.getByTestId('detail-key').textContent())!;
  await page.reload();
  await expect(page.getByTestId('detail-key')).toHaveText(key);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/team\/ORB\/all\?prio=2/);
  await expect(page.getByTestId('filter-chip')).toContainText('Priority: High');
});
