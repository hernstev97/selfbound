import { describe, expect, test } from 'vitest';
import { normalize, stagingRows } from '../../tooling/linear-import/normalize.ts';
import { api, internal } from '../convex/_generated/api';
import type { Doc } from '../convex/_generated/dataModel';
import { readCounter, teamCounter } from '../convex/lib/counters';
import { hueOf } from '../convex/ops/import';
import type { ImportStagingRow } from '../convex/shared/importTypes';
import { expectSprintInvariant, historyOf, setup, type T } from './helpers';
import { rawData, TEAMS } from './lib/linear-import/fixtures.ts';

// Import from Linear: staging → tables (convex-test). Data: made-up fixtures.

type Summary = {
  status: string;
  counts: Record<string, { seen: number; created: number; updated: number; unchanged: number; skipped: number }>;
  deviations: string[];
  conflicts: string[];
};

/** Like `push`: rows in batches via importer:stage. */
async function stage(t: T, rows: ImportStagingRow[]) {
  for (let i = 0; i < rows.length; i += 500) await t.mutation(internal.importer.stage, { rows: rows.slice(i, i + 500) });
}

async function runImport(t: T, run: string, raw = rawData()) {
  await stage(t, stagingRows(normalize(raw, { run, fetchedAt: Date.UTC(2026, 9, 8) })));
  return (await t.action(internal.importer.process, { run })) as Summary;
}

async function tableCounts(t: T) {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of [
      'teams',
      'labelGroups',
      'labels',
      'projects',
      'sprints',
      'sprintItems',
      'issues',
      'issueBodies',
      'identifierAliases',
      'comments',
      'relations',
      'pullRequests',
      'issuePullRequests',
      'linearLinks',
      'importStaging',
    ] as const) {
      out[table] = (await ctx.db.query(table).collect()).length;
    }
    return out;
  });
}

async function byIdentifier(t: T, identifier: string): Promise<Doc<'issues'>> {
  return await t.run(async (ctx) => {
    const [key, n] = identifier.split('-');
    const team = await ctx.db
      .query('teams')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    return (await ctx.db
      .query('issues')
      .withIndex('by_team_number', (q) => q.eq('teamId', team!._id).eq('number', Number(n)))
      .unique())!;
  });
}

const seen = (summary: Summary) => Object.fromEntries(Object.entries(summary.counts).map(([k, c]) => [k, c.seen]));

