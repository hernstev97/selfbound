import { describe, expect, test } from 'vitest';
import { normalize, stagingRows } from '../../tooling/linear-import/normalize.ts';
import { api, internal } from '../convex/_generated/api';
import { readCounter, SPRINT } from '../convex/lib/counters';
import { createOne, expectSprintInvariant, fixture, setup } from './helpers';
import { rawData } from './lib/linear-import/fixtures.ts';

// migrations:removeTestTeam: remove a test team and its data, e.g. before the first Linear import.

async function testTeam() {
  const env = setup();
  const { owner } = env;
  const f = await fixture(owner);
  const { teamId: test } = await owner.mutation(api.teams.create, { key: 'TEST', name: 'Test Team' });
  const { labelId: testlabel } = await owner.mutation(api.labels.create, { name: 'testlabel', hue: 10 });
  const { projectId } = await owner.mutation(api.projects.create, { teamId: test, name: 'Test project' });
  const a = await createOne(owner, test, { labelIds: [testlabel], projectId });
  const b = await createOne(owner, test);
  const keep = await createOne(owner, f.orb);
  await owner.mutation(api.comments.add, { issueId: a.id, body: 'Test' });
  await owner.mutation(api.relations.add, { fromId: a.id, toId: keep.id, type: 'related' });
  await owner.mutation(api.issues.remove, { ids: [b.id] });
  const sprint = await owner.mutation(api.sprints.create, { startDate: '2026-10-12', endDate: '2026-10-25' });
  await owner.mutation(api.sprints.add, { sprintId: sprint.id, issueIds: [a.id] });
  return { ...env, f, test, testlabel, keep, sprint };
}

const args = { teamKey: 'TEST', sprintNumbers: [1], labelNames: ['testlabel'] };

describe('removeTestTeam', () => {
  test('without apply only the list, nothing changes', async () => {
    const { t } = await testTeam();
    const before = await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length);
    const list = await t.mutation(internal.migrations.removeTestTeam, args);
    expect(list).toMatchObject({
      apply: false,
      team: 'TEST',
      found: true,
      issues: ['TEST-1', 'TEST-2'],
      inTrash: 1,
      comments: 1,
      relations: 1,
      states: 8,
      projects: 1,
      labels: 1,
      sprints: [1],
      sprintItems: 1,
    });
    expect(await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)).toBe(before);
  });

  test('apply deletes team, issues, states, project, label and sprint; other teams stay', async () => {
    const { t, owner, keep, testlabel } = await testTeam();
    await t.mutation(internal.migrations.removeTestTeam, { ...args, apply: true });
    const left = await t.run(async (ctx) => ({
      teams: (await ctx.db.query('teams').collect()).map((x) => x.key).sort(),
      issues: (await ctx.db.query('issues').collect()).map((i) => i._id),
      projects: (await ctx.db.query('projects').collect()).map((p) => p.name).sort(),
      label: await ctx.db.get('labels', testlabel),
      states: (await ctx.db.query('workflowStates').collect()).length,
      sprints: (await ctx.db.query('sprints').collect()).length,
      sprintItems: (await ctx.db.query('sprintItems').collect()).length,
      comments: (await ctx.db.query('comments').collect()).length,
      relations: (await ctx.db.query('relations').collect()).length,
      sprintCounter: await readCounter(ctx, SPRINT),
    }));
    expect(left).toMatchObject({
      teams: ['NOVA', 'ORB'],
      issues: [keep.id],
      projects: ['Nova · Sync', 'Orbit · Search'],
      label: null,
      states: 16,
      sprints: 0,
      sprintItems: 0,
      comments: 0,
      relations: 0,
      sprintCounter: 0,
    });
    // The next sprint gets number 1 again, ORB-1 is unchanged.
    expect((await owner.mutation(api.sprints.create, {})).number).toBe(1);
    expect((await owner.query(api.issues.detail, { id: keep.id }))?.relations).toEqual([]);
    await expectSprintInvariant(t);
    // A second call changes nothing.
    expect(await t.mutation(internal.migrations.removeTestTeam, { ...args, apply: true })).toEqual({ apply: true, team: 'TEST', found: false });
  });

  test('guards: label on another team, sprint with other issues, data from Linear', async () => {
    const { t, owner, keep, testlabel, sprint } = await testTeam();
    await owner.mutation(api.issues.update, { ids: [keep.id], patch: { labelIds: [testlabel] } });
    await expect(t.mutation(internal.migrations.removeTestTeam, { ...args, apply: true })).rejects.toThrow(/a label is on ORB-1/);
    await owner.mutation(api.issues.update, { ids: [keep.id], patch: { labelIds: [] } });
    const testIssue = await t.run(async (ctx) => (await ctx.db.query('issues').collect()).find((i) => i._id !== keep.id && i.deletedAt === undefined)!);
    await owner.mutation(api.issues.update, { ids: [keep.id], patch: { parentId: testIssue._id } });
    await expect(t.mutation(internal.migrations.removeTestTeam, { ...args, apply: true })).rejects.toThrow(/ORB-1 is a sub-issue/);
    await owner.mutation(api.issues.update, { ids: [keep.id], patch: { parentId: null } });
    await owner.mutation(api.sprints.add, { sprintId: sprint.id, issueIds: [keep.id] });
    await expect(t.mutation(internal.migrations.removeTestTeam, { ...args, apply: true })).rejects.toThrow(/issues of other teams/);

    // An imported team (KIU) is never deleted.
    await t.run(async (ctx) => {
      for (const row of stagingRows(normalize(rawData(), { run: 'r1', fetchedAt: Date.UTC(2026, 9, 8) }))) await ctx.db.insert('importStaging', row);
    });
    await t.action(internal.importer.process, { run: 'r1' });
    await expect(t.mutation(internal.migrations.removeTestTeam, { teamKey: 'KIU', apply: true })).rejects.toThrow(/Linear import/);
    expect(await t.run(async (ctx) => (await ctx.db.query('teams').collect()).length)).toBe(6);
  });
});
