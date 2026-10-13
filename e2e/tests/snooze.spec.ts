// Snooze: H hides an issue until a day, the Snoozed view lists it, search and the filter still find it.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, open, resolve, row, settled } from '../support/helpers.ts';

async function fresh(title: string, status: 'todo' | 'backlog' = 'todo') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, status }] });
  return issues[0];
}

const dayAfter = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const snoozedUntil = async (identifier: string) => {
  const found = await resolve(identifier);
  const meta = await backend().query(api.meta.counter, {});
  for (let bucket = 0; bucket <= Math.floor(meta.maxSeq / 64); bucket++) {
    const hit = (await backend().query(api.issues.bucket, { bucket })).find((d) => d._id === found!.id);
    if (hit) return hit.snoozedUntil ?? null;
  }
  return null;
};

/** Hover moves the focus to the row (a click would open the issue). */
async function focusRow(page: Page, id: string) {
  await row(page, id).hover();
  await expect(row(page, id)).toHaveClass(/focused/);
  await page.mouse.move(2, 890);
}

test('H > Tomorrow hides the issue; Snoozed view, search and filter still find it; Shift+H brings it back', async ({ page }) => {
  const issue = await fresh(`Snooze me ${Date.now()}`);
  await open(page, '/all?group=none&order=created');
  await expect(row(page, issue.id)).toHaveCount(1);
  await focusRow(page, issue.id);

  await page.keyboard.press('h');
  const picker = page.getByTestId('palette');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('calendar')).toBeVisible();
  await picker.getByText('Tomorrow', { exact: true }).click();

  await expect(row(page, issue.id)).toHaveCount(0);
  await expect(page.getByTestId('toast').last()).toContainText(`${issue.identifier} snoozed until`);
  await settled(page);
  expect(await snoozedUntil(issue.identifier)).toBe(dayAfter(1));

  // The sidebar shows the Snoozed entry with a count; the view lists the issue.
  await expect(page.getByTestId('snoozed-count')).toBeVisible();
  await page.getByTestId('nav-snoozed').click();
  await expect(page).toHaveURL(/\/snoozed/);
  await expect(row(page, issue.id)).toHaveCount(1);

  // Search finds it regardless.
  await page.keyboard.press('/');
  await page.getByTestId('palette').getByRole('textbox').fill(issue.identifier);
  await expect(page.getByTestId('palette').getByText(issue.identifier).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // A normal list shows it again with the filter "Include snoozed".
  await page.goto('/all?group=none&order=created&snoozed=1');
  await expect(row(page, issue.id)).toHaveCount(1);
  await page.goto('/all?group=none&order=created');
  await expect(row(page, issue.id)).toHaveCount(0);

  // Unsnooze with Shift+H in the Snoozed view; Undo snoozes it again.
  await open(page, '/snoozed');
  await focusRow(page, issue.id);
  await page.keyboard.press('Shift+H');
  await expect(row(page, issue.id)).toHaveCount(0);
  await settled(page);
  expect(await snoozedUntil(issue.identifier)).toBeNull();
  await page.keyboard.press('Control+z');
  await expect(row(page, issue.id)).toHaveCount(1);
  await settled(page);
  expect(await snoozedUntil(issue.identifier)).toBe(dayAfter(1));
});

test('Context menu on a selection snoozes several issues at once; the date picker takes typed days', async ({ page }) => {
  const a = await fresh(`Bulk A ${Date.now()}`);
  const b = await fresh(`Bulk B ${Date.now()}`, 'backlog');
  await open(page, '/all?group=none&order=created');
  // Newest first: b is above a.
  await focusRow(page, b.id);
  await page.keyboard.press('x');
  await page.keyboard.press('j');
  await page.keyboard.press('x');
  await row(page, a.id).click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Snooze/ }).hover();
  await page.getByTestId('context-submenu').getByText('Next week', { exact: true }).click();
  await expect(row(page, a.id)).toHaveCount(0);
  await expect(row(page, b.id)).toHaveCount(0);
  await settled(page);
  expect(await snoozedUntil(a.identifier)).not.toBeNull();
  expect(await snoozedUntil(a.identifier)).toBe(await snoozedUntil(b.identifier));

  // Typed day in the picker (the issue page).
  const c = await fresh(`Typed ${Date.now()}`);
  await open(page, `/issue/${c.identifier}`);
  await expect(page.getByTestId('detail-snooze')).toBeVisible();
  await page.getByTestId('detail-snooze').click();
  await page.getByTestId('palette').getByRole('textbox').fill('+4');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-snooze')).toContainText('Snoozed until');
  await settled(page);
  expect(await snoozedUntil(c.identifier)).toBe(dayAfter(4));
});

test('Done ends the snooze', async ({ page }) => {
  const issue = await fresh(`Close me ${Date.now()}`);
  await backend().mutation(api.issues.update, { ids: [issue.id], patch: { snoozedUntil: dayAfter(3) } });
  await open(page, `/issue/${issue.identifier}`);
  await expect(page.getByTestId('detail-snooze')).toContainText('Snoozed until');
  await page.keyboard.press('s');
  await page.getByTestId('palette').getByRole('textbox').fill('done');
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await snoozedUntil(issue.identifier)).toBeNull();
});
