import { describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { OWNER_KIND } from '../convex/shared/constants';
import { DEFAULT_STATES } from '../convex/shared/workflow';
import { createOne, expectCode, fixture, getIssue, historyOf, setup, stateId, type T } from './helpers';

// Workflow states per team: default states, resolving, moving teams, migration.

async function statesOf(t: T, teamId: Id<'teams'>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query('workflowStates').withIndex('by_team', (q) => q.eq('teamId', teamId)).collect()).sort(
      (a, b) => a._creationTime - b._creationTime,
    ),
  );
}

/** Custom state without a legacy key, inserted directly. */
async function customState(t: T, teamId: Id<'teams'>, name: string, type: 'started' | 'unstarted' | 'completed', position = 9) {
  return await t.run(async (ctx) =>
    ctx.db.insert('workflowStates', { teamId, name, type, position, createdAt: 0, updatedAt: 0 }),
  );
}

describe('Workflow states per team', () => {
  test('a new team gets the eight default states; meta.get returns them', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const states = await statesOf(t, f.orb);
    expect(states.map((s) => [s.name, s.type, s.legacyKey])).toEqual(DEFAULT_STATES.map((d) => [d.name, d.type, d.legacyKey]));
    expect(states.find((s) => s.legacyKey === 'duplicate')?.isDuplicate).toBe(true);
    const meta = await owner.query(api.meta.get, {});
    expect(meta.workflowStates.filter((s) => s.teamId === f.nova)).toHaveLength(8);
  });

  test('with SELFBOUND_LOCALE=de a new team gets German default state names', async () => {
    process.env.SELFBOUND_LOCALE = 'de';
    try {
      const { t, owner } = setup();
      const { teamId } = await owner.mutation(api.teams.create, { key: 'DE', name: 'German' });
      const names = (await statesOf(t, teamId)).map((s) => s.name);
      expect(names).toContain('In Arbeit');
      expect(names).toContain('Erledigt');
      expect(names).not.toContain('Done');
    } finally {
      delete process.env.SELFBOUND_LOCALE;
    }
  });

  test('create: Backlog by default, by stateId or status type; foreign or archived state → invalid', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    expect(await getIssue(t, a.id)).toMatchObject({ status: 'backlog', stateId: await stateId(t, f.orb, 'backlog') });
    const review = await stateId(t, f.orb, 'in_review');
    const b = await createOne(owner, f.orb, { stateId: review });
    expect(await getIssue(t, b.id)).toMatchObject({ status: 'in_review', stateId: review });
    expect((await getIssue(t, b.id)).startedAt).toBeDefined();
    const c = await createOne(owner, f.orb, { status: 'done' });
    expect(await getIssue(t, c.id)).toMatchObject({ status: 'done', stateId: await stateId(t, f.orb, 'done') });
    await expectCode(createOne(owner, f.orb, { stateId: await stateId(t, f.nova, 'todo') }), 'invalid');
    await t.run(async (ctx) => ctx.db.patch('workflowStates', review, { archivedAt: 1 }));
    await expectCode(createOne(owner, f.orb, { stateId: review }), 'invalid');
    // Status type "in_review" with its state archived: the first started state (In Progress).
    const d = await createOne(owner, f.orb, { status: 'in_review' });
    expect(await getIssue(t, d.id)).toMatchObject({ status: 'in_progress', stateId: await stateId(t, f.orb, 'in_progress') });
  });

  test('update by stateId: status type and timestamps follow; a status-type patch keeps a custom state of the same type', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb);
    const testing = await customState(t, f.orb, 'Testing', 'started');
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: testing } });
    let issue = await getIssue(t, id);
    expect(issue).toMatchObject({ stateId: testing, status: 'in_progress' });
    expect(issue.startedAt).toBeDefined();
    // An old client or an automation sends only the status type: the issue stays in "Testing".
    const same = await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'in_progress' } });
    expect(same.changed).toBe(0);
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'in_review' } });
    issue = await getIssue(t, id);
    expect(issue).toMatchObject({ stateId: await stateId(t, f.orb, 'in_review'), status: 'in_review' });
    const rows = (await historyOf(t, id)).filter((h) => h.field === 'stateId');
    expect(rows.map((r) => [r.from, r.to])).toEqual([
      [await stateId(t, f.orb, 'backlog'), testing],
      [testing, await stateId(t, f.orb, 'in_review')],
    ]);
    // Compare-and-set on the state.
    await expectCode(
      owner.mutation(api.issues.update, { ids: [id], patch: { status: 'done' }, expect: [{ stateId: testing }] }),
      'conflict',
    );
  });

  test('move team: same default state, else same name, else same status type', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const review = await createOne(owner, f.orb, { status: 'in_review' });
    const testing = await customState(t, f.orb, 'Testing', 'started');
    const named = await createOne(owner, f.orb, { stateId: testing });
    const novaTesting = await customState(t, f.nova, 'testing', 'started');
    const qa = await customState(t, f.orb, 'QA', 'started');
    const unnamed = await createOne(owner, f.orb, { stateId: qa });
    await owner.mutation(api.issues.moveTeam, { ids: [review.id, named.id, unnamed.id], teamId: f.nova });
    expect((await getIssue(t, review.id)).stateId).toBe(await stateId(t, f.nova, 'in_review'));
    expect((await getIssue(t, named.id)).stateId).toBe(novaTesting);
    expect(await getIssue(t, unnamed.id)).toMatchObject({ stateId: await stateId(t, f.nova, 'in_progress'), status: 'in_progress' });
    const novaProgress = await stateId(t, f.nova, 'in_progress');
    expect((await historyOf(t, unnamed.id)).filter((h) => h.field === 'stateId').map((h) => [h.from, h.to])).toEqual([[qa, novaProgress]]);
  });
});

