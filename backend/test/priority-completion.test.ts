import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { signBody } from '../convex/lib/github';
import { OWNER_KIND } from '../convex/shared/constants';
import { createOne, fixture, getIssue, historyOf, setup, stateId, type T } from './helpers';

// When an issue moves to done, canceled or duplicate, it loses its priority.
// The rule lives in applyPatch and therefore applies to the UI, bulk edits, undo, MCP, GitHub merges
// and sprint close.

async function agent(owner: ReturnType<typeof setup>['owner']) {
  return await owner.action(api.agents.create, { name: 'Claude Code' });
}

async function call(t: T, key: string, name: string, args: Record<string, unknown>) {
  const response = await t.fetch('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = ((await response.json()) as { result: { isError?: boolean; structuredContent: any; content: { text: string }[] } }).result;
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return result.structuredContent as any;
}

describe('Priority is cleared on completion', () => {
  test.each(['done', 'canceled', 'duplicate'] as const)('moving to %s sets priority to none, with its own history row', async (status) => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'in_progress', priority: 2 });
    await owner.mutation(api.issues.update, { ids: [id], patch: { status }, requestId: 'req-complete-1' });
    const issue = await getIssue(t, id);
    expect(issue.status).toBe(status);
    expect(issue.priority).toBe(0);
    const rows = await historyOf(t, id);
    const priority = rows.find((r) => r.field === 'priority')!;
    const state = rows.find((r) => r.field === 'stateId')!;
    expect(priority).toMatchObject({ from: 2, to: 0, actor: { kind: OWNER_KIND }, requestId: 'req-complete-1' });
    expect(priority.actor).toEqual(state.actor);
    expect(priority.at).toBe(state.at);
  });

  test('priority in the same patch is ignored; no extra row without a priority', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { priority: 1 });
    const b = await createOne(owner, f.orb);
    await owner.mutation(api.issues.update, { ids: [a.id, b.id], patch: { status: 'done', priority: 3 } });
    expect((await getIssue(t, a.id)).priority).toBe(0);
    expect((await getIssue(t, b.id)).priority).toBe(0);
    expect((await historyOf(t, a.id)).filter((r) => r.field === 'priority')).toHaveLength(1);
    expect((await historyOf(t, b.id)).filter((r) => r.field === 'priority')).toHaveLength(0);
  });

  test('a custom completed state counts, open states do not', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { stateId: shipped } = await owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'Shipped', type: 'completed' });
    const { stateId: review } = await owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'Acceptance', type: 'started' });
    const { id } = await createOne(owner, f.orb, { priority: 2 });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: review } });
    expect((await getIssue(t, id)).priority).toBe(2);
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: shipped } });
    expect((await getIssue(t, id)).priority).toBe(0);
  });

  test('reopening keeps priority at none; undo restores state and priority together', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'in_progress', priority: 2 });
    const open = await stateId(t, f.orb, 'in_progress');
    const done = await stateId(t, f.orb, 'done');
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'done' } });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: open } });
    expect((await getIssue(t, id)).priority).toBe(0);
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: done } });
    // This is how the UI sends undo: both fields, expecting the state after completion.
    await owner.mutation(api.issues.revert, {
      items: [{ id, patch: { stateId: open, priority: 2 }, expect: { stateId: done, priority: 0 } }],
    });
    const issue = await getIssue(t, id);
    expect(issue).toMatchObject({ status: 'in_progress', priority: 2 });
    expect(issue.completedAt).toBeUndefined();
  });

  test('creating with a final state carries no priority and does not count toward the budget', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const result = await owner.mutation(api.issues.create, {
      issues: [
        { teamId: f.orb, title: 'Finished', status: 'done', priority: 1 },
        { teamId: f.orb, title: 'Open', status: 'todo', priority: 1 },
      ],
    });
    expect((await getIssue(t, result.issues[0].id)).priority).toBe(0);
    expect((await getIssue(t, result.issues[1].id)).priority).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  test('archiving a state moves its issues and clears priority when the target is completed', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { stateId: temp } = await owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'Staging', type: 'started' });
    const { id } = await createOne(owner, f.orb, { priority: 2 });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: temp } });
    await owner.mutation(api.workflowStates.archive, { stateId: temp, moveTo: await stateId(t, f.orb, 'done') });
    expect(await getIssue(t, id)).toMatchObject({ status: 'done', priority: 0 });
  });

  test('"duplicate of" with markDuplicate clears the priority', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { priority: 2 });
    const b = await createOne(owner, f.orb, { priority: 2 });
    await owner.mutation(api.relations.add, { fromId: a.id, toId: b.id, type: 'duplicate', markDuplicate: true });
    expect(await getIssue(t, a.id)).toMatchObject({ status: 'duplicate', priority: 0 });
    expect((await getIssue(t, b.id)).priority).toBe(2);
  });

  test('sprint close with "cancel" clears the priority', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    const { id } = await createOne(owner, f.orb, { priority: 1 });
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [id] });
    await owner.mutation(api.sprints.start, { sprintId });
    await owner.mutation(api.sprints.close, { sprintId, decisions: [{ issueId: id, outcome: 'canceled' }] });
    expect(await getIssue(t, id)).toMatchObject({ status: 'canceled', priority: 0 });
    expect((await historyOf(t, id)).find((r) => r.field === 'priority')).toMatchObject({ from: 1, to: 0 });
  });

  test('GitHub merge: priority cleared, actor github', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret-synthetic';
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'in_progress', priority: 2 });
    const send = async (action: string, merged: boolean, delivery: string) => {
      const body = JSON.stringify({
        action,
        number: 7,
        repository: { full_name: 'acme/app' },
        pull_request: {
          number: 7,
          title: 'Search field',
          body: 'Fixes ORB-1',
          state: action === 'closed' ? 'closed' : 'open',
          draft: false,
          merged,
          merged_at: merged ? '2026-10-08T12:00:00Z' : null,
          updated_at: merged ? '2026-10-08T12:00:00Z' : '2026-10-08T11:00:00Z',
          html_url: 'https://github.com/acme/app/pull/7',
          head: { ref: 'feature/x' },
          user: { login: 'octocat' },
          _links: { self: { href: 'https://api.github.com/x' } },
        },
      });
      const response = await t.fetch('/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-GitHub-Delivery': delivery,
          'X-Hub-Signature-256': await signBody('test-secret-synthetic', body),
        },
        body,
      });
      expect(response.status).toBe(200);
    };
    await send('opened', false, 'd1');
    expect((await getIssue(t, id)).priority).toBe(2);
    await send('closed', true, 'd2');
    expect(await getIssue(t, id)).toMatchObject({ status: 'done', priority: 0 });
    const rows = await historyOf(t, id);
    expect(rows.find((r) => r.field === 'priority')).toMatchObject({ from: 2, to: 0, actor: { kind: 'github' } });
  });
});

