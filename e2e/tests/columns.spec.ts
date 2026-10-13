// The list as a grouped table. Wide: properties line up in columns under their icons in the group
// header. Medium: labels drop out. Narrow: the columns move right behind the title and the header
// icons disappear. CSS picks the tier (container query).
import { expect, test, type Page } from '@playwright/test';
import { open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

/** Column positions: per column, the left edges of the cells in the rows and in the first group header. */
async function layout(page: Page) {
  return await page.getByTestId('list').evaluate((list) => {
    const cols = ['labels', 'project', 'sprint', 'estimate', 'due'];
    const head = list.querySelector('[data-testid="group-header"]')!;
    const rows = [...list.querySelectorAll<HTMLElement>('[data-testid="issue-row"]')];
    const visible = (el: Element | null) => !!el && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const out: Record<string, { head: number | null; cells: number[] }> = {};
    for (const col of cols) {
      const h = head.querySelector(`.group-cols .c-${col}`);
      out[col] = {
        head: visible(h) ? Math.round(h!.getBoundingClientRect().left) : null,
        cells: rows.map((r) => r.querySelector(`.row-cols .c-${col}`)).filter(visible).map((c) => Math.round(c!.getBoundingClientRect().left)),
      };
    }
    // Gap title → first visible pill per row (narrow: right behind it)
    const gaps = rows
      .map((r) => {
        const title = r.querySelector('[data-testid="row-title"]')!.getBoundingClientRect();
        const box = r.querySelector('.row-cols')!.getBoundingClientRect();
        // Wrapped cells (second, clipped line) don't count; in the DOM from right to left.
        const shown = [...r.querySelectorAll('.row-cols .c')].filter((c) => {
          const b = c.getBoundingClientRect();
          return b.width > 0 && b.top < box.bottom - 1 && visible(c);
        });
        const first = shown.at(-1);
        return first ? { gap: Math.round(first.getBoundingClientRect().left - title.right), key: r.dataset.key } : null;
      })
      .filter((g) => g !== null);
    const headOpacity = Number(getComputedStyle(head.querySelector('.group-cols')!).opacity);
    return { out, gaps, headOpacity };
  });
}

test('Wide: columns line up under their icons in the group header, labels visible', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await open(page, '/all');
  const { out, headOpacity } = await layout(page);
  expect(headOpacity).toBe(1);
  for (const col of ['labels', 'project', 'estimate']) {
    const { head, cells } = out[col];
    expect(head, col).not.toBeNull();
    expect(cells.length, col).toBeGreaterThan(5);
    for (const x of cells) expect(Math.abs(x - head!), `${col}: cell at ${x}, icon at ${head}`).toBeLessThanOrEqual(1);
  }
});

test('Medium: labels and their icon gone, other columns aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1340, height: 900 });
  await open(page, '/all');
  const { out } = await layout(page);
  expect(out.labels.head).toBeNull();
  expect(out.labels.cells).toEqual([]);
  const { head, cells } = out.project;
  expect(head).not.toBeNull();
  for (const x of cells) expect(Math.abs(x - head!)).toBeLessThanOrEqual(1);
});

test('Narrow: columns right behind the title, header icons disappear; widening slides them back', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, '/all');
  const narrow = await layout(page);
  expect(narrow.headOpacity).toBe(0);
  expect(narrow.out.labels.cells).toEqual([]);
  expect(narrow.gaps.length).toBeGreaterThan(3);
  for (const { gap, key } of narrow.gaps) expect(gap, key).toBeLessThanOrEqual(16);
  // Widen the window: the same list switches to the wide tier without a reload.
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.waitForTimeout(500);
  const wide = await layout(page);
  expect(wide.headOpacity).toBe(1);
  expect(wide.out.project.cells.every((x) => Math.abs(x - wide.out.project.head!) <= 1)).toBe(true);
});
