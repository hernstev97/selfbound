import { describe, expect, test } from 'vitest';
import { normalize, stagingRows } from '../../tooling/linear-import/normalize.ts';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { runDueRecurrences } from '../convex/ops/recurrences';
import type { PriorityLimits } from '../convex/shared/priorityLimits';
import type { ImportStagingRow } from '../convex/shared/importTypes';
import { berlinDay, createOne, expectCode, fixture, getIssue, historyOf, setup, type Client, type T } from './helpers';
import { rawData } from './lib/linear-import/fixtures.ts';

// Priority limits (XLR8-91): configurable per instance, counted per team; soft ones warn, hard ones
// reject every raise (create, update, undo, move, restore), recurrences and the import drop the
// priority instead of failing.

const HARD_URGENT: PriorityLimits = { urgent: { max: 1, hard: true }, high: { max: 3, hard: false } };

const setLimits = async (owner: Client, limits: PriorityLimits) => await owner.mutation(api.instance.setPriorityLimits, { limits });

describe('Priority limits', () => {
  test('setting: defaults in meta.get, validation, owner only', async () => {
    const { owner, stranger } = setup();
    expect((await owner.query(api.meta.get, {})).priorityLimits).toEqual({ urgent: { max: 1, hard: false }, high: { max: 3, hard: false } });
    await setLimits(owner, { urgent: { max: 2, hard: true }, high: { max: null, hard: false } });
    const meta = await owner.query(api.meta.get, {});
    expect(meta.priorityLimits).toEqual({ urgent: { max: 2, hard: true }, high: { max: null, hard: false } });
    // The row was created without a time zone: still "not set".
    expect(meta.timeZone).toBeNull();
    await expectCode(setLimits(owner, { urgent: { max: -1, hard: false }, high: { max: 3, hard: false } }), 'invalid');
    await expectCode(setLimits(owner, { urgent: { max: 1.5, hard: false }, high: { max: 3, hard: false } }), 'invalid');
    await expectCode(setLimits(owner, { urgent: { max: 100, hard: false }, high: { max: 3, hard: false } }), 'invalid');
    await expect(stranger.mutation(api.instance.setPriorityLimits, { limits: HARD_URGENT })).rejects.toThrow();
    // The time zone and the limits live in the same row and leave each other alone.
    await owner.mutation(api.instance.setTimeZone, { timeZone: 'UTC' });
    expect((await owner.query(api.meta.get, {})).priorityLimits.urgent).toEqual({ max: 2, hard: true });
  });

  test('hard: create and update are rejected with a clear message, nothing written; other teams independent', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await setLimits(owner, HARD_URGENT);
    const first = await createOne(owner, f.orb, { priority: 1 });
    const data = await expectCode(owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'Second fire', priority: 1 }] }), 'priority_limit');
    expect(data).toMatchObject({ team: 'ORB', priority: 1, limit: 1, open: 1, issues: ['ORB-1'] });
    expect(String(data.message)).toContain('Team ORB already has 1 open urgent issue: ORB-1, and the hard limit is 1');
    expect(String(data.message)).toContain('Lower the priority of one of them first');
    expect(await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)).toBe(1);
    // Batch: one over the limit rejects all of them.
    const other = await createOne(owner, f.orb, { priority: 3 });
    const third = await createOne(owner, f.orb, { priority: 4 });
    await expectCode(owner.mutation(api.issues.update, { ids: [other.id, third.id], patch: { priority: 1 } }), 'priority_limit');
    expect((await getIssue(t, other.id)).priority).toBe(3);
    // Another team has its own count.
    await createOne(owner, f.nova, { priority: 1 });
    // Editing the urgent issue itself is fine; lowering frees the place.
    await owner.mutation(api.issues.update, { ids: [first.id], patch: { title: 'Still urgent', priority: 1 } });
    await owner.mutation(api.issues.update, { ids: [first.id], patch: { priority: 2 } });
    await owner.mutation(api.issues.update, { ids: [other.id], patch: { priority: 1 } });
    // Created as done it carries no priority, so it does not count.
    await createOne(owner, f.orb, { priority: 1, status: 'done' });
    // Closed issues free the place too.
    await owner.mutation(api.issues.update, { ids: [other.id], patch: { status: 'canceled' } });
    await owner.mutation(api.issues.update, { ids: [third.id], patch: { priority: 1 } });
  });

  test('hard limit 0 and no limit; soft limits keep warning with the configured number', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await setLimits(owner, { urgent: { max: 0, hard: true }, high: { max: null, hard: true } });
    const data = await expectCode(owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'x', priority: 1 }] }), 'priority_limit');
    expect(String(data.message)).toContain('Team ORB allows no open urgent issues (hard limit 0)');
    const many = await owner.mutation(api.issues.create, { issues: [1, 2, 3, 4, 5].map((n) => ({ teamId: f.orb, title: `H${n}`, priority: 2 as const })) });
    expect(many.warnings).toEqual([]);
    await setLimits(owner, { urgent: { max: 2, hard: false }, high: { max: 3, hard: false } });
    await createOne(owner, f.orb, { priority: 1 });
    await createOne(owner, f.orb, { priority: 1 });
    const third = await owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'U3', priority: 1 }] });
    expect(third.warnings).toMatchObject([{ code: 'budget_warning', priority: 1, open: 3, budget: 2 }]);
    expect(third.warnings[0].message).toContain('(limit 2)');
  });

  test('a lowered limit: issues above it stay, only new raises are rejected', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const highs = await owner.mutation(api.issues.create, { issues: [1, 2, 3].map((n) => ({ teamId: f.orb, title: `H${n}`, priority: 2 as const })) });
    await setLimits(owner, { urgent: { max: 1, hard: false }, high: { max: 1, hard: true } });
    for (const { id } of highs.issues) expect((await getIssue(t, id)).priority).toBe(2);
    // Over the limit: lowering one still leaves two, so raising another is rejected.
    await owner.mutation(api.issues.update, { ids: [highs.issues[0].id], patch: { priority: 3 } });
    const low = await createOne(owner, f.orb, { priority: 4 });
    await expectCode(owner.mutation(api.issues.update, { ids: [low.id], patch: { priority: 2 } }), 'priority_limit');
    // Other fields of the high ones stay editable.
    await owner.mutation(api.issues.update, { ids: [highs.issues[1].id], patch: { title: 'Renamed', estimate: 3 } });
  });

  test('undo, restore from the trash and moving to another team are raises too', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await setLimits(owner, HARD_URGENT);
    const a = await createOne(owner, f.orb, { priority: 1 });
    // Undo of "lower a": b took the place in the meantime.
    await owner.mutation(api.issues.update, { ids: [a.id], patch: { priority: 3 } });
    const b = await createOne(owner, f.orb, { priority: 1 });
    await expectCode(owner.mutation(api.issues.revert, { items: [{ id: a.id, patch: { priority: 1 }, expect: { priority: 3 } }] }), 'priority_limit');
    // Restore: a deleted urgent issue does not count, restoring it would.
    await owner.mutation(api.issues.remove, { ids: [b.id] });
    await owner.mutation(api.issues.update, { ids: [a.id], patch: { priority: 1 } });
    await expectCode(owner.mutation(api.issues.restore, { ids: [b.id] }), 'priority_limit');
    expect((await getIssue(t, b.id)).deletedAt).toBeDefined();
    // Move: the urgent issue of Nova does not fit into Orbit.
    const n = await createOne(owner, f.nova, { priority: 1 });
    await expectCode(owner.mutation(api.issues.moveTeam, { ids: [n.id], teamId: f.orb }), 'priority_limit');
    expect((await getIssue(t, n.id)).teamId).toBe(f.nova);
    await owner.mutation(api.issues.update, { ids: [n.id], patch: { priority: 2 } });
    await owner.mutation(api.issues.moveTeam, { ids: [n.id], teamId: f.orb });
  });

  test('recurrences: a full hard limit creates the issue without the priority, in the inbox; not paused', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await setLimits(owner, HARD_URGENT);
    await createOne(owner, f.orb, { priority: 1 });
    const { recurrenceId } = await owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'Weekly fire drill', cadence: 'weekly', weekday: 1, priority: 1 });
    const now = Date.now();
    await t.run(async (ctx) => await ctx.db.patch('recurrences', recurrenceId, { nextDate: berlinDay(now) }));
    const result = await t.run(async (ctx) => await runDueRecurrences(ctx, now));
    expect(result.paused).toEqual([]);
    expect(result.created).toHaveLength(1);
    const issueId = result.created[0].issueId as Id<'issues'>;
    expect((await getIssue(t, issueId)).priority).toBe(0);
    expect((await historyOf(t, issueId)).find((h) => h.field === 'priority')).toMatchObject({ from: 1, actor: { kind: 'system' } });
    const entry = await t.run(async (ctx) => await ctx.db.query('inboxEntries').withIndex('by_issue', (q) => q.eq('issueId', issueId)).first());
    expect(entry).not.toBeNull();
    expect((await t.run(async (ctx) => await ctx.db.get('recurrences', recurrenceId)))!.active).toBe(true);
  });

  test('import: a full hard limit keeps the issue, drops the priority and notes it', async () => {
    const { t, owner } = setup();
    await setLimits(owner, { urgent: { max: 1, hard: false }, high: { max: 0, hard: true } });
    await stage(t, stagingRows(normalize(rawData(), { run: 'r1', fetchedAt: Date.UTC(2026, 9, 8) })));
    const summary = (await t.action(internal.importer.process, { run: 'r1' })) as { status: string; deviations: string[] };
    expect(summary.status).toBe('done');
    // KIU-2 is high and in review in Linear.
    expect(summary.deviations).toContain('KIU-2: priority high not taken, the hard limit of team KIU is full');
    const kiu2 = await t.run(async (ctx) => {
      const team = await ctx.db.query('teams').withIndex('by_key', (q) => q.eq('key', 'KIU')).unique();
      return (await ctx.db.query('issues').withIndex('by_team_number', (q) => q.eq('teamId', team!._id).eq('number', 2)).unique())!;
    });
    expect(kiu2.priority).toBe(0);
    expect(kiu2.status).toBe('in_review');
  });
});

/** Like `push`: rows in batches via importer:stage. */
async function stage(t: T, rows: ImportStagingRow[]) {
  for (let i = 0; i < rows.length; i += 500) await t.mutation(internal.importer.stage, { rows: rows.slice(i, i + 500) });
}
