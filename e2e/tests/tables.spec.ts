// Tables in texts: as wide as their content, wider than the text column up to the width of the
// content area, centered on the column, then wrapping at word boundaries and scrolling in their
// own box (SELF-112). Wiki page and issue description; phone included (nothing sticks out, SELF-32).
import { expect, test, type Page } from '@playwright/test';
import { api, backend, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
const table = (head: string[], rows: string[][]) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

const NARROW = table(['Key', 'Value'], [['a', 'b']]);
const MEDIUM = table(
  ['Role', 'Meaning', 'Counter', 'Notes'],
  [
    ['Wächter', 'Guards the gate and never leaves it', 'Flanking', 'First encounter'],
    ['Gegnerarten', 'Everything that attacks the player', 'Range', 'Grows with every level'],
    ['Figuren', 'The pieces on the board', 'Tempo', 'Fixed set of six'],
  ],
);
const cols = (n: number) => Array.from({ length: n }, (_, i) => `Column ${i + 1}`);
const sentence = 'Text of a cell that is long enough to need room';
// About 1200 px of content: wider than the column (740) but narrower than a laptop window.
const WIDE = table(cols(4), [Array.from({ length: 4 }, () => sentence), Array.from({ length: 4 }, () => sentence)]);
// Wider than any window, even with every cell wrapped to its longest word.
const HUGE = table(cols(24), [Array.from({ length: 24 }, () => 'Configuration')]);

const TEXT = `Before the tables.\n\n${NARROW}\n\nBetween.\n\n${MEDIUM}\n\nBetween.\n\n${WIDE}\n\nBetween.\n\n${HUGE}\n\nAfter the tables.\n`;

async function wikiPage(title: string) {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  if (!team.wiki) await backend().mutation(api.teams.update, { teamId: team._id, wiki: 'on' });
  const { articleId } = await backend().mutation(api.wiki.create, { teamId: team._id, title, markdown: TEXT });
  return articleId;
}

async function issuePage(title: string) {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, description: TEXT }] });
  return issues[0]!.identifier;
}

interface Boxes {
  area: { left: number; right: number; scrollWidth: number; clientWidth: number };
  column: { left: number; right: number };
  tables: { left: number; right: number; scrolls: boolean; brokenWords: number }[];
}