describe('Migration (migrations.workflowBackfill)', () => {
  test('teams without states and issues without stateId: lossless, paginated, idempotent', async () => {
    vi.useFakeTimers();
    try {
      const { t } = setup();
      // Data from before per-team states: teams without states, issues with only the status type.
      const { teams, issues } = await t.run(async (ctx) => {
        const teams = [
          await ctx.db.insert('teams', { key: 'LEG', name: 'Legacy', hue: 1, dormant: false, order: 0, updatedAt: 0 }),
          await ctx.db.insert('teams', { key: 'OLD', name: 'Old', hue: 2, dormant: false, order: 1, updatedAt: 0 }),
        ];
        const statuses = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'duplicate'] as const;
        const issues: Id<'issues'>[] = [];
        for (let i = 0; i < 20; i++) {
          const id = await ctx.db.insert('issues', {
            seq: i,
            bucket: 0,
            teamId: teams[i % 2],
            number: i + 1,
            title: `Legacy ${i}`,
            status: statuses[i % 8],
            priority: 0,
            labelIds: [],
            rank: `a${String(i).padStart(2, '0')}`,
            createdBy: { kind: OWNER_KIND },
            createdAt: 100,
            updatedAt: 200 + i,
          });
          await ctx.db.insert('history', { issueId: id, field: 'status', from: 'backlog', to: statuses[i % 8], actor: { kind: OWNER_KIND }, at: 150 });
          issues.push(id);
        }
        return { teams, issues };
      });
      const before = await t.run(async (ctx) => Promise.all(issues.map((id) => ctx.db.get('issues', id))));

      const first = await t.mutation(internal.migrations.workflowBackfill, { numItems: 7 });
      expect(first).toMatchObject({ teams: 2, updated: 7, done: false });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const report = await t.action(internal.migrations.workflowVerify, {});
      expect(report).toMatchObject({ ok: true, issues: 20, problemCount: 0, teamsWithoutStates: [] });
      expect(report.counts).toEqual({
        LEG: { Triage: 3, Todo: 3, 'In Review': 2, Canceled: 2 },
        OLD: { Backlog: 3, 'In Progress': 3, Done: 2, Duplicate: 2 },
      });
      for (const [i, id] of issues.entries()) {
        const after = await getIssue(t, id);
        const old = before[i]!;
        expect(after.status).toBe(old.status);
        expect(after.updatedAt).toBe(old.updatedAt);
        expect(after.stateId).toBe(await stateId(t, old.teamId, old.status));
        expect(await historyOf(t, id)).toHaveLength(1);
      }
      const again = await t.mutation(internal.migrations.workflowBackfill, {});
      expect(again).toMatchObject({ teams: 0, updated: 0, done: true });
      expect(await statesOf(t, teams[0])).toHaveLength(8);
    } finally {
      vi.useRealTimers();
    }
  });

  test('verify reports issues without a state and a status type that does not match the state', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.orb);
    await t.run(async (ctx) => {
      await ctx.db.patch('issues', a.id, { stateId: undefined });
      await ctx.db.patch('issues', b.id, { status: 'done' });
    });
    const report = await t.action(internal.migrations.workflowVerify, {});
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['ORB-1: no state', 'ORB-2: status type done ≠ backlog']);
  });
});

