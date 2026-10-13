// Sprints: create, plan (issues from three teams, keyboard and drag), reorder the backlog, start,
// add late (also from a second client), close with decisions (impossible without all of them),
// carry over into the next sprint. Plus the priority budget and the identifier column. The tests
// build on each other.
import { expect, test, type Page } from '@playwright/test';
import { ConvexError } from 'convex/values';
import { api, backend, open, settled } from '../support/helpers.ts';

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

/** Row ids of a list in display order. */
async function ids(page: Page, testid: string) {
  return await page.getByTestId(testid).locator('[data-testid="issue-row"]').evaluateAll((rows) =>
    rows
      .map((r) => ({ id: r.getAttribute('data-id')!, key: r.getAttribute('data-key')!, top: parseFloat((r as HTMLElement).style.top) }))
      .sort((a, b) => a.top - b.top),
  );
}

async function meta() {
  return await backend().query(api.meta.get, {});
}

test('Without an active sprint: notice and "Plan sprint"; close the active one via the server first', async ({ page }) => {
  // Seed state: sprint 4 is active, sprint 5 is planning. Close sprint 4 here (everything back to the backlog).
  const client = backend();
  const active = (await meta()).sprints.find((s) => s.state === 'active')!;
  let missing: string[] = [];
  try {
    await client.mutation(api.sprints.close, { sprintId: active._id, decisions: [] });
  } catch (error) {
    missing = ((error as ConvexError<{ missing: string[] }>).data?.missing ?? []) as string[];
  }
  expect(missing.length).toBeGreaterThan(0);
  await client.mutation(api.sprints.close, { sprintId: active._id, decisions: missing.map((issueId) => ({ issueId: issueId as never, outcome: 'backlog' as const })) });

  await open(page, '/sprint');
  await expect(page.getByTestId('empty-plan')).toBeVisible();
  await expect(page.getByTestId('nav-sprint')).toContainText('Planning');
  await page.getByTestId('empty-plan').click();
  await expect(page).toHaveURL(/\/sprint\/plan$/);
});

test('Create a sprint, plan with keyboard and drag (three teams), reorder the backlog, goal and capacity', async ({ page }) => {
  await open(page, '/sprint/plan');
  await expect(page.getByTestId('plan-head')).toBeVisible();
  // Another sprint: 14 days from next Monday, named "Sprint <n>".
  await page.getByTestId('plan-new').click();
  await expect(page).toHaveURL(/\/sprint\/plan\/\d+$/);
  const number = Number(page.url().split('/').pop());
  await expect(page.getByTestId('view-title')).toHaveText(`Plan Sprint ${number}`);
  await expect(page.getByTestId('plan-sprint-count')).toHaveText('0');

  // Select one issue from each of three teams and move them into the sprint with →.
  const backlog = await ids(page, 'plan-backlog');
  const picked: { id: string; key: string }[] = [];
  for (const r of backlog) {
    const team = r.key.split('-')[0];
    if (!picked.some((p) => p.key.split('-')[0] === team)) picked.push(r);
    if (picked.length === 3) break;
  }
  expect(picked).toHaveLength(3);
  // Ctrl-click selects (like X) without opening.
  for (const p of picked) await page.getByTestId('plan-backlog').locator(`[data-id="${p.id}"] [data-testid="row-title"]`).click({ modifiers: ['Control'] });
  await page.mouse.move(2, 890);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('plan-sprint-count')).toHaveText('3');
  for (const p of picked) await expect(page.getByTestId('plan-sprint').locator(`[data-id="${p.id}"]`)).toHaveCount(1);
  await expect(page.getByTestId('plan-backlog').locator(`[data-id="${picked[0].id}"]`)).toHaveCount(0);

  // Tab: right column; ← returns the focused one.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('plan-col-sprint')).toHaveClass(/active/);
  const back = (await page.getByTestId('plan-sprint').locator('[data-testid="issue-row"].focused').getAttribute('data-id'))!;
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('plan-sprint-count')).toHaveText('2');
  await expect(page.getByTestId('plan-backlog').locator(`[data-id="${back}"]`)).toHaveCount(1);

  // Drag: back into the sprint.
  await page.getByTestId('plan-backlog').locator(`[data-id="${back}"]`).dragTo(page.getByTestId('plan-sprint'));
  await expect(page.getByTestId('plan-sprint-count')).toHaveText('3');
  await settled(page);

  // Reorder the backlog: Alt ↓ moves the focused issue down one place (optimistic, survives a reload).
  // (Dragging made the left column active; the mouse focuses the row.)
  const before = await ids(page, 'plan-backlog');
  await page.getByTestId('plan-backlog').locator(`[data-id="${before[0].id}"]`).hover();
  await expect(page.getByTestId('plan-col-backlog')).toHaveClass(/active/);
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(async () => (await ids(page, 'plan-backlog')).slice(0, 2).map((r) => r.id)).toEqual([before[1].id, before[0].id]);
  // Drag within the backlog: the fourth one to the very top.
  const fourth = before[3].id;
  const first = page.getByTestId('plan-backlog').locator(`[data-id="${before[1].id}"]`);
  await page.getByTestId('plan-backlog').locator(`[data-id="${fourth}"]`).dragTo(first, { targetPosition: { x: 200, y: 2 } });
  await expect.poll(async () => (await ids(page, 'plan-backlog'))[0].id).toBe(fourth);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId('plan-backlog').locator('[data-testid="issue-row"]').first()).toBeVisible();
  expect((await ids(page, 'plan-backlog')).slice(0, 3).map((r) => r.id)).toEqual([fourth, before[1].id, before[0].id]);

  // Goal and capacity
  await page.getByTestId('sprint-goal').fill('Three teams, one goal: the first real sprint.');
  await page.keyboard.press('Enter');
  await page.getByTestId('plan-capacity').fill('12');
  await page.getByTestId('plan-capacity').press('Enter');
  await expect(page.getByTestId('plan-points')).toContainText('/ 12 points');
  await settled(page);
  const sprint = (await meta()).sprints.find((s) => s.number === number)!;
  expect(sprint.goal).toBe('Three teams, one goal: the first real sprint.');
  expect(sprint.capacity).toBe(12);
  expect(sprint.state).toBe('planning');
});

