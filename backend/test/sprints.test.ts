import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Actor } from '../convex/lib/actor';
import { addDays, berlinDay, nextMonday, weekdayOf } from '../convex/lib/dates';
import { createIssues } from '../convex/ops/issues';
import { addToSprint, suggestedStart } from '../convex/ops/sprints';
import { createOne, expectCode, expectSprintInvariant, fixture, getIssue, historyOf, setup, type Client, type T } from './helpers';

async function items(owner: Client, sprintId: Id<'sprints'>) {
  return await owner.query(api.sprints.items, { sprintId });
}

async function agentActor(t: T): Promise<Actor> {
  const agentId = await t.run(
    async (ctx) => await ctx.db.insert('agents', { name: 'Codex', keyHash: 'b'.repeat(64), keyPrefix: 'xlr8_bbbbb', createdAt: 0 }),
  );
  return { kind: 'agent', agentId };
}

describe('Sprints', () => {
  test('create: state planning, 14 days from next Monday, sequential number', async () => {
    const { owner } = setup();
    const { id, number } = await owner.mutation(api.sprints.create, { goal: ' Focus ' });
    const second = await owner.mutation(api.sprints.create, { name: 'Autumn', startDate: '2026-11-02', endDate: '2026-11-08' });
    expect([number, second.number]).toEqual([1, 2]);
    const sprints = await owner.query(api.sprints.list, {});
    const sprint = sprints.find((s) => s._id === id)!;
    expect(sprint).toMatchObject({ name: 'Sprint 1', goal: 'Focus', state: 'planning', source: 'xlr8' });
    expect(sprint.startDate).toBe(nextMonday(berlinDay(Date.now())));
    expect(weekdayOf(sprint.startDate)).toBe(1);
    expect(weekdayOf(sprint.endDate)).toBe(7);
    await expectCode(owner.mutation(api.sprints.create, { startDate: '2026-11-10', endDate: '2026-11-01' }), 'invalid');
    await owner.mutation(api.sprints.update, { sprintId: id, goal: 'New goal', capacity: 12 });
    await owner.mutation(api.sprints.update, { sprintId: id, capacity: null });
    expect((await owner.query(api.sprints.list, {})).find((s) => s._id === id)).toMatchObject({ goal: 'New goal' });
    expect((await owner.query(api.sprints.list, {})).find((s) => s._id === id)?.capacity).toBeUndefined();
  });

  test('suggested date range does not overlap any active or planned sprint', async () => {
    const { owner } = setup();
    const today = berlinDay(Date.now());
    const first = await owner.mutation(api.sprints.create, { startDate: today, endDate: addDays(today, 13) });
    await owner.mutation(api.sprints.start, { sprintId: first.id });
    await owner.mutation(api.sprints.create, { startDate: addDays(today, 14), endDate: addDays(today, 27) });
    const third = await owner.mutation(api.sprints.create, {});
    const sprint = (await owner.query(api.sprints.list, {})).find((s) => s._id === third.id)!;
    expect(sprint.startDate).toBe(addDays(today, 28));
    expect(sprint.endDate).toBe(addDays(today, 41));
    // The rule as a function: without open sprints, or when their end has passed, the next Monday.
    expect(suggestedStart([], '2026-10-14')).toBe('2026-10-19');
    expect(suggestedStart([{ endDate: '2026-10-01' }], '2026-10-14')).toBe('2026-10-19');
    expect(suggestedStart([{ endDate: '2026-11-01' }, { endDate: '2026-10-18' }], '2026-10-14')).toBe('2026-11-02');
  });

  test('start early: begins today, length kept; close early: ends today', async () => {
    const { owner } = setup();
    const today = berlinDay(Date.now());
    const { id } = await owner.mutation(api.sprints.create, { startDate: addDays(today, 5), endDate: addDays(today, 18) });
    const started = await owner.mutation(api.sprints.start, { sprintId: id });
    expect(started.moved).toEqual({ startDate: today, endDate: addDays(today, 13) });
    let sprint = (await owner.query(api.sprints.list, {})).find((s) => s._id === id)!;
    expect([sprint.startDate, sprint.endDate]).toEqual([today, addDays(today, 13)]);
    const closed = await owner.mutation(api.sprints.close, { sprintId: id, decisions: [] });
    expect(closed.endedEarly).toBe(today);
    sprint = (await owner.query(api.sprints.list, {})).find((s) => s._id === id)!;
    expect(sprint.endDate).toBe(today);
    // Started on time: nothing moved.
    const b = await owner.mutation(api.sprints.create, { startDate: addDays(today, -3), endDate: addDays(today, 10) });
    expect((await owner.mutation(api.sprints.start, { sprintId: b.id })).moved).toBeNull();
  });

  test('no sprint runs without being started; at most one active sprint', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await owner.mutation(api.sprints.create, {});
    const b = await owner.mutation(api.sprints.create, {});
    const issue = await createOne(owner, f.orb);
    await owner.mutation(api.sprints.add, { sprintId: a.id, issueIds: [issue.id] });
    let meta = await owner.query(api.meta.get, {});
    expect(meta.sprints.filter((s) => s.state === 'active')).toHaveLength(0);
    // Closing only works after starting.
    await expectCode(owner.mutation(api.sprints.close, { sprintId: a.id, decisions: [] }), 'invalid');
    await owner.mutation(api.sprints.start, { sprintId: a.id });
    meta = await owner.query(api.meta.get, {});
    expect(meta.sprints.filter((s) => s.state === 'active').map((s) => s._id)).toEqual([a.id]);
    await expectCode(owner.mutation(api.sprints.start, { sprintId: b.id }), 'conflict');
    await expectCode(owner.mutation(api.sprints.start, { sprintId: a.id }), 'invalid');
    await expectSprintInvariant(t);
  });

  test('issues added after the start are "late", also from an agent; before it "planned"', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    const planned = await createOne(owner, f.orb);
    expect(await owner.mutation(api.sprints.add, { sprintId, issueIds: [planned.id] })).toEqual({ added: 1, kind: 'planned' });
    await expectSprintInvariant(t);
    await owner.mutation(api.sprints.start, { sprintId });
    const late = await createOne(owner, f.nova);
    expect(await owner.mutation(api.sprints.add, { sprintId, issueIds: [late.id, planned.id] })).toEqual({ added: 1, kind: 'late' });
    const agent = await agentActor(t);
    const byAgent = await t.run(async (ctx) => {
      const created = await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'Agent', sprintId }] });
      const other = await createIssues(ctx, agent, { issues: [{ teamId: f.nova, title: 'Agent 2' }] });
      await addToSprint(ctx, agent, { sprintId, issueIds: [other.issues[0].id] });
      return [created.issues[0].id, other.issues[0].id];
    });
    const entries = await items(owner, sprintId);
    const kindOf = (id: Id<'issues'>) => entries.find((e) => e.issueId === id && e.removedAt === null)?.kind;
    expect(kindOf(planned.id)).toBe('planned');
    expect(kindOf(late.id)).toBe('late');
    expect(kindOf(byAgent[0])).toBe('late');
    expect(kindOf(byAgent[1])).toBe('late');
    expect(entries.find((e) => e.issueId === byAgent[1])?.addedBy).toEqual(agent);
    // Created with a sprint: exactly one history row 'created'.
    expect((await historyOf(t, byAgent[0])).map((r) => r.field)).toEqual(['created']);
    expect((await historyOf(t, byAgent[1])).map((r) => [r.field, r.actor.kind])).toEqual([
      ['created', 'agent'],
      ['sprint', 'agent'],
    ]);
    await expectSprintInvariant(t);
  });

  test('an issue belongs to at most one open sprint; moving it removes the old entry', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await owner.mutation(api.sprints.create, {});
    const b = await owner.mutation(api.sprints.create, {});
    const issue = await createOne(owner, f.orb);
    await owner.mutation(api.sprints.add, { sprintId: a.id, issueIds: [issue.id] });
    await owner.mutation(api.sprints.add, { sprintId: b.id, issueIds: [issue.id] });
    expect((await getIssue(t, issue.id)).sprintId).toBe(b.id);
    expect((await items(owner, a.id))[0].removedAt).not.toBeNull();
    expect((await items(owner, b.id))[0].removedAt).toBeNull();
    await expectSprintInvariant(t);
    // Through issues.update (delegates to the sprint operations).
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { sprintId: a.id } });
    expect((await getIssue(t, issue.id)).sprintId).toBe(a.id);
    await expectSprintInvariant(t);
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { sprintId: null } });
    expect((await getIssue(t, issue.id)).sprintId).toBeUndefined();
    await expectSprintInvariant(t);
    await owner.mutation(api.sprints.add, { sprintId: a.id, issueIds: [issue.id] });
    expect(await owner.mutation(api.sprints.remove, { sprintId: a.id, issueIds: [issue.id] })).toEqual({ removed: 1 });
    expect((await getIssue(t, issue.id)).sprintId).toBeUndefined();
    await expectSprintInvariant(t);
    const sprintRows = (await historyOf(t, issue.id)).filter((r) => r.field === 'sprint');
    expect(sprintRows).toHaveLength(6);
  });

  test('close is rejected without decisions, correct with decisions, nothing moved automatically', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    const res = await owner.mutation(api.issues.create, {
      issues: ['done', 'next', 'backlog', 'cancel', 'wasCanceled'].map((title) => ({ teamId: f.orb, title, estimate: 2 })),
    });
    const [done, next, backlog, cancel, wasCanceled] = res.issues.map((i) => i.id);
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [done, next, backlog, cancel, wasCanceled] });
    await owner.mutation(api.sprints.start, { sprintId });
    await owner.mutation(api.issues.update, { ids: [done], patch: { status: 'done' } });
    await owner.mutation(api.issues.update, { ids: [wasCanceled], patch: { status: 'canceled' } });

    const missing = await expectCode(
      owner.mutation(api.sprints.close, { sprintId, decisions: [{ issueId: next, outcome: 'next' }] }),
      'invalid',
    );
    expect(missing.missing).toEqual([backlog, cancel]);
    expect(String(missing.message)).toContain('ORB-3');
    const outsider = await createOne(owner, f.nova);
    await expectCode(
      owner.mutation(api.sprints.close, {
        sprintId,
        decisions: [
          { issueId: next, outcome: 'next' },
          { issueId: backlog, outcome: 'backlog' },
          { issueId: cancel, outcome: 'canceled' },
          { issueId: outsider.id, outcome: 'backlog' },
        ],
      }),
      'invalid',
    );
    // Nothing changed, the sprint is still running.
    expect((await owner.query(api.sprints.list, {}))[0].state).toBe('active');
    await expectSprintInvariant(t);

    const result = await owner.mutation(api.sprints.close, {
      sprintId,
      decisions: [
        { issueId: next, outcome: 'next' },
        { issueId: backlog, outcome: 'backlog' },
        { issueId: cancel, outcome: 'canceled' },
      ],
    });
    expect(result.counts).toEqual({ done: 1, next: 1, backlog: 1, canceled: 2 });
    expect(result.nextSprintId).not.toBeNull();
    const sprints = await owner.query(api.sprints.list, {});
    expect(sprints.find((s) => s._id === sprintId)?.state).toBe('closed');
    const nextSprint = sprints.find((s) => s._id === result.nextSprintId)!;
    expect(nextSprint).toMatchObject({ state: 'planning', number: 2 });

    const closedItems = await items(owner, sprintId);
    const outcome = (id: Id<'issues'>) => closedItems.find((e) => e.issueId === id)?.outcome;
    expect([outcome(done), outcome(next), outcome(backlog), outcome(cancel), outcome(wasCanceled)]).toEqual([
      'done',
      'next',
      'backlog',
      'canceled',
      'canceled',
    ]);
    expect((await getIssue(t, done)).sprintId).toBe(sprintId);
    expect((await getIssue(t, next)).sprintId).toBe(nextSprint._id);
    expect((await getIssue(t, backlog)).sprintId).toBeUndefined();
    expect((await getIssue(t, backlog)).status).toBe('backlog');
    expect((await getIssue(t, cancel)).status).toBe('canceled');
    expect((await getIssue(t, cancel)).sprintId).toBeUndefined();
    const carried = (await items(owner, nextSprint._id))[0];
    expect(carried).toMatchObject({ issueId: next, kind: 'planned', carriedFrom: sprintId, removedAt: null });
    // Closed: nothing can be added anymore.
    await expectCode(owner.mutation(api.sprints.add, { sprintId, issueIds: [backlog] }), 'invalid');
    await expectCode(owner.mutation(api.sprints.remove, { sprintId, issueIds: [done] }), 'invalid');
    await expectSprintInvariant(t);
  });

  test('close with a given next sprint and retry via requestId', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    const { id: nextId } = await owner.mutation(api.sprints.create, {});
    const issue = await createOne(owner, f.orb);
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [issue.id] });
    await owner.mutation(api.sprints.start, { sprintId });
    await expectCode(
      owner.mutation(api.sprints.close, { sprintId, decisions: [{ issueId: issue.id, outcome: 'next' }], nextSprintId: sprintId }),
      'invalid',
    );
    const args = { sprintId, decisions: [{ issueId: issue.id, outcome: 'next' as const }], nextSprintId: nextId, requestId: 'close-1' };
    const first = await owner.mutation(api.sprints.close, args);
    expect(await owner.mutation(api.sprints.close, args)).toEqual(first);
    expect(first.nextSprintId).toBe(nextId);
    expect((await owner.query(api.sprints.list, {})).length).toBe(2);
    expect((await getIssue(t, issue.id)).sprintId).toBe(nextId);
    await expectSprintInvariant(t);
  });

  test('trash takes issues out of open sprints', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    const issue = await createOne(owner, f.orb);
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [issue.id] });
    await owner.mutation(api.sprints.start, { sprintId });
    await owner.mutation(api.issues.remove, { ids: [issue.id] });
    await expectSprintInvariant(t);
    await expectCode(owner.mutation(api.sprints.add, { sprintId, issueIds: [issue.id] }), 'invalid');
    expect((await owner.mutation(api.sprints.close, { sprintId, decisions: [] })).counts).toEqual({
      done: 0,
      next: 0,
      backlog: 0,
      canceled: 0,
    });
  });

  test('capacitySuggestion: average done points of the last 3 closed Selfbound sprints', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    expect(await owner.query(api.sprints.capacitySuggestion, {})).toEqual({ capacity: null, basis: [] });
    const points = [[5, 3], [8], [2, 2, 1], [10]];
    for (const estimates of points) {
      const { id: sprintId } = await owner.mutation(api.sprints.create, {});
      const res = await owner.mutation(api.issues.create, {
        issues: [...estimates.map((estimate) => ({ teamId: f.orb, title: `P${estimate}`, estimate })), { teamId: f.orb, title: 'open', estimate: 13 }],
      });
      const ids = res.issues.map((i) => i.id);
      await owner.mutation(api.sprints.add, { sprintId, issueIds: ids });
      await owner.mutation(api.sprints.start, { sprintId });
      await owner.mutation(api.issues.update, { ids: ids.slice(0, -1), patch: { status: 'done' } });
      await owner.mutation(api.sprints.close, { sprintId, decisions: [{ issueId: ids.at(-1)!, outcome: 'backlog' }] });
    }
    // An imported (Linear) sprint does not count.
    await t.run(async (ctx) => {
      await ctx.db.insert('sprints', {
        number: 99,
        name: 'KIU Cycle 1',
        goal: '',
        startDate: '2026-01-01',
        endDate: '2026-01-14',
        state: 'closed',
        source: 'linear',
        closedAt: Date.now() + 1000,
        updatedAt: Date.now(),
      });
    });
    const suggestion = await owner.query(api.sprints.capacitySuggestion, {});
    expect(suggestion.basis.map((b) => b.donePoints)).toEqual([10, 5, 8]);
    expect(suggestion.capacity).toBeCloseTo(7.7, 5);
    await expectSprintInvariant(t);
  });

  test('auditSprints finds inconsistencies and the cron writes the result to opsStatus', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    const issue = await createOne(owner, f.orb);
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [issue.id] });
    // Write around the sprint logic on purpose.
    await t.run(async (ctx) => {
      await ctx.db.patch('issues', issue.id, { sprintId: undefined });
    });
    const { internal } = await import('../convex/_generated/api');
    const result = (await t.action(internal.maintenance.auditSprints, {})) as { ok: boolean; problems: string[] };
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('issue.sprintId =');
    const status = await owner.query(api.ops.status, {});
    expect(status.sprintAudit?.value).toMatchObject({ ok: false });
  });
});
