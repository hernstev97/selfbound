// Board cards (XLR8-89): the title is always shown in full (wrapped, descenders intact), cards
// grow with it, a column with many cards stays windowed and consistent while scrolling and moving
// the focus, and reduced motion turns the gliding off.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

const TAG = 'Board-cards-test';
const stamp = Date.now();
const LONG = `Long ${stamp} ${TAG}: investigate why the nightly import of archived issues from the old tracker keeps timing out when a team has more than a thousand comments`;
const WORD = `Word ${stamp} ${TAG} https://example.com/a/very/long/path/without/any/spaces/that/would/never/fit/into/a/narrow/column/at/all`;
const SHORT = `Short ${stamp} ${TAG} gypsy jumpy`;
const MANY = 150;

test.beforeAll(async () => {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const filler = ['Fix it', 'Rework the sync status indicator in the sidebar', 'Investigate why importing archived projects with many linked pull requests fails halfway'];
  const issues = [
    { teamId: team._id, title: LONG, status: 'todo' as const },
    { teamId: team._id, title: WORD, status: 'todo' as const },
    { teamId: team._id, title: SHORT, status: 'todo' as const },
    ...Array.from({ length: MANY }, (_, i) => ({ teamId: team._id, title: `${filler[i % 3]} ${i} ${TAG}`, status: 'backlog' as const })),
  ];
  // At most 50 issues per call.
  for (let i = 0; i < issues.length; i += 50) await client.mutation(api.issues.create, { issues: issues.slice(i, i + 50) });
});

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test.afterAll(async () => {
  const client = backend();
  for (let bucket = 0; ; bucket++) {
    const docs = await client.query(api.issues.bucket, { bucket });
    if (docs.length === 0) break;
    const ids = docs.filter((d) => d.title.includes(TAG) && d.deletedAt === undefined).map((d) => d._id);
    if (ids.length) await client.mutation(api.issues.remove, { ids: ids as never });
  }
});

const column = (page: Page, name: string) => page.locator('[data-testid="board-column"]').filter({ has: page.getByTestId('column-name').getByText(name, { exact: true }) });

/** What a card title occupies: whether any of it is cut off, and whether it stays inside the card. */
async function inspect(card: Locator) {
  return await card.evaluate((el) => {
    const title = el.querySelector<HTMLElement>('[data-testid="card-title"]')!;
    const style = getComputedStyle(title);
    const t = title.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    return {
      clamp: style.getPropertyValue('-webkit-line-clamp'),
      overflowY: style.overflowY,
      lineHeightRatio: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
      clipped: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1,
      inside: t.left >= c.left && t.right <= c.right + 0.5 && t.bottom <= c.bottom - 8 && t.top >= c.top,
      lines: Math.round(t.height / parseFloat(style.lineHeight)),
      height: c.height,
    };
  });
}

for (const [name, dir] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`Titles are shown in full, also long ones and long words (${name})`, async ({ page }) => {
    await page.setViewportSize(dir);
    await open(page, '/team/ORB/all?order=created&layout=board');
    const todo = column(page, 'Todo');
    const long = await inspect(todo.getByTestId('issue-card').filter({ hasText: LONG }));
    const word = await inspect(todo.getByTestId('issue-card').filter({ hasText: WORD }));
    const short = await inspect(todo.getByTestId('issue-card').filter({ hasText: SHORT }));
    for (const shown of [long, word, short]) {
      expect(shown.clamp).toBe('none');
      expect(shown.overflowY).toBe('visible');
      expect(shown.clipped).toBe(false);
      expect(shown.inside).toBe(true);
      // Room above and below the letters: descenders (g, j, p, y) are not cut.
      expect(shown.lineHeightRatio).toBeGreaterThanOrEqual(1.3);
    }
    expect(long.lines).toBeGreaterThanOrEqual(3);
    expect(word.lines).toBeGreaterThanOrEqual(2);
    expect(short.lines).toBeLessThanOrEqual(2);
    expect(long.height).toBeGreaterThan(short.height + 30);
    // Larger than before (76 px, 13 px type).
    expect(short.height).toBeGreaterThan(90);
  });
}