test('Start, add late via the app and a second client, header with numbers', async ({ page }) => {
  const number = Math.max(...(await meta()).sprints.filter((s) => s.state === 'planning').map((s) => s.number));
  await open(page, `/sprint/plan/${number}`);
  await page.getByTestId('plan-start-sprint').click();
  await expect(page).toHaveURL(/\/sprint$/);
  await expect(page.getByTestId('sprint-head')).toBeVisible();
  await expect(page.getByTestId('sprint-goal')).toHaveValue('Three teams, one goal: the first real sprint.');
  await expect(page.getByTestId('sprint-issues')).toContainText('/ 3 done');
  await expect(page.locator('[data-testid="group-header"][data-group="planned"]')).toContainText('3');
  await expect(page.getByTestId('nav-sprint')).toContainText(`Sprint ${number}`);

  // Via the app: focus an issue in the backlog, Ctrl K "Add to the sprint".
  await open(page, '/backlog?group=none&order=created');
  const late = (await page.locator('[data-testid="issue-row"].focused').getAttribute('data-id'))!;
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Add to the sprint');
  await page.keyboard.press('Enter');
  await settled(page);

  // Second client (another device or an agent): adds another issue to the sprint late.
  const sprintId = (await meta()).sprints.find((s) => s.state === 'active')!._id;
  const teams = (await meta()).teams;
  const created = await backend().mutation(api.issues.create, { issues: [{ teamId: teams[1]._id, title: 'E2E added late by the second client', status: 'todo', estimate: 2 }] });
  const second = created.issues[0].id;
  await backend().mutation(api.sprints.add, { sprintId, issueIds: [second] });

  await open(page, '/sprint');
  const lateGroup = page.locator('[data-testid="group-header"][data-group="late"]');
  await expect(lateGroup).toContainText('Added late');
  await expect(lateGroup).toContainText('2');
  await expect(page.getByTestId('sprint-late')).toContainText('2 · 40 %');
  // Both are under "Added late" (after the group header), the planned ones above.
  const lateTop = parseFloat((await lateGroup.getAttribute('style'))!.match(/top:\s*([\d.]+)/)![1]);
  for (const id of [late, second]) {
    const top = parseFloat((await page.locator(`[data-testid="issue-row"][data-id="${id}"]`).getAttribute('style'))!.match(/top:\s*([\d.]+)/)![1]);
    expect(top).toBeGreaterThan(lateTop);
  }
  const items = await backend().query(api.sprints.items, { sprintId });
  expect(items.filter((i) => i.kind === 'late' && i.removedAt === null).map((i) => i.issueId).sort()).toEqual([late, second].sort());
});

