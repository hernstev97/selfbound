// Label chips in list rows and board cards (XLR8-60): up to three chips in their natural width, each
// overlapping the end of the one before it; when the room is short they shrink and slide under
// their neighbor, never truncated while there is room; further labels in one "+n" chip whose tooltip
// names them; a tap on the labels opens the label picker (touch has no tooltip).
import { expect, test, type Locator } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

const TAG = 'Label-stack-test';
const NAMES = ['Alpha', 'Beta Testing', 'Gamma', 'Delta Longer Name', 'Epsilon'];

let many = ''; // all five labels
let two = ''; // two short ones
let one = ''; // one label
let labelIds: string[] = [];

test.beforeEach(async () => {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const stamp = Date.now();
  labelIds = [];
  // Short suffix: label names stay unique but about as wide as real ones.
  const suffix = (stamp % 1296).toString(36);
  for (const [i, name] of NAMES.entries()) labelIds.push((await client.mutation(api.labels.create, { name: `${name} ${suffix}`, hue: 40 + i * 60 })).labelId);
  [many, two, one] = [`Many ${stamp} ${TAG}`, `Two ${stamp} ${TAG}`, `One ${stamp} ${TAG}`];
  const ids = (...i: number[]) => i.map((n) => labelIds[n]) as never;
  await client.mutation(api.issues.create, {
    issues: [
      { teamId: team._id, title: many, status: 'todo', labelIds: ids(0, 1, 2, 3, 4) },
      { teamId: team._id, title: two, status: 'todo', labelIds: ids(0, 2) },
      { teamId: team._id, title: one, status: 'todo', labelIds: ids(0) },
    ],
  });
});

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  const client = backend();
  for (let bucket = 0; ; bucket++) {
    const docs = await client.query(api.issues.bucket, { bucket });
    if (docs.length === 0) break;
    const ids = docs.filter((d) => d.title.includes(TAG) && d.deletedAt === undefined).map((d) => d._id);
    if (ids.length) await client.mutation(api.issues.remove, { ids: ids as never });
  }
  for (const labelId of labelIds) await client.mutation(api.labels.update, { labelId: labelId as never, archived: true });
});

/** What a stack shows: its chips, whether their text is cut, and whether the next chip covers the cut. */
async function inspect(stack: Locator) {
  return await stack.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const chips = [...el.children] as HTMLElement[];
    return {
      labels: chips.filter((c) => c.classList.contains('label')).map((c) => c.textContent),
      more: chips.filter((c) => c.classList.contains('more')).map((c) => ({ text: c.textContent, title: c.title })),
      outside: chips.filter((c) => c.getBoundingClientRect().right > box.right + 0.5 || c.getBoundingClientRect().left < box.left - 0.5).map((c) => c.textContent),
      // Text cut off: allowed only under the next chip (that is the overlap), never in the open.
      cutInTheOpen: chips
        .filter((c, i) => c.classList.contains('label') && c.scrollWidth > c.clientWidth && !(chips[i + 1] && chips[i + 1].getBoundingClientRect().left < c.getBoundingClientRect().right - 0.5))
        .map((c) => c.textContent),
      cut: chips.filter((c) => c.classList.contains('label') && c.scrollWidth > c.clientWidth).map((c) => c.textContent),
    };
  });
}

const rowStack = (page: Parameters<typeof open>[0], title: string) => page.getByTestId('issue-row').filter({ hasText: title }).locator('.c-labels');
const cardStack = (page: Parameters<typeof open>[0], title: string) => page.getByTestId('issue-card').filter({ hasText: title }).locator('.lstack');

for (const fontSize of ['normal', 'large']) {
  test(`List row, five labels (${fontSize} font): three chips overlap, "+2" names the rest`, async ({ page }) => {
    await page.addInitScript((size) => localStorage.setItem('xlr8:prefs', JSON.stringify({ fontSize: size })), fontSize);
    await open(page);
    const stack = rowStack(page, many);
    await expect(stack).toBeVisible();
    const s = await inspect(stack);
    expect(s.labels).toHaveLength(3);
    expect(s.outside).toEqual([]);
    expect(s.cutInTheOpen).toEqual([]);
    // Three chips do not fit in 184 px: the first ones are cut under their neighbor.
    expect(s.cut.length).toBeGreaterThan(0);
    expect(s.more).toHaveLength(1);
    expect(s.more[0].text).toBe('+2');
    expect(s.more[0].title).toContain(NAMES[3]);
    expect(s.more[0].title).toContain(NAMES[4]);
  });
}

test('Room enough: nothing is truncated (list row and card)', async ({ page }) => {
  await open(page);
  for (const stack of [rowStack(page, two), rowStack(page, one)]) expect((await inspect(stack)).cut).toEqual([]);
  await open(page, '/team/ORB?layout=board');
  for (const stack of [cardStack(page, two), cardStack(page, one)]) {
    const s = await inspect(stack);
    expect(s.labels.length).toBeGreaterThan(0);
    expect(s.cut).toEqual([]);
  }
});

test('List row: a mouse click on the labels is a click on the row, no picker', async ({ page }) => {
  await open(page);
  await rowStack(page, many).click();
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

test.describe('Touch', () => {
  test.use({ hasTouch: true });

  test('List row: a tap on the labels opens the label picker with the full names', async ({ page }) => {
    await open(page);
    await rowStack(page, many).tap();
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-item').filter({ hasText: NAMES[3] })).toBeVisible();
  });

  test('Board card: a tap on the labels opens the label picker', async ({ page }) => {
    await open(page, '/team/ORB?layout=board');
    await cardStack(page, many).tap();
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-item').filter({ hasText: NAMES[4] })).toBeVisible();
  });
});

for (const width of [1440, 412, 360]) {
  test(`Board card at ${width} px: chips stay inside the card, overlap instead of truncating`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, '/team/ORB?layout=board');
    const card = page.getByTestId('issue-card').filter({ hasText: many });
    await expect(card).toBeVisible();
    const s = await inspect(cardStack(page, many));
    expect(s.labels).toHaveLength(3);
    expect(s.outside).toEqual([]);
    expect(s.cutInTheOpen).toEqual([]);
    expect(s.more.map((m) => m.text)).toEqual(['+2']);
    // Priority, status and the other chips of the bottom row stay inside the card.
    const inside = await card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.card-bottom > *')].every((c) => c.getBoundingClientRect().right <= box.right + 0.5);
    });
    expect(inside).toBe(true);
  });
}

test('Every chip has its full name as tooltip', async ({ page }) => {
  await open(page);
  const tips = await rowStack(page, many).locator('.label').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('title')]));
  for (const [text, tip] of tips) expect(tip).toBe(text);
});