describe('Configuring states (workflowStates.*)', () => {
  test('create, rename, color, unique name, fixed type', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { stateId } = await owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'Ready for Planning', type: 'backlog' });
    const created = (await statesOf(t, f.orb)).find((s) => s._id === stateId)!;
    expect(created).toMatchObject({ type: 'backlog', position: 1 });
    await expectCode(owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'todo', type: 'unstarted' }), 'invalid');
    await expectCode(owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'Inbox 2', type: 'triage' }), 'invalid');
    await owner.mutation(api.workflowStates.update, { stateId, name: 'Ready', color: '#26B5CE' });
    expect((await statesOf(t, f.orb)).find((s) => s._id === stateId)).toMatchObject({ name: 'Ready', color: '#26b5ce' });
    await expectCode(owner.mutation(api.workflowStates.update, { stateId, color: 'blue' }), 'invalid');
    await expectCode(owner.mutation(api.workflowStates.update, { stateId, name: 'Backlog' }), 'invalid');
    await owner.mutation(api.workflowStates.update, { stateId, color: null });
    expect((await statesOf(t, f.orb)).find((s) => s._id === stateId)?.color).toBeUndefined();
    // The same name is free in another team.
    await owner.mutation(api.workflowStates.create, { teamId: f.nova, name: 'Ready', type: 'backlog' });
  });

  test('reorder only within one type', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const testing = (await owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'Testing', type: 'started' })).stateId;
    const progress = await stateId(t, f.orb, 'in_progress');
    const review = await stateId(t, f.orb, 'in_review');
    await owner.mutation(api.workflowStates.reorder, { teamId: f.orb, stateIds: [testing, progress] });
    const started = (await statesOf(t, f.orb)).filter((s) => s.type === 'started').sort((a, b) => a.position - b.position);
    expect(started.map((s) => s._id)).toEqual([testing, progress, review]);
    await expectCode(owner.mutation(api.workflowStates.reorder, { teamId: f.orb, stateIds: [testing, await stateId(t, f.orb, 'todo')] }), 'invalid');
  });

  test('archive: with issues only with a target, paginated, exceptions are dropped; blocked for the last required state', async () => {
    vi.useFakeTimers();
    try {
      const { t, owner } = setup();
      const f = await fixture(owner);
      const review = await stateId(t, f.orb, 'in_review');
      const progress = await stateId(t, f.orb, 'in_progress');
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await createOne(owner, f.orb, { stateId: review })).id);
      await owner.mutation(api.issues.remove, { ids: [ids[4]] });
      await owner.mutation(api.workflowStates.setWorkflow, { teamId: f.orb, strict: true, exceptions: [{ from: review, to: progress }] });
      await expectCode(owner.mutation(api.workflowStates.archive, { stateId: review }), 'invalid');
      await expectCode(owner.mutation(api.workflowStates.archive, { stateId: review, moveTo: await stateId(t, f.nova, 'todo') }), 'invalid');
      const result = await owner.mutation(api.workflowStates.archive, { stateId: review, moveTo: progress });
      expect(result).toMatchObject({ moved: 5, more: false });
      for (const id of ids) expect(await getIssue(t, id)).toMatchObject({ stateId: progress, status: 'in_progress' });
      expect((await historyOf(t, ids[0])).filter((h) => h.field === 'stateId').at(-1)).toMatchObject({ from: review, to: progress });
      expect((await statesOf(t, f.orb)).find((s) => s._id === review)?.archivedAt).toBeDefined();
      const team = await t.run(async (ctx) => ctx.db.get('teams', f.orb));
      expect(team?.workflow?.exceptions).toEqual([]);
      // Restore.
      await owner.mutation(api.workflowStates.restore, { stateId: review });
      expect((await statesOf(t, f.orb)).find((s) => s._id === review)?.archivedAt).toBeUndefined();
      // The last state of type "completed" is required.
      await expectCode(owner.mutation(api.workflowStates.archive, { stateId: await stateId(t, f.orb, 'done') }), 'invalid');
      // The default state can only be archived after switching the default.
      const todo = await stateId(t, f.orb, 'todo');
      await owner.mutation(api.workflowStates.setWorkflow, { teamId: f.orb, defaultStateId: todo });
      expect((await createOne(owner, f.orb)).id).toBeDefined();
      await expectCode(owner.mutation(api.workflowStates.archive, { stateId: todo }), 'invalid');
      await expectCode(owner.mutation(api.workflowStates.setWorkflow, { teamId: f.orb, defaultStateId: await stateId(t, f.orb, 'done') }), 'invalid');
    } finally {
      vi.useRealTimers();
    }
  });

  test('default state applies to new issues; archiving more than 200 issues continues in the background', async () => {
    vi.useFakeTimers();
    try {
      const { t, owner } = setup();
      const f = await fixture(owner);
      const todo = await stateId(t, f.orb, 'todo');
      await owner.mutation(api.workflowStates.setWorkflow, { teamId: f.orb, defaultStateId: todo });
      const { id } = await createOne(owner, f.orb);
      expect((await getIssue(t, id)).stateId).toBe(todo);
      const backlog = await stateId(t, f.orb, 'backlog');
      for (let n = 0; n < 5; n++) {
        await owner.mutation(api.issues.create, { issues: Array.from({ length: 50 }, (_, i) => ({ teamId: f.orb, title: `B${n}-${i}`, stateId: backlog })) });
      }
      const first = await owner.mutation(api.workflowStates.archive, { stateId: backlog, moveTo: todo });
      expect(first).toMatchObject({ moved: 200, more: true });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const left = await t.run(async (ctx) => ctx.db.query('issues').withIndex('by_state', (q) => q.eq('stateId', backlog)).collect());
      expect(left).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Strict workflow order', () => {
  async function strictTeam() {
    const env = setup();
    const f = await fixture(env.owner);
    const ids = {
      triage: await stateId(env.t, f.orb, 'triage'),
      backlog: await stateId(env.t, f.orb, 'backlog'),
      todo: await stateId(env.t, f.orb, 'todo'),
      progress: await stateId(env.t, f.orb, 'in_progress'),
      review: await stateId(env.t, f.orb, 'in_review'),
      done: await stateId(env.t, f.orb, 'done'),
      canceled: await stateId(env.t, f.orb, 'canceled'),
      duplicate: await stateId(env.t, f.orb, 'duplicate'),
    };
    await env.owner.mutation(api.workflowStates.setWorkflow, { teamId: f.orb, strict: true, exceptions: [{ from: ids.review, to: ids.progress }] });
    return { ...env, f, ids };
  }

  test('only the next state, cancel and duplicate always, exception back; the error names the allowed targets', async () => {
    const { t, owner, f, ids } = await strictTeam();
    const { id } = await createOne(owner, f.orb, { stateId: ids.todo });
    const data = await expectCode(owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.done } }), 'invalid_transition');
    expect(data).toMatchObject({ identifier: 'ORB-1', from: 'Todo', to: 'Done', allowed: ['In Progress', 'Canceled', 'Duplicate'] });
    expect(data.message).toBe(
      'ORB-1: status "Todo" → "Done" is not allowed (team ORB requires the workflow order). Allowed: "In Progress", "Canceled", "Duplicate".',
    );
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.progress } });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.review } });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.progress } }); // exception
    await expectCode(owner.mutation(api.issues.update, { ids: [id], patch: { status: 'todo' } }), 'invalid_transition');
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.canceled } });
    expect((await getIssue(t, id)).status).toBe('canceled');
    // Reopening only through an exception.
    await expectCode(owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.todo } }), 'invalid_transition');
  });

  test('Triage is the entry; new issues only in Triage, Backlog or unstarted', async () => {
    const { owner, f, ids } = await strictTeam();
    const { id } = await createOne(owner, f.orb, { stateId: ids.triage });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.todo } });
    await expectCode(createOne(owner, f.orb, { stateId: ids.progress }), 'invalid_transition');
    await createOne(owner, f.orb, { stateId: ids.todo });
    await createOne(owner, f.orb);
  });

  test('automation and undo are exempt: GitHub merge, sprint close, undo, team move, archive', async () => {
    const { t, owner, f, ids } = await strictTeam();
    const { id } = await createOne(owner, f.orb, { stateId: ids.todo });
    await owner.mutation(api.issues.update, { ids: [id], patch: { stateId: ids.progress } });
    // Undo (compare-and-set still applies).
    await owner.mutation(api.issues.revert, { items: [{ id, patch: { stateId: ids.todo }, expect: { stateId: ids.progress } }] });
    expect((await getIssue(t, id)).stateId).toBe(ids.todo);
    await expectCode(
      owner.mutation(api.issues.revert, { items: [{ id, patch: { stateId: ids.done }, expect: { stateId: ids.progress } }] }),
      'conflict',
    );
    // System actor (like a GitHub merge): todo → done directly.
    await t.run(async (ctx) => {
      const { applyPatch } = await import('../convex/ops/issues');
      await applyPatch(ctx, { kind: 'github' }, id, { status: 'done' }, undefined, Date.now());
    });
    expect((await getIssue(t, id)).stateId).toBe(ids.done);
    // Moving into a team with strict order: the state is mapped, not checked.
    const other = await createOne(owner, f.nova, { status: 'in_review' });
    await owner.mutation(api.issues.moveTeam, { ids: [other.id], teamId: f.orb });
    expect((await getIssue(t, other.id)).stateId).toBe(ids.review);
    // Archiving with a move into an otherwise forbidden state.
    const { stateId: qa } = await owner.mutation(api.workflowStates.create, { teamId: f.orb, name: 'QA', type: 'started' });
    await owner.mutation(api.issues.update, { ids: [other.id], patch: { stateId: qa } });
    await owner.mutation(api.workflowStates.archive, { stateId: qa, moveTo: ids.todo });
    expect((await getIssue(t, other.id)).stateId).toBe(ids.todo);
  });
});