describe('Import from Linear', () => {
  test('first run: all kinds, identifiers, aliases, parent, relations, comments, PRs, cycles', async () => {
    const { t, owner } = setup();
    const summary = await runImport(t, 'r1');
    expect(summary.status).toBe('done');
    expect(seen(summary)).toEqual({
      team: 3,
      labelGroup: 1,
      label: 4,
      project: 2,
      sprint: 2,
      issue: 7,
      parent: 7,
      comment: 32,
      relation: 2,
      pullRequest: 2,
      link: 1,
    });
    expect(summary.counts.issue).toMatchObject({ created: 7, skipped: 0 });
    const counts = await tableCounts(t);
    expect(counts).toMatchObject({
      teams: 3,
      issues: 7,
      issueBodies: 7,
      comments: 33, // 32 + "Attachments from Linear"
      relations: 2,
      pullRequests: 2,
      issuePullRequests: 2,
      sprints: 2,
      sprintItems: 2,
      importStaging: 0,
    });

    const kiu2 = await byIdentifier(t, 'KIU-2');
    const kiu1 = await byIdentifier(t, 'KIU-1');
    expect(kiu2).toMatchObject({ status: 'in_review', priority: 2, estimate: 3, dueDate: '2026-10-20', parentId: kiu1._id });
    expect(kiu2.createdBy).toEqual({ kind: 'import' });
    expect(kiu2.reviewedAt).toBeDefined();
    expect(kiu1.seq).toBeLessThan(kiu2.seq); // seq follows the creation date
    expect(kiu2.sprintId).toBeUndefined();
    // old identifier → issue
    expect(await owner.query(api.issues.resolve, { identifier: 'old-7' })).toEqual({ id: kiu2._id, identifier: 'KIU-2' });
    // team counter = highest number; a new issue gets KIU-7
    const kiu = await t.run(async (ctx) => (await ctx.db.query('teams').withIndex('by_key', (q) => q.eq('key', 'KIU')).unique())!);
    expect(await t.run(async (ctx) => await readCounter(ctx, teamCounter(kiu._id)))).toBe(6);
    const created = await owner.mutation(api.issues.create, { issues: [{ teamId: kiu._id, title: 'New in XLR8' }] });
    expect(created.issues[0].identifier).toBe('KIU-7');

    const detail = (await owner.query(api.issues.detail, { id: kiu2._id }))!;
    expect(detail.comments).toHaveLength(31);
    expect(detail.comments.every((c) => c.author.kind === 'import')).toBe(true);
    expect(detail.comments.some((c) => c.authorName === 'Owner (Linear)')).toBe(true);
    expect(detail.comments.some((c) => c.body.startsWith('**Attachments from Linear**') && c.body.includes('figma.com'))).toBe(true);
    expect(detail.pullRequests).toEqual([expect.objectContaining({ repo: 'acme/app', number: 42, state: 'merged', via: 'import', closes: false })]);
    expect(detail.relations.map((r) => `${r.type}:${r.direction}:${r.other.identifier}`)).toEqual(['blocks:out:KIU-3']);
    expect(detail.sprints).toEqual([expect.objectContaining({ kind: 'imported', outcome: 'backlog', sprint: expect.objectContaining({ state: 'closed' }) })]);
    const bot = (await owner.query(api.issues.detail, { id: kiu1._id }))!.comments.find((c) => c.authorName === 'GitHub (Linear)');
    expect(bot).toBeDefined();

    const sprints = await t.run(async (ctx) => await ctx.db.query('sprints').collect());
    expect(sprints.map((s) => [s.number, s.name, s.state, s.source])).toEqual([
      [1, 'Start', 'closed', 'linear'],
      [2, 'KIU Cycle 2', 'closed', 'linear'],
    ]);
    // Linear sprints do not count towards capacity.
    expect((await owner.query(api.sprints.capacitySuggestion, {})).capacity).toBeNull();
    const teams = await t.run(async (ctx) => await ctx.db.query('teams').collect());
    expect(teams.map((x) => [x.key, x.dormant, x.order])).toEqual([
      ['KIU', false, 0],
      ['XLR', false, 1],
      ['OLD', true, 2],
    ]);
    const labels = await t.run(async (ctx) => await ctx.db.query('labels').collect());
    expect(labels.find((l) => l.name === 'UI')).toMatchObject({ archived: true, teamId: kiu._id });
    // Deviations never contain names or titles.
    expect(summary.deviations.some((d) => ['Name', 'Title', 'Titel'].some((w) => d.includes(w)))).toBe(false);
    await expectSprintInvariant(t);
  });

  test('state per team: each issue gets the matching state of its team', async () => {
    const { t } = setup();
    await runImport(t, 'r1');
    const rows = await t.run(async (ctx) => {
      const out: [string, string, string, string][] = [];
      for (const issue of await ctx.db.query('issues').collect()) {
        const team = (await ctx.db.get('teams', issue.teamId))!;
        const state = (await ctx.db.get('workflowStates', issue.stateId!))!;
        expect(state.teamId).toBe(issue.teamId);
        out.push([`${team.key}-${issue.number}`, issue.status, state.name, state.type]);
      }
      return out.sort(([a], [b]) => a.localeCompare(b));
    });
    // Linear states map to the team's state of the same name when the status type matches;
    // "Testing" (a custom Linear state) falls back to the default started state.
    expect(rows).toEqual([
      ['KIU-1', 'done', 'Done', 'completed'],
      ['KIU-2', 'in_review', 'In Review', 'started'],
      ['KIU-3', 'duplicate', 'Duplicate', 'canceled'],
      ['KIU-4', 'triage', 'Triage', 'triage'],
      ['KIU-5', 'backlog', 'Backlog', 'backlog'],
      ['KIU-6', 'canceled', 'Canceled', 'canceled'],
      ['XLR-1', 'in_progress', 'In Progress', 'started'],
    ]);
  });

  test('second run right after: same counts, no duplicates, nothing changed', async () => {
    const { t } = setup();
    const first = await runImport(t, 'r1');
    const before = await tableCounts(t);
    const issuesBefore = await t.run(async (ctx) => await ctx.db.query('issues').collect());
    const second = await runImport(t, 'r2');
    expect(second.status).toBe('done');
    expect(seen(second)).toEqual(seen(first));
    for (const [step, c] of Object.entries(second.counts)) expect([step, c.created, c.updated]).toEqual([step, 0, 0]);
    const after = await tableCounts(t);
    expect(after).toEqual(before);
    const issuesAfter = await t.run(async (ctx) => await ctx.db.query('issues').collect());
    expect(issuesAfter).toEqual(issuesBefore);
    const runs = await t.run(async (ctx) => await ctx.db.query('importRuns').collect());
    expect(runs.map((r) => r.status)).toEqual(['done', 'done']);
  });

  test('collision: an issue created in XLR8 with a Linear identifier gets the next free number and an alias', async () => {
    const { t, owner } = setup();
    // The owner already created team KIU in XLR8 with two issues.
    const { teamId } = await owner.mutation(api.teams.create, { key: 'KIU', name: 'Acme local', hue: 10 });
    await owner.mutation(api.teams.create, { key: 'ZZZ', name: 'Own team' });
    const mine = await owner.mutation(api.issues.create, {
      issues: [
        { teamId, title: 'My first' },
        { teamId, title: 'My second' },
      ],
    });
    const summary = await runImport(t, 'r1');
    expect(summary.conflicts).toHaveLength(2);
    expect(summary.conflicts[0]).toMatch(/^KIU-1 was created in XLR8\. Linear keeps KIU-1, the XLR8 issue is now KIU-7/);
    const first = await t.run(async (ctx) => (await ctx.db.get('issues', mine.issues[0].id))!);
    const second = await t.run(async (ctx) => (await ctx.db.get('issues', mine.issues[1].id))!);
    expect([first.number, second.number]).toEqual([7, 8]);
    expect((await historyOf(t, first._id)).at(-1)).toMatchObject({ field: 'identifier', from: 'KIU-1', to: 'KIU-7', actor: { kind: 'import' } });
    // KIU-1 is now the Linear issue; the old identifier is an alias of the XLR8 issue.
    const resolved = await owner.query(api.issues.resolve, { identifier: 'KIU-1' });
    expect(resolved?.id).not.toBe(first._id);
    const aliases = await t.run(async (ctx) =>
      await ctx.db.query('identifierAliases').withIndex('by_issue', (q) => q.eq('issueId', first._id)).collect(),
    );
    expect(aliases.map((a) => a.key)).toEqual(['KIU-1']);
    // Team adopted instead of duplicated: key once, name from Linear, order from XLR8.
    const teams = await t.run(async (ctx) => await ctx.db.query('teams').collect());
    expect(teams.filter((x) => x.key === 'KIU')).toHaveLength(1);
    expect(teams.find((x) => x.key === 'KIU')).toMatchObject({ name: TEAMS.find((x) => x.key === 'KIU')!.name, order: 0 });
    // Next new issue: KIU-9.
    const next = await owner.mutation(api.issues.create, { issues: [{ teamId, title: 'Afterwards' }] });
    expect(next.issues[0].identifier).toBe('KIU-9');
    const conflicts = await t.run(async (ctx) => await ctx.db.query('importConflicts').collect());
    expect(conflicts.map((c) => c.issueId)).toEqual([first._id, second._id]);
    // Second run: no further conflicts, nothing moved.
    const again = await runImport(t, 'r2');
    expect(again.conflicts).toEqual([]);
    expect((await t.run(async (ctx) => (await ctx.db.get('issues', first._id))!)).number).toBe(7);
  });

  test('later import: changes only in Linear arrive with history, changes on both sides are a conflict, XLR8-owned data stays', async () => {
    const { t, owner } = setup();
    await runImport(t, 'r1');
    const kiu5 = await byIdentifier(t, 'KIU-5');
    const kiu6 = await byIdentifier(t, 'KIU-6');
    const kiu2 = await byIdentifier(t, 'KIU-2');
    // Changed in XLR8: titles of KIU-5 and KIU-6, rank, sprint, parent of KIU-2, team order.
    await owner.mutation(api.issues.update, { ids: [kiu5._id], patch: { title: 'Renamed in XLR8' } });
    await owner.mutation(api.issues.update, { ids: [kiu6._id], patch: { title: 'Only in XLR8' } });
    await owner.mutation(api.issues.update, { ids: [kiu2._id], patch: { parentId: null } });
    await owner.mutation(api.issues.reorder, { id: kiu5._id, beforeId: kiu6._id });
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [kiu5._id] });
    const teams = await t.run(async (ctx) => await ctx.db.query('teams').collect());
    await owner.mutation(api.teams.reorder, { teamIds: [...teams].reverse().map((x) => x._id) });
    const before = await t.run(async (ctx) => (await ctx.db.get('issues', kiu5._id))!);

    // Changed in Linear: title and priority of KIU-5, a new comment on KIU-5.
    const raw = rawData();
    const issue = raw.issues.find((i) => i.identifier === 'KIU-5')!;
    issue.title = 'Title from Linear';
    issue.priority = 3;
    issue.comments.nodes.push({
      id: 'cm-new',
      body: 'New in Linear',
      createdAt: '2026-09-30T10:00:00.000Z',
      editedAt: null,
      parent: null,
      user: { id: 'u-owner', name: 'Owner', displayName: 'owner' },
      botActor: null,
    });
    const summary = await runImport(t, 'r2', raw);
    expect(summary.counts.issue).toMatchObject({ updated: 1, unchanged: 6, created: 0 });
    expect(summary.counts.comment).toMatchObject({ created: 1, unchanged: 32 });

    const after = await t.run(async (ctx) => (await ctx.db.get('issues', kiu5._id))!);
    // Title changed in both: XLR8 stays, conflict. Priority only in Linear: taken.
    expect(after).toMatchObject({ title: 'Renamed in XLR8', priority: 3 });
    expect(summary.conflicts).toEqual(['KIU-5: changed in XLR8 and in Linear (title); the XLR8 value stays.']);
    // XLR8-owned data: rank, sprint, reviewed, seq stay.
    expect(after.rank).toBe(before.rank);
    expect(after.sprintId).toBe(sprintId);
    expect(after.reviewedAt).toBe(before.reviewedAt);
    expect(after.seq).toBe(before.seq);
    const history = await historyOf(t, kiu5._id);
    expect(history.find((h) => h.field === 'title' && h.actor.kind === 'import')).toBeUndefined();
    expect(history.find((h) => h.field === 'priority' && h.actor.kind === 'import')).toMatchObject({ from: 0, to: 3 });
    // Unchanged in Linear: XLR8 changes stay.
    expect((await t.run(async (ctx) => (await ctx.db.get('issues', kiu6._id))!)).title).toBe('Only in XLR8');
    expect((await t.run(async (ctx) => (await ctx.db.get('issues', kiu2._id))!)).parentId).toBeUndefined();
    const teamsAfter = await t.run(async (ctx) => await ctx.db.query('teams').collect());
    expect(teamsAfter.map((x) => x.order)).toEqual(teams.map((x) => teams.length - 1 - x.order));
    // XLR8 sprint untouched, Linear sprints unchanged.
    const sprints = await t.run(async (ctx) => await ctx.db.query('sprints').collect());
    expect(sprints.filter((s) => s.source === 'xlr8')).toEqual([expect.objectContaining({ _id: sprintId, state: 'planning' })]);
    await expectSprintInvariant(t);
  });

  test('hue from Linear hex', () => {
    expect(hueOf('#ff0000')).toBeCloseTo(29.2, 0);
    expect(hueOf('#0000ff')).toBeCloseTo(264.1, 0);
    expect(hueOf('#888888')).toBe(0);
    expect(hueOf(undefined)).toBeUndefined();
    expect(hueOf('blue')).toBeUndefined();
  });
});
