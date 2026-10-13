// Statuses per team: create and archive statuses in the settings, the picker (S) shows the team's
// statuses, groups by status, default status for new issues.
import { expect, test } from '@playwright/test';
import { agentCall, api, backend, focusedRow, open, row, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

async function mosaik() {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'MOSAIK')!;
  return { team, states: meta.workflowStates.filter((s) => s.teamId === team._id) };
}

test('Custom status: create, set via the picker (S), group in the list, undo; archive with a move', async ({ page }) => {
  await page.goto('/settings/teams/MOSAIK');
  const workflow = page.getByTestId('workflow');
  await expect(workflow.getByTestId('state-row')).toHaveCount(8);
  await page.getByTestId('state-add-started').click();
  await page.getByTestId('state-new-name').fill('Testing');
  await page.getByTestId('state-new-name').press('Enter');
  const testing = workflow.locator('[data-testid="state-row"][data-name="Testing"]');
  await expect(testing).toBeVisible();
  const started = page.locator('[data-testid="state-type"][data-type="started"] + .card-list [data-testid="state-row"]');
  await expect.poll(() => started.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')))).toEqual(['In Progress', 'In Review', 'Testing']);

  // In the team's list: S shows "Testing", choosing it sets the status, a "Testing" group appears.
  await open(page, '/team/MOSAIK/all?group=status&order=created');
  const id = (await focusedRow(page).getAttribute('data-id'))!;
  const before = (await row(page, id).getByTestId('row-status').getAttribute('aria-label'))!;
  await page.keyboard.press('s');
  await expect(page.getByTestId('palette-item').filter({ hasText: 'Testing' })).toBeVisible();
  await page.keyboard.type('Testing');
  await page.keyboard.press('Enter');
  await expect(row(page, id).getByTestId('row-status')).toHaveAttribute('aria-label', 'Testing');
  await expect(row(page, id)).toHaveAttribute('data-status', 'in_progress');
  await expect(page.locator('[data-testid="group-header"][data-group="started:testing"]')).toContainText('Testing');
  await settled(page);
  await page.keyboard.press('Control+z');
  await expect(row(page, id).getByTestId('row-status')).toHaveAttribute('aria-label', before);
  await settled(page);
  await page.keyboard.press('Control+Shift+z');
  await expect(row(page, id).getByTestId('row-status')).toHaveAttribute('aria-label', 'Testing');
  await settled(page);

  // Archive: the issue moves to "In Review".
  await page.goto('/settings/teams/MOSAIK');
  await testing.getByTestId('state-archive').click();
  await expect(page.getByTestId('state-archive-dialog')).toContainText('1 issue is in this status');
  const review = (await mosaik()).states.find((s) => s.name === 'In Review')!;
  await page.getByTestId('state-move-to').selectOption(review._id);
  await page.getByTestId('state-archive-confirm').click();
  await expect(page.getByTestId('toast').filter({ hasText: /"Testing" archived, 1 issues? moved/ })).toBeVisible();
  await expect(testing).toHaveCount(0);
  const after = await backend().query(api.issues.resolve, { identifier: id });
  expect(after).not.toBeNull();
  const meta = await backend().query(api.meta.get, {});
  expect(meta.workflowStates.find((s) => s.name === 'Testing' && s.teamId === (meta.teams.find((t) => t.key === 'MOSAIK')!._id))?.archivedAt).toBeDefined();
});

test('Default status: new issues of the team start there; a rename shows in the list at once', async ({ page }) => {
  await page.goto('/settings/teams/MOSAIK');
  const todo = page.locator('[data-testid="state-row"][data-name="Todo"]');
  await todo.getByTestId('state-make-default').click();
  await expect(todo.getByTestId('state-default')).toBeVisible();
  await todo.getByTestId('state-name').fill('Up next');
  await todo.getByTestId('state-name').press('Enter');
  await expect(page.locator('[data-testid="state-row"][data-name="Up next"]')).toBeVisible();
  await settled(page);

  await open(page, '/team/MOSAIK/all?group=none&order=created');
  await page.keyboard.press('c');
  await expect(page.getByTestId('create-status')).toContainText('Up next');
  await page.getByTestId('create-title').fill('Starts in the default status');
  await page.keyboard.press('Control+Enter');
  const created = page.getByTestId('issue-row').filter({ hasText: 'Starts in the default status' });
  await expect(created.getByTestId('row-status')).toHaveAttribute('aria-label', 'Up next');
  await settled(page);

  // Back to the previous state (other tests expect "Todo" and backlog as the default).
  const { team, states } = await mosaik();
  const renamed = states.find((s) => s.name === 'Up next')!;
  await backend().mutation(api.workflowStates.update, { stateId: renamed._id, name: 'Todo' });
  await backend().mutation(api.workflowStates.setWorkflow, { teamId: team._id, defaultStateId: null });
});

test('Fixed order: enable with suggested exceptions, the picker shows only allowed targets, add an exception', async ({ page }) => {
  await page.goto('/settings/teams/MOSAIK');
  await page.getByTestId('workflow-strict').click();
  await expect(page.getByTestId('workflow-strict')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('workflow-chain')).toContainText('Triage');
  // Suggestions: In Review → In Progress, Done → Todo, Canceled → Todo.
  const exceptions = page.getByTestId('workflow-exception');
  await expect(exceptions).toHaveCount(3);
  await expect(exceptions.first()).toHaveAttribute('data-from', 'In Review');
  const { states } = await mosaik();
  const id = (name: string) => states.find((s) => s.name === name && s.archivedAt === undefined)!._id;
  await page.getByTestId('workflow-exception-from').selectOption(id('Todo'));
  await page.getByTestId('workflow-exception-to').selectOption(id('Backlog'));
  await page.getByTestId('workflow-exception-add').click();
  await expect(exceptions).toHaveCount(4);
  await settled(page);

  // An issue in "Todo": S offers In Progress, Canceled, Duplicate and the Backlog exception.
  const created = await backend().mutation(api.issues.create, { issues: [{ teamId: (await mosaik()).team._id, title: 'Check the order', stateId: id('Todo') }] });
  await open(page, '/team/MOSAIK/all?group=none&order=created');
  const target = row(page, created.issues[0].id);
  await target.click({ position: { x: 600, y: 20 }, modifiers: [] });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-row').filter({ hasText: 'Check the order' })).toBeVisible();
  await page.getByTestId('issue-row').filter({ hasText: 'Check the order' }).getByTestId('row-status').click();
  const labels = await page.getByTestId('palette-item').allInnerTexts();
  expect(labels.map((l) => l.split('\n')[0].trim())).toEqual(['Backlog', 'Todo', 'In Progress', 'Canceled', 'Duplicate']);
  await expect(page.getByTestId('palette')).toContainText('Fixed order: Triage, In Review, Done not allowed right now');
  await page.keyboard.press('Escape');

  // Agent via MCP: a clear rejection listing the allowed targets.
  const key = created.issues[0].identifier;
  const denied = await agentCall('set_status', { identifiers: [key], status: 'Done' }).then(
    () => '',
    (error: Error) => error.message,
  );
  expect(denied).toContain('invalid_transition');
  expect(denied).toContain('Allowed: \\"Backlog\\", \\"In Progress\\", \\"Canceled\\", \\"Duplicate\\"');

  // Clean up for other tests.
  await backend().mutation(api.workflowStates.setWorkflow, { teamId: (await mosaik()).team._id, strict: false, exceptions: [] });
});
