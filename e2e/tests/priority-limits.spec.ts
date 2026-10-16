// Priority limits (XLR8-91): settings → Priorities sets them for the instance; a hard limit refuses
// raising another issue to urgent, with an error toast that names what to lower first.
import { expect, test } from '@playwright/test';
import { allIssues, api, backend, open, settled } from '../support/helpers.ts';

const DEFAULTS = { urgent: { max: 1, hard: false }, high: { max: 3, hard: false } };
const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
const limits = async () => (await backend().query(api.meta.get, {})).priorityLimits;

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  await backend().mutation(api.instance.setPriorityLimits, { limits: DEFAULTS });
});

test('settings: mode and number per priority, saved for the instance', async ({ page }) => {
  await page.goto('/settings/priorities');
  const urgent = page.getByTestId('priority-limit-urgent');
  const high = page.getByTestId('priority-limit-high');
  await expect(urgent).toHaveAttribute('data-mode', 'warn');
  await page.getByTestId('priority-limit-urgent-mode').locator('button[data-mode="block"]').click();
  await expect(urgent).toHaveAttribute('data-mode', 'block');
  await expect.poll(limits).toMatchObject({ urgent: { max: 1, hard: true } });

  // No limit hides the number; back to "Warn" brings the last number back.
  await page.getByTestId('priority-limit-high-mode').locator('button[data-mode="off"]').click();
  await expect(page.getByTestId('priority-limit-high-max')).toHaveCount(0);
  await expect.poll(limits).toMatchObject({ high: { max: null, hard: false } });
  await page.getByTestId('priority-limit-high-mode').locator('button[data-mode="warn"]').click();
  await expect.poll(limits).toMatchObject({ high: { max: 3, hard: false } });
  await page.getByTestId('priority-limit-high-max').fill('5');
  await page.getByTestId('priority-limit-high-max').press('Enter');
  await expect.poll(limits).toMatchObject({ high: { max: 5, hard: false } });
  await expect(high).toContainText('More than 5 per team');
  // Not a number: the field falls back, nothing is saved.
  await page.getByTestId('priority-limit-high-max').fill('-2');
  await page.getByTestId('priority-limit-high-max').press('Enter');
  await expect(page.getByTestId('priority-limit-high-max')).toHaveValue('5');
});

test('hard limit: raising another issue to urgent is refused, the menu and the toast say why', async ({ page }) => {
  const client = backend();
  const meta = await client.query(api.meta.get, {});
  const orb = meta.teams.find((t) => t.key === 'ORB')!;
  const urgentOpen = (await allIssues()).filter((d) => d.teamId === orb._id && d.priority === 1 && d.deletedAt === undefined && OPEN.includes(d.status));
  // Seed data without an urgent ORB issue: make one (and take it back afterwards).
  const seeded = urgentOpen.length ? null : (await allIssues()).find((d) => d.teamId === orb._id && d.priority !== 1 && d.deletedAt === undefined && OPEN.includes(d.status))!;
  if (seeded) await client.mutation(api.issues.update, { ids: [seeded._id], patch: { priority: 1 } });
  const max = Math.max(urgentOpen.length, 1);
  try {
    await client.mutation(api.instance.setPriorityLimits, { limits: { ...DEFAULTS, urgent: { max, hard: true } } });
    await open(page, '/team/ORB/backlog?order=created');
    const target = page.locator('[data-testid="issue-row"]:not([data-priority="1"])').first();
    const id = (await target.getAttribute('data-id'))!;
    const before = (await allIssues()).find((d) => d._id === id)!.priority;
    await target.hover();
    await page.mouse.move(2, 890);
    await page.locator(`[data-testid="issue-row"][data-id="${id}"] [data-testid="row-priority"]`).click();
    await expect(page.locator('[data-testid="palette-item"][data-id="p:1"]')).toContainText(`Limit of ${max} reached`);
    await page.keyboard.press('1');
    const toast = page.getByTestId('toast').filter({ hasText: `Orbit: at most ${max} × Urgent open` });
    await expect(toast).toBeVisible();
    await expect(toast.getByTestId('toast-detail')).toContainText('Lower one of these first:');
    await expect(page.locator(`[data-testid="issue-row"][data-id="${id}"]`)).toHaveAttribute('data-priority', String(before));
    expect((await allIssues()).find((d) => d._id === id)!.priority).toBe(before);
    // "Downgrade …" opens the candidates.
    await toast.getByTestId('toast-action').click();
    await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'downgrade');
    await page.keyboard.press('Escape');
  } finally {
    if (seeded) await client.mutation(api.issues.update, { ids: [seeded._id], patch: { priority: seeded.priority } });
  }
});
