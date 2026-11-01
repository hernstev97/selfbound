import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';

import { purgeIssue } from '../convex/ops/issues';
import { defaultStage, normalizePeriod, periodRange, stageOfIssue } from '../convex/shared/roadmap';
import { createOne, expectCode, fixture, getIssue, historyOf, setup, stateId, type Client, type T } from './helpers';

// Roadmap and progress (SELF-113): project fields, label order, the public flag and card of an issue,
// the roadmap settings of a team, and the MCP tools on top of them.

type Json = Record<string, any>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function mcpClient(t: T, key: string) {
  let id = 0;
  return async (name: string, args: Json = {}) => {
    const response = await t.fetch('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(response.status).toBe(200);
    const result = ((await response.json()) as Json).result as Json;
    if (result.isError) return { ok: false as const, error: String(result.content[0].text), value: undefined as any };
    return { ok: true as const, value: result.structuredContent as any, error: '' };
  };
}

async function agentCall(t: T, owner: Client) {
  const { key } = await owner.action(api.agents.create, { name: 'Aleister' });
  return mcpClient(t, key);
}

/** An uploaded image (through MCP upload_image) and its token. */
async function uploadImage(call: Awaited<ReturnType<typeof agentCall>>) {
  const result = await call('upload_image', { data: b64(PNG), filename: 'cover.png' });
  expect(result.ok, result.error).toBe(true);
  const token = String(result.value.url).split('/img/')[1]!;
  return { url: result.value.url as string, markdown: result.value.markdown as string, token };
}

describe('shared/roadmap', () => {
  test('default stages follow the status type; review/test names count as testing', () => {
    expect(defaultStage({ name: 'Done', type: 'completed' })).toBe('done');
    expect(defaultStage({ name: 'In Progress', type: 'started' })).toBe('progress');
    expect(defaultStage({ name: 'In Review', type: 'started' })).toBe('testing');
    expect(defaultStage({ name: 'Auf Test', type: 'started' })).toBe('testing');
    expect(defaultStage({ name: 'Todo', type: 'unstarted' })).toBe('planned');
    expect(defaultStage({ name: 'Backlog', type: 'backlog' })).toBe('tentative');
    expect(defaultStage({ name: 'Triage', type: 'triage' })).toBe('hidden');
    expect(defaultStage({ name: 'Canceled', type: 'canceled' })).toBe('hidden');
    const states = [{ _id: 's1', name: 'Doing', type: 'started' as const }];
    expect(stageOfIssue({ stateId: 's1', status: 'in_progress' }, states, { on: true, stages: [{ stateId: 's1', stage: 'testing' }] })).toBe('testing');
    expect(stageOfIssue({ status: 'done' }, states, null)).toBe('done');
  });

  test('periods: quarters and months, normalized and as day ranges', () => {
    expect(normalizePeriod('2027-q1')).toBe('2027-Q1');
    expect(normalizePeriod(' Q3 2027 ')).toBe('2027-Q3');
    expect(normalizePeriod('2027-3')).toBe('2027-03');
    expect(normalizePeriod('2027-13')).toBeNull();
    expect(normalizePeriod('next year')).toBeNull();
    expect(periodRange('2027-Q1')).toMatchObject({ kind: 'quarter', start: '2027-01-01', end: '2027-03-31' });
    expect(periodRange('2028-02')).toMatchObject({ kind: 'month', start: '2028-02-01', end: '2028-02-29' });
    expect(periodRange('2027-Q4')?.end).toBe('2027-12-31');
    expect(periodRange(undefined)).toBeNull();
  });
});

describe('projects as stages', () => {
  test('goal, ready when, period and color: set, normalized, cleared, checked', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { projectId } = await owner.mutation(api.projects.create, {
      teamId: f.orb,
      name: 'Etappe 1',
      description: '  The first playable loop. ',
      readyWhen: 'A run can be won.',
      period: '2027-q1',
      hue: 25,
    });
    let project = await t.run(async (ctx) => (await ctx.db.get('projects', projectId))!);
    expect(project).toMatchObject({ description: 'The first playable loop.', readyWhen: 'A run can be won.', period: '2027-Q1', hue: 25 });

    await owner.mutation(api.projects.update, { projectId, description: '', period: null, hue: null, readyWhen: null });
    project = await t.run(async (ctx) => (await ctx.db.get('projects', projectId))!);
    expect(project.description).toBeUndefined();
    expect(project.period).toBeUndefined();
    expect(project.hue).toBeUndefined();
    expect(project.readyWhen).toBeUndefined();

    await expectCode(owner.mutation(api.projects.update, { projectId, period: 'soon' }), 'invalid');
    await expectCode(owner.mutation(api.projects.update, { projectId, hue: 400 }), 'invalid');
    await expectCode(owner.mutation(api.projects.update, { projectId, description: 'x'.repeat(2001) }), 'invalid');
  });

  test('labels keep an order within their group', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await owner.mutation(api.labels.reorder, { labelIds: [f.feature, f.bug] });
    const labels = await t.run(async (ctx) => await ctx.db.query('labels').collect());
    expect(labels.find((l) => l._id === f.feature)?.order).toBe(0);
    expect(labels.find((l) => l._id === f.bug)?.order).toBe(1);
    // Moving into another group drops the old position.
    await owner.mutation(api.labels.update, { labelId: f.bug, groupId: f.area });
    expect((await t.run(async (ctx) => await ctx.db.get('labels', f.bug)))?.order).toBeUndefined();
  });
});