test('Closing: impossible without all decisions, 1/2/3 and bulk decision, carried over as planned', async ({ page }) => {
  const { sprints } = await meta();
  const active = sprints.find((s) => s.state === 'active')!;
  const next = sprints.filter((s) => s.state === 'planning').sort((a, b) => a.number - b.number)[0];
  await open(page, '/sprint');
  await page.getByTestId('sprint-close').click();
  await expect(page).toHaveURL(/\/sprint\/close$/);
  await expect(page.getByTestId('close-submit')).toBeDisabled();
  await expect(page.getByTestId('close-missing')).toContainText('5 still without a decision');
  await expect(page.getByTestId('close-target')).toHaveValue(next._id);

  // The server rejects closing without decisions.
  await expect(backend().mutation(api.sprints.close, { sprintId: active._id, decisions: [] })).rejects.toThrow(/need a decision/);

  const rows = await ids(page, 'list');
  // 1 = next sprint (twice, the focus moves on)
  await page.keyboard.press('1');
  await page.keyboard.press('1');
  await expect(page.locator(`[data-id="${rows[0].id}"] [data-testid="row-decision"]`)).toHaveText('Next sprint');
  await expect(page.locator(`[data-id="${rows[1].id}"] [data-testid="row-decision"]`)).toHaveText('Next sprint');
  // 3 = cancel
  await page.keyboard.press('3');
  await expect(page.locator(`[data-id="${rows[2].id}"]`)).toHaveAttribute('data-decision', 'canceled');
  await expect(page.getByTestId('close-submit')).toBeDisabled();
  // Bulk decision: select the remaining two, 2 = backlog
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+j');
  await page.keyboard.press('2');
  await expect(page.locator(`[data-id="${rows[3].id}"]`)).toHaveAttribute('data-decision', 'backlog');
  await expect(page.locator(`[data-id="${rows[4].id}"]`)).toHaveAttribute('data-decision', 'backlog');
  await expect(page.getByTestId('close-missing')).toHaveCount(0);
  // Type the retro; Ctrl Enter in the field closes the sprint.
  await page.getByTestId('close-retro').click();
  await page.keyboard.type('Good: planning across three teams. Fewer late additions.');
  await page.keyboard.press('Control+Enter');

  await expect(page).toHaveURL(/\/sprint\/plan$/);
  await expect(page.getByTestId('view-title')).toHaveText(`Plan ${next.name}`);
  for (const r of rows.slice(0, 2)) await expect(page.getByTestId('plan-sprint').locator(`[data-id="${r.id}"]`)).toHaveCount(1);
  await settled(page);

  const closed = (await backend().query(api.sprints.list, {})).find((s) => s._id === active._id)!;
  expect(closed.state).toBe('closed');
  expect(closed.retro).toBe('Good: planning across three teams. Fewer late additions.');
  const nextItems = await backend().query(api.sprints.items, { sprintId: next._id });
  for (const r of rows.slice(0, 2)) expect(nextItems.find((i) => i.issueId === r.id && i.removedAt === null)).toMatchObject({ kind: 'planned', carriedFrom: active._id });
  const canceled = (await backend().query(api.issues.bucket, { bucket: 0 })).concat(...(await Promise.all([1, 2, 3, 4, 5, 6, 7].map((b) => backend().query(api.issues.bucket, { bucket: b })))));
  expect(canceled.find((i) => i._id === rows[2].id)?.status).toBe('canceled');

  // Overview: finished, with points and late share
  await page.goto('/sprints');
  const row = page.locator(`[data-testid="sprint-row"][data-number="${closed.number}"]`);
  await expect(row).toContainText('Finished');
  await expect(row).toContainText('2 · 40 %');
});

test('Priority budget: notice with candidates and "Downgrade", overview per team', async ({ page }) => {
  await open(page, '/all');
  // All issues is grouped by team: the budget is in the group header.
  await expect(page.getByTestId('group-budget').first()).toContainText(/Urgent \d+\/1 · High \d+\/3/);
  await open(page, '/team/ORB/backlog?order=created');
  const target = page.locator('[data-testid="issue-row"]:not([data-priority="2"])').first();
  const id = (await target.getAttribute('data-id'))!;
  await target.hover();
  await page.mouse.move(2, 890);
  await page.locator(`[data-testid="issue-row"][data-id="${id}"] [data-testid="row-priority"]`).click();
  await page.keyboard.press('2');
  const toast = page.getByTestId('toast').filter({ hasText: 'High open (budget 3)' });
  await expect(toast).toBeVisible();
  await expect(toast.getByTestId('toast-detail')).toContainText('So far:');
  await toast.getByTestId('toast-action').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-kind', 'downgrade');
  // Candidates: all open "High" issues of the team, including the one just set; downgrade another one.
  await expect(page.locator(`[data-testid="palette-item"][data-id="dg:${id}"]`)).toHaveCount(1);
  const other = page.locator(`[data-testid="palette-item"]:not([data-id="dg:${id}"])`).first();
  const victim = (await other.getAttribute('data-id'))!.slice(3);
  await expect(other).toContainText('→ Medium');
  await other.click();
  await settled(page);
  const docs = (await backend().query(api.issues.bucket, { bucket: 0 })).concat(...(await Promise.all([1, 2, 3, 4, 5, 6, 7].map((b) => backend().query(api.issues.bucket, { bucket: b })))));
  expect(docs.find((d) => d._id === id)?.priority).toBe(2);
  expect(docs.find((d) => d._id === victim)?.priority).toBe(3);
});

test('Identifiers are never clipped', async ({ page }) => {
  await open(page, '/all?group=none&order=created');
  const clipped = await page.locator('.row-key').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.textContent));
  expect(clipped).toEqual([]);
});