/** Geometry of the text column, the content area and the four tables, plus words cut in the middle. */
async function measure(page: Page, areaSelector: string, bodySelector: string): Promise<Boxes> {
  return await page.evaluate(
    ([areaSel, bodySel]) => {
      const area = document.querySelector<HTMLElement>(areaSel!)!;
      const md = document.querySelector<HTMLElement>(`${bodySel} .md`)!;
      const a = area.getBoundingClientRect();
      const c = md.getBoundingClientRect();
      const tables = [...md.querySelectorAll<HTMLElement>('.md-scroll')].map((el) => {
        const r = el.getBoundingClientRect();
        // A word is cut when one cell shows its single word on more than one line.
        let brokenWords = 0;
        for (const cell of el.querySelectorAll<HTMLElement>('td, th')) {
          const text = cell.textContent ?? '';
          if (/\s/.test(text.trim()) || !text.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(cell);
          if (new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size > 1) brokenWords++;
        }
        return { left: r.left, right: r.right, scrolls: el.scrollWidth > el.clientWidth + 1, brokenWords };
      });
      return { area: { left: a.left, right: a.right, scrollWidth: area.scrollWidth, clientWidth: area.clientWidth }, column: { left: c.left, right: c.right }, tables };
    },
    [areaSelector, bodySelector],
  );
}

function expectLayout(b: Boxes, label: string, { wideRoom }: { wideRoom: boolean }) {
  const [narrow, medium, wide, huge] = b.tables as [Boxes['tables'][0], Boxes['tables'][0], Boxes['tables'][0], Boxes['tables'][0]];
  const center = (b.column.left + b.column.right) / 2;
  const middle = (t: { left: number; right: number }) => (t.left + t.right) / 2;
  // Nothing makes the content area itself scroll sideways.
  expect(b.area.scrollWidth, `${label}: area scrolls sideways`).toBeLessThanOrEqual(b.area.clientWidth);
  for (const t of b.tables) {
    // Never outside the area (and so never over the sidebar), words stay whole.
    expect(t.left, `${label}: left of the area`).toBeGreaterThanOrEqual(b.area.left - 0.5);
    expect(t.right, `${label}: right of the area`).toBeLessThanOrEqual(b.area.right + 0.5);
    expect(t.brokenWords, `${label}: words cut in the middle`).toBe(0);
  }
  // A short table grows to the text width.
  expect(narrow.left, `${label}: narrow table left`).toBeCloseTo(b.column.left, 0);
  expect(narrow.right, `${label}: narrow table right`).toBeCloseTo(b.column.right, 0);
  // Wider than the column: centered on it.
  for (const t of [medium, wide, huge]) {
    if (t.right - t.left > b.column.right - b.column.left + 1) expect(middle(t), `${label}: centered on the column`).toBeCloseTo(center, 0);
  }
  if (wideRoom) {
    expect(wide.right - wide.left, `${label}: wider than the column`).toBeGreaterThan(b.column.right - b.column.left + 100);
    expect(wide.scrolls, `${label}: fits, no scrolling`).toBe(false);
  }
  // Wider than the window: its own scroll box.
  expect(huge.scrolls, `${label}: huge table scrolls`).toBe(true);
}

const PLACES = [
  { name: 'wiki', area: '.wiki-main', body: '[data-testid="article-body"]' },
  { name: 'issue', area: '.detail-main', body: '[data-testid="issue-description"], .desc.view' },
] as const;

for (const place of PLACES) {
  const go = async (page: Page) => {
    if (place.name === 'wiki') {
      const id = await wikiPage(`Tables ${Date.now()}`);
      await page.goto(`/wiki/${id}`);
      await expect(page.getByTestId('article')).toHaveAttribute('data-id', id);
    } else {
      const key = await issuePage(`Tables ${Date.now()}`);
      await page.goto(`/issue/${key}`);
    }
    await expect(page.locator(`${place.body} .md-scroll`).first()).toBeVisible();
    await page.waitForTimeout(450); // enter animation
  };

  test(`${place.name}: wide window — tables grow past the column, centered, within the area`, async ({ page }) => {
    await page.setViewportSize({ width: 1900, height: 1000 });
    await go(page);
    expectLayout(await measure(page, place.area, place.body), `${place.name} 1900`, { wideRoom: true });
  });

  test(`${place.name}: laptop window`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await go(page);
    expectLayout(await measure(page, place.area, place.body), `${place.name} 1366`, { wideRoom: true });
  });

  test(`${place.name}: phone — nothing sticks out, tables scroll in their own box`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go(page);
    const b = await measure(page, place.area, place.body);
    expectLayout(b, `${place.name} 390`, { wideRoom: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test('Editing a page: the tables keep their width and place', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  const id = await wikiPage(`Tables edit ${Date.now()}`);
  await page.goto(`/wiki/${id}`);
  await expect(page.locator('[data-testid="article-body"] .md-scroll').first()).toBeVisible();
  await page.waitForTimeout(450);
  const edges = (selector: string) =>
    page.evaluate((sel) => [...document.querySelectorAll(`${sel} .md-scroll`)].map((el) => Math.round(el.getBoundingClientRect().left) + ':' + Math.round(el.getBoundingClientRect().right)), selector);
  const reading = await edges('[data-testid="article-body"]');
  await page.getByTestId('article-body').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('article-editor')).toBeVisible();
  const editing = await edges('[data-testid="article-editor"]');
  expect(editing).toHaveLength(4);
  expect(editing).toEqual(reading);
});

test('Comments: a table stays inside the comment (no breakout rule outside the text column)', async ({ page }) => {
  const key = await issuePage(`Tables in comments ${Date.now()}`);
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto(`/issue/${key}`);
  await expect(page.locator('.desc.view .md-scroll').first()).toBeVisible();
  // Comments use the same markup; only `.desc` inside the content areas may grow past the column.
  const max = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'md';
    probe.innerHTML = '<div class="md-table"><div class="md-scroll"></div></div>';
    document.querySelector('.detail-content')!.append(probe);
    const value = getComputedStyle(probe.querySelector('.md-scroll')!).maxWidth;
    probe.remove();
    return value;
  });
  expect(max).toBe('100%');
});