describe('public flag and card', () => {
  test('public is a field with history and undo; stored only as true', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { public: true });
    expect((await getIssue(t, id)).public).toBe(true);
    await owner.mutation(api.issues.update, { ids: [id], patch: { public: false } });
    expect('public' in (await getIssue(t, id))).toBe(false);
    const rows = (await historyOf(t, id)).filter((h) => h.field === 'public');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: true });
    await owner.mutation(api.issues.revert, { items: [{ id, patch: { public: true }, expect: { public: false } }] });
    expect((await getIssue(t, id)).public).toBe(true);
  });

  test('card: texts and image, history, detail, cards of the team; empty card is deleted', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const call = await agentCall(t, owner);
    const image = await uploadImage(call);
    const { id } = await createOne(owner, f.orb);
    const before = (await getIssue(t, id)).updatedAt;

    await owner.mutation(api.roadmap.setCard, { id, title: '  Ember   Knight ', summary: 'A new hero.\n\n\n\nWith fire.', image: image.markdown });
    const card = await t.run(async (ctx) => await ctx.db.query('publicCards').withIndex('by_issue', (q) => q.eq('issueId', id)).unique());
    expect(card).toMatchObject({ title: 'Ember Knight', summary: 'A new hero.\n\nWith fire.', image: image.token, teamId: f.orb });
    expect((await getIssue(t, id)).updatedAt).toBeGreaterThanOrEqual(before);
    const fields = (await historyOf(t, id)).map((h) => h.field);
    expect(fields).toEqual(expect.arrayContaining(['publicTitle', 'publicSummary', 'publicImage']));

    // The image now has a reference, so the cleanup keeps it.
    const file = await t.run(async (ctx) => await ctx.db.query('files').withIndex('by_token', (q) => q.eq('token', image.token)).unique());
    expect(file?.deleteAfter).toBeUndefined();

    const detail = await owner.query(api.issues.detail, { id });
    expect(detail?.publicCard).toEqual({ title: 'Ember Knight', summary: 'A new hero.\n\nWith fire.', image: image.url });
    expect(await owner.query(api.roadmap.cards, { teamId: f.orb })).toEqual([{ issueId: id, title: 'Ember Knight', summary: 'A new hero.\n\nWith fire.', image: image.url }]);
    expect(await owner.query(api.roadmap.cards, { teamId: f.nova })).toEqual([]);

    await expectCode(owner.mutation(api.roadmap.setCard, { id, image: 'https://example.com/a.png' }), 'invalid');
    await expectCode(owner.mutation(api.roadmap.setCard, { id, title: 'x'.repeat(121) }), 'invalid');

    await owner.mutation(api.roadmap.setCard, { id, title: null, summary: '', image: null });
    expect(await t.run(async (ctx) => await ctx.db.query('publicCards').collect())).toEqual([]);
    const refs = await t.run(async (ctx) => await ctx.db.query('fileRefs').withIndex('by_token', (q) => q.eq('token', image.token)).collect());
    expect(refs).toEqual([]);
  });

  test('the card follows a team move and goes with the issue when it is purged', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { public: true });
    await owner.mutation(api.roadmap.setCard, { id, title: 'Card' });
    await owner.mutation(api.issues.moveTeam, { ids: [id], teamId: f.nova });
    expect((await owner.query(api.roadmap.cards, { teamId: f.nova })).map((c) => c.title)).toEqual(['Card']);
    await owner.mutation(api.issues.remove, { ids: [id] });
    await t.run(async (ctx) => await purgeIssue(ctx, (await ctx.db.get('issues', id))!, Date.now()));
    expect(await t.run(async (ctx) => await ctx.db.query('publicCards').collect())).toEqual([]);
  });
});