test('Phone: the closed sidebar casts no shadow into the screen edge (XLR8-61)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/team/ORB/all?order=created&layout=board');
  expect(await page.locator('aside.sidebar').evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
});

test('A column with many cards stays windowed; measured heights stay consistent while scrolling', async ({ page }) => {
  await open(page, '/team/ORB/all?order=created&layout=board');
  const backlog = column(page, 'Backlog');
  const scroll = backlog.getByTestId('column-scroll');
  expect(Number(await backlog.getByTestId('column-count').innerText())).toBeGreaterThanOrEqual(MANY);

  /** Consecutive cards in the DOM sit exactly one gap apart (heights measured, tops from the offsets). */
  const gaps = async () =>
    await scroll.evaluate((el) => {
      const cards = [...el.querySelectorAll<HTMLElement>('.card')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
      const off: number[] = [];
      for (let i = 1; i < cards.length; i++) off.push(parseFloat(cards[i].style.top) - (parseFloat(cards[i - 1].style.top) + cards[i - 1].offsetHeight));
      return { count: cards.length, off };
    });
  const settle = async () => await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));

  for (const to of [0, 2500, 6000, 1200, 0]) {
    await scroll.evaluate((el, y) => (el.scrollTop = y), to);
    await settle();
    const { count, off } = await gaps();
    expect(count).toBeGreaterThan(3);
    expect(count).toBeLessThan(40);
    for (const gap of off) expect(Math.abs(gap - 8)).toBeLessThan(1);
  }

  // Scrolling up through unmeasured cards keeps the card in view where it is.
  await scroll.evaluate((el) => (el.scrollTop = 5000));
  await settle();
  const anchor = backlog.getByTestId('issue-card').nth(8);
  const id = (await anchor.getAttribute('data-id'))!;
  const before = await anchor.evaluate((el) => el.getBoundingClientRect().top);
  await scroll.evaluate((el) => (el.scrollTop -= 160));
  await settle();
  const after = await backlog.locator(`[data-testid="issue-card"][data-id="${id}"]`).evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - before - 160)).toBeLessThan(2);
});

test('Moving the focus down a long column keeps the focused card in view', async ({ page }) => {
  await open(page, '/team/ORB/all?order=created&layout=board');
  const backlog = column(page, 'Backlog');
  await backlog.getByTestId('issue-card').first().hover();
  await page.mouse.move(2, 890);
  for (let i = 0; i < 45; i++) await page.keyboard.press('j');
  const focused = backlog.locator('[data-testid="issue-card"].focused');
  await expect(focused).toHaveCount(1);
  // The last reveal may wait one more frame for the card's measured height.
  await expect
    .poll(() =>
      focused.evaluate((el) => {
        const card = el.getBoundingClientRect();
        const box = el.closest('[data-testid="column-scroll"]')!.getBoundingClientRect();
        return card.top >= box.top - 1 && card.bottom <= box.bottom + 1;
      }),
    )
    .toBe(true);
  for (let i = 0; i < 45; i++) await page.keyboard.press('k');
  await expect(backlog.locator('[data-testid="issue-card"].focused')).toHaveCount(1);
  await expect.poll(() => backlog.getByTestId('column-scroll').evaluate((el) => el.scrollTop)).toBeLessThan(400);
});

test('After a move the cards glide; with reduced motion they do not', async ({ page }) => {
  await open(page, '/team/ORB/all?order=created&layout=board');
  const move = async () => {
    await column(page, 'Todo').getByTestId('issue-card').first().hover();
    await page.mouse.move(2, 890);
    await page.keyboard.press('Shift+ArrowRight');
  };
  await move();
  await expect(page.getByTestId('board')).toHaveClass(/settling/);
  await expect(page.getByTestId('board')).not.toHaveClass(/settling/);
  await settled(page);
  await page.keyboard.press('Control+z');
  await settled(page);

  // The undo glides too; wait for it so its class is not mistaken for the next move's.
  await expect(page.getByTestId('board')).not.toHaveClass(/settling/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await move();
  // Right after the key press: with motion the class stays for about 300 ms.
  await page.waitForTimeout(120);
  expect(await page.getByTestId('board').getAttribute('class')).not.toContain('settling');
  await settled(page);
  await page.keyboard.press('Control+z');
});
