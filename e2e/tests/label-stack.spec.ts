// Label chips in list rows and board cards (XLR8-60): whole chips as long as they fit, never cut
// mid-word; what no longer fits is counted in a "+n" chip whose tooltip names the rest; a click on
// the labels opens the label picker (touch screens have no tooltip).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

const TAG = 'Label-stack-test';
const NAMES = ['Alpha', 'Beta Testing', 'Gamma', 'Delta Longer Name', 'Epsilon'];

let title = '';
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
  title = `Stack ${stamp} ${TAG}`;
  await client.mutation(api.issues.create, { issues: [{ teamId: team._id, title, status: 'todo', labelIds: labelIds as never }] });
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

/** What a stack shows: whole chips, the "+n" chip that is not covered, and anything cut. */
async function inspect(stack: Locator) {
  return await stack.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const visible = (chip: Element) => {
      const b = chip.getBoundingClientRect();
      // Wrapped into the clipped second line, or squeezed out of the cell.
      return b.width > 0 && b.top < box.bottom - 1;
    };
    const labels = [...el.querySelectorAll<HTMLElement>('.label')].filter(visible);
    const covered = (chip: Element) => {
      const b = chip.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !hit || !chip.contains(hit);
    };
    const more = [...el.querySelectorAll<HTMLElement>('.more')].filter((chip) => visible(chip) && !covered(chip));
    return {
      total: el.querySelectorAll('.label').length,
      labels: labels.map((l) => l.textContent),
      cut: labels.filter((l) => l.scrollWidth > l.clientWidth || l.getBoundingClientRect().right > box.right + 0.5).map((l) => l.textContent),
      more: more.map((m) => ({ text: m.textContent, title: m.title, outside: m.getBoundingClientRect().right > box.right + 0.5 })),
    };
  });
}

async function expectStack(stack: Locator) {
  const s = await inspect(stack);
  expect(s.cut, 'no label cut mid-word').toEqual([]);
  expect(s.labels.length).toBeGreaterThan(0);
  const dropped = NAMES.length - s.labels.length;
  if (dropped === 0) expect(s.more).toEqual([]);
  else {
    expect(s.more).toHaveLength(1);
    expect(s.more[0].text).toBe(`+${dropped}`);
    expect(s.more[0].outside).toBe(false);
    // The tooltip names everything that is not shown as a chip.
    expect(s.more[0].title.split(', ')).toHaveLength(dropped);
    for (const name of NAMES.slice(NAMES.length - dropped)) expect(s.more[0].title).toContain(name);
  }
  return s;
}

for (const fontSize of ['normal', 'large']) {
  test(`List row (${fontSize} font): whole chips, "+n" for the rest`, async ({ page }) => {
    await page.addInitScript((size) => localStorage.setItem('xlr8:prefs', JSON.stringify({ fontSize: size })), fontSize);
    await open(page);
    const stack = page.getByTestId('issue-row').filter({ hasText: title }).locator('.c-labels');
    await expect(stack).toBeVisible();
    const s = await expectStack(stack);
    // In 184 px not all five fit.
    expect(s.labels.length).toBeLessThan(NAMES.length);
    // The first label always stays.
    expect(s.labels[0]).toContain(NAMES[0]);
  });
}

test('List row: a mouse click on the labels is a click on the row, no picker', async ({ page }) => {
  await open(page);
  await page.getByTestId('issue-row').filter({ hasText: title }).locator('.c-labels').click();
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

test.describe('Touch', () => {
  test.use({ hasTouch: true });

  test('List row: a tap on the labels opens the label picker with the full names', async ({ page }) => {
    await open(page);
    await page.getByTestId('issue-row').filter({ hasText: title }).locator('.c-labels').tap();
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-item').filter({ hasText: NAMES[3] })).toBeVisible();
  });

  test('Board card: a tap on the labels opens the label picker', async ({ page }) => {
    await open(page, '/team/ORB?layout=board');
    await page.getByTestId('issue-card').filter({ hasText: title }).locator('.lstack').tap();
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-item').filter({ hasText: NAMES[4] })).toBeVisible();
  });
});

for (const width of [1440, 412, 360]) {
  test(`Board card at ${width} px: whole chips, "+n" for the rest`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, '/team/ORB?layout=board');
    const card = page.getByTestId('issue-card').filter({ hasText: title });
    await expect(card).toBeVisible();
    const s = await expectStack(card.locator('.lstack'));
    expect(s.labels[0]).toContain(NAMES[0]);
    // Priority, status and the other chips of the bottom row stay inside the card.
    const inside = await card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.card-bottom > *')].every((c) => c.getBoundingClientRect().right <= box.right + 0.5);
    });
    expect(inside).toBe(true);
  });
}

async function hoverNames(page: Page) {
  const row = page.getByTestId('issue-row').filter({ hasText: title });
  return await row.locator('.label').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('title')]));
}

test('Every chip has its full name as tooltip', async ({ page }) => {
  await open(page);
  for (const [text, tip] of await hoverNames(page)) expect(tip).toBe(text);
});