describe('roadmap settings', () => {
  test('on, category group, stages and branding, with checks', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const review = await stateId(t, f.orb, 'in_review');
    await owner.mutation(api.roadmap.updateSettings, {
      teamId: f.orb,
      on: true,
      categoryGroupId: f.area,
      stages: [{ stateId: review, stage: 'progress' }],
      title: ' Copper ',
      subtitle: 'Roadmap',
      accent: '#B87333',
    });
    let team = await t.run(async (ctx) => (await ctx.db.get('teams', f.orb))!);
    expect(team.roadmap).toEqual({ on: true, categoryGroupId: f.area, stages: [{ stateId: review, stage: 'progress' }], title: 'Copper', subtitle: 'Roadmap', accent: '#b87333' });

    await owner.mutation(api.roadmap.updateSettings, { teamId: f.orb, categoryGroupId: null, stages: [], subtitle: null, accent: null });
    team = await t.run(async (ctx) => (await ctx.db.get('teams', f.orb))!);
    expect(team.roadmap).toEqual({ on: true, title: 'Copper' });

    const novaDone = await stateId(t, f.nova, 'done');
    await expectCode(owner.mutation(api.roadmap.updateSettings, { teamId: f.orb, stages: [{ stateId: novaDone, stage: 'done' }] }), 'invalid');
    await expectCode(owner.mutation(api.roadmap.updateSettings, { teamId: f.orb, accent: 'copper' }), 'invalid');
    const { groupId: novaGroup } = await owner.mutation(api.labelGroups.create, { name: 'Nova areas', exclusive: true, teamId: f.nova });
    await expectCode(owner.mutation(api.roadmap.updateSettings, { teamId: f.orb, categoryGroupId: novaGroup }), 'invalid');
  });
});