describe('Priority is cleared on completion: MCP reports it', () => {
  test('set_status, update_issue and create_issues report the removed priority', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb, { priority: 2 }); // ORB-1
    await createOne(owner, f.orb, { priority: 1 }); // ORB-2
    await createOne(owner, f.orb); // ORB-3 without priority
    const { key } = await agent(owner);

    const status = await call(t, key, 'set_status', { identifiers: ['ORB-1', 'ORB-3'], status: 'done' });
    expect(status.issues.map((i: any) => i.priority)).toEqual(['none', 'none']);
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toMatchObject({ code: 'priority_cleared', identifier: 'ORB-1', priority: 'high' });
    expect(status.warnings[0].message).toMatch(/removed/);

    const update = await call(t, key, 'update_issue', { identifier: 'ORB-2', status: 'canceled' });
    expect(update.changed).toEqual(expect.arrayContaining(['status', 'priority']));
    expect(update.warnings).toEqual([expect.objectContaining({ code: 'priority_cleared', identifier: 'ORB-2', priority: 'urgent' })]);
    expect(update.issue.priority).toBe('none');

    const created = await call(t, key, 'create_issues', {
      requestId: 'req-create-prio-0001',
      issues: [
        { team: 'ORB', title: 'Already done', status: 'done', priority: 'high' },
        { team: 'ORB', title: 'Open', status: 'todo', priority: 'high' },
      ],
    });
    expect(created.created.map((i: any) => i.priority)).toEqual(['none', 'high']);
    expect(created.warnings).toEqual([expect.objectContaining({ code: 'priority_cleared', identifier: 'ORB-4', priority: 'high' })]);

    // History names the agent as the source of the priority rows.
    const rows = (await t.run(async (ctx) => await ctx.db.query('history').collect())).filter((r) => r.field === 'priority' && r.to === 0);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.actor.kind).toBe('agent');
  });
});

describe('Migration migrations.priorityClearClosed', () => {
  async function legacy(t: T, owner: ReturnType<typeof setup>['owner']) {
    const f = await fixture(owner);
    const open = await createOne(owner, f.orb, { priority: 1 });
    const done = await createOne(owner, f.orb);
    const canceled = await createOne(owner, f.orb);
    const duplicate = await createOne(owner, f.nova);
    const clean = await createOne(owner, f.orb, { status: 'done' });
    // Legacy data as after a Linear import: completed, but with a priority (written directly).
    await t.run(async (ctx) => {
      for (const [i, status, priority] of [
        [done.id, 'done', 2],
        [canceled.id, 'canceled', 3],
        [duplicate.id, 'duplicate', 4],
      ] as const) {
        const issue = (await ctx.db.get('issues', i))!;
        const state = (await ctx.db.query('workflowStates').withIndex('by_team', (q) => q.eq('teamId', issue.teamId)).collect()).find((s) => s.legacyKey === status)!;
        await ctx.db.patch('issues', i, { status, stateId: state._id, priority });
      }
    });
    return { open, done, canceled, duplicate, clean };
  }

  test('without apply only counts, with apply cleans up (history actor system), a second run changes nothing', async () => {
    const { t, owner } = setup();
    const ids = await legacy(t, owner);
    const dry = await t.mutation(internal.migrations.priorityClearClosed, {});
    expect(dry).toMatchObject({ applied: false, found: 3, changed: 0, done: true });
    expect(dry.byStatusAndPriority).toEqual({ 'done/2': 1, 'canceled/3': 1, 'duplicate/4': 1 });
    expect((await getIssue(t, ids.done.id)).priority).toBe(2);

    const before = await getIssue(t, ids.done.id);
    const run = await t.mutation(internal.migrations.priorityClearClosed, { apply: true, numItems: 3 });
    expect(run.done).toBe(false);
    await t.mutation(internal.migrations.priorityClearClosed, { apply: true, cursor: run.cursor });
    for (const key of ['done', 'canceled', 'duplicate'] as const) {
      const issue = await getIssue(t, ids[key].id);
      expect(issue.priority).toBe(0);
      const row = (await historyOf(t, issue._id)).find((r) => r.field === 'priority')!;
      expect(row).toMatchObject({ to: 0, actor: { kind: 'system' } });
    }
    expect((await getIssue(t, ids.done.id)).updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect((await getIssue(t, ids.open.id)).priority).toBe(1);
    expect(await historyOf(t, ids.clean.id)).toHaveLength(1);

    const again = await t.mutation(internal.migrations.priorityClearClosed, { apply: true });
    expect(again).toMatchObject({ found: 0, changed: 0 });
  });
});