describe('MCP: roadmap tools (SELF-113)', () => {
  test('projects: create, update with position, list with progress', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const call = await agentCall(t, owner);
    const one = await call('create_project', { requestId: 'p-one-0001', team: 'ORB', name: 'Etappe 1', period: '2027-q1', description: 'Goal one', hue: 25 });
    expect(one.ok, one.error).toBe(true);
    expect(one.value.project).toMatchObject({ name: 'Etappe 1', team: 'ORB', state: 'active', period: '2027-Q1', description: 'Goal one', hue: 25, position: 2 });
    expect((await call('create_project', { requestId: 'p-one-0002', team: 'ORB', name: 'etappe 1' })).error).toMatch(/already has a project/);

    const moved = await call('update_project', { team: 'ORB', project: 'etappe 1', position: 1, state: 'planned', readyWhen: 'A run can be won' });
    expect(moved.value.project).toMatchObject({ position: 1, state: 'planned', readyWhen: 'A run can be won' });
    expect((await call('update_project', { team: 'ORB', project: 'Etappe 1', period: 'later' })).error).toMatch(/quarter/);

    const projectId = (await t.run(async (ctx) => await ctx.db.query('projects').collect())).find((p) => p.name === 'Etappe 1')!._id;
    await createOne(owner, f.orb, { projectId, estimate: 3, status: 'done' });
    await createOne(owner, f.orb, { projectId, estimate: 2, status: 'in_progress', public: true });
    await createOne(owner, f.orb, { projectId, status: 'canceled' });
    const list = await call('list_projects', { team: 'ORB' });
    expect(list.value.projects.map((p: Json) => p.name)).toEqual(['Etappe 1', 'Orbit · Search']);
    expect(list.value.projects[0].progress).toEqual({ total: 2, open: 1, started: 1, done: 1, canceled: 1, public: 1, points: { total: 5, done: 3 } });
  });

  test('labels: a new exclusive group, positions, moving and the exclusive flag', async () => {
    const { t, owner } = setup();
    await fixture(owner);
    const call = await agentCall(t, owner);
    for (const [i, name] of ['Figuren', 'Kreise', 'Gegner und Wächter'].entries()) {
      const r = await call('create_label', { requestId: `label-${i}-0001`, team: 'ORB', name, group: 'Kategorie', exclusive: true });
      expect(r.ok, r.error).toBe(true);
      if (i === 0) expect(r.value.createdGroup).toBe('Kategorie');
    }
    const group = (await t.run(async (ctx) => await ctx.db.query('labelGroups').collect())).find((g) => g.name === 'Kategorie')!;
    expect(group).toMatchObject({ exclusive: true });
    const first = await call('update_label', { team: 'ORB', label: 'Gegner und Wächter', position: 1 });
    expect(first.value.label).toMatchObject({ name: 'Gegner und Wächter', group: 'Kategorie', position: 1, scope: 'ORB' });
    const list = await call('list_labels', { team: 'ORB' });
    expect(list.value.labels.filter((l: Json) => l.group === 'Kategorie').map((l: Json) => l.name)).toEqual(['Gegner und Wächter', 'Figuren', 'Kreise']);
    await call('update_label', { team: 'ORB', label: 'Kreise', exclusive: false });
    expect((await t.run(async (ctx) => await ctx.db.get('labelGroups', group._id)))?.exclusive).toBe(false);
    expect((await call('update_label', { label: 'Kreise' })).error).toMatch(/nothing to change/);
    expect((await call('update_label', { label: 'Kreise', name: 'X' })).error).toMatch(/Unknown label/);
  });

  test('public fields through update_issue and create_issues, get_issue, list_issues filter', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const call = await agentCall(t, owner);
    const image = await uploadImage(call);
    const created = await call('create_issues', {
      requestId: 'pub-create-1',
      issues: [{ team: 'ORB', title: 'Internal name', status: 'todo', public: true, publicTitle: 'Ember Knight', publicSummary: 'A hero of fire.', publicImage: image.url }],
    });
    expect(created.ok, created.error).toBe(true);
    const identifier = created.value.created[0].identifier;
    expect(created.value.created[0].public).toBe(true);

    const got = await call('get_issue', { identifier });
    expect(got.value).toMatchObject({ public: true, publicCard: { title: 'Ember Knight', summary: 'A hero of fire.', image: image.url } });

    const updated = await call('update_issue', { identifier, publicSummary: null, expected: { public: true } });
    expect(updated.value.changed).toEqual(['publicSummary']);
    expect(updated.value.publicCard).toEqual({ title: 'Ember Knight', summary: null, image: image.url });

    const conflict = await call('update_issue', { identifier, public: false, expected: { public: false } });
    expect(conflict.value.conflicts).toEqual([{ field: 'public', expected: false, actual: true }]);

    await createOne(owner, f.orb, { title: 'Secret' });
    const onlyPublic = await call('list_issues', { team: 'ORB', public: true });
    expect(onlyPublic.value.issues.map((i: Json) => i.identifier)).toEqual([identifier]);
    const notPublic = await call('list_issues', { team: 'ORB', public: false });
    expect(notPublic.value.issues.map((i: Json) => i.title)).toEqual(['Secret']);

    // The agent's change shows in the owner's inbox.
    const inbox = await t.run(async (ctx) => await ctx.db.query('inboxEntries').collect());
    expect(inbox.length).toBeGreaterThan(0);
  });

  test('update_roadmap and get_roadmap: categories, stages, public only', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const call = await agentCall(t, owner);
    await call('create_project', { requestId: 'rm-proj-01', team: 'ORB', name: 'Etappe 1', period: '2027-Q1', position: 1 });
    for (const [i, name] of ['Figuren', 'Kreise'].entries()) await call('create_label', { requestId: `rm-lab-${i}-01`, team: 'ORB', name, group: 'Kategorie', exclusive: true });
    expect((await call('update_roadmap', { team: 'ORB', categoryGroup: 'Nope' })).error).toMatch(/Unknown label group/);
    expect((await call('update_roadmap', { team: 'ORB', stages: [{ status: 'Nope', stage: 'done' }] })).error).toMatch(/Unknown status/);
    const set = await call('update_roadmap', { team: 'ORB', enabled: true, categoryGroup: 'kategorie', stages: [{ status: 'In Review', stage: 'progress' }], accent: '#b87333' });
    expect(set.ok, set.error).toBe(true);
    expect(set.value).toMatchObject({ team: 'ORB', enabled: true, categoryGroup: { name: 'Kategorie', labels: ['Figuren', 'Kreise'] }, accent: '#b87333' });
    expect(set.value.stages.find((s: Json) => s.status === 'In Review')).toEqual({ status: 'In Review', stage: 'progress', custom: true });

    await call('create_issues', {
      requestId: 'rm-issues-01',
      issues: [
        { team: 'ORB', title: 'Hero', project: 'Etappe 1', labels: ['Figuren'], status: 'done', public: true, publicTitle: 'The hero' },
        { team: 'ORB', title: 'Secret boss', project: 'Etappe 1', labels: ['Kreise'], status: 'todo' },
        { team: 'ORB', title: 'In triage', project: 'Etappe 1' },
      ],
    });
    const all = await call('get_roadmap', { team: 'ORB' });
    const stage1 = all.value.projects[0];
    expect(stage1).toMatchObject({ name: 'Etappe 1', periodStart: '2027-01-01', periodEnd: '2027-03-31', progress: { done: 1, total: 2 } });
    expect(stage1.categories.map((c: Json) => c.name)).toEqual(['Figuren', 'Kreise']);
    const pub = await call('get_roadmap', { team: 'ORB', publicOnly: true });
    expect(JSON.stringify(pub.value)).not.toContain('Secret boss');
    expect(pub.value.projects[0].categories).toEqual([
      { name: 'Figuren', issues: [expect.objectContaining({ title: 'Hero', publicTitle: 'The hero', stage: 'done', public: true })] },
    ]);
    // Teams stay owner-only: the roadmap settings are the only team field an agent writes.
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.orb)))?.roadmap?.on).toBe(true);
  });
});


