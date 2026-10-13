import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { berlinDay } from '../convex/lib/dates';
import { dayWindow, minuteWindow, RATE_PER_MINUTE } from '../convex/ops/agents';
import { createOne, expectSprintInvariant, fixture, getIssue, historyOf, setup, type Client, type T } from './helpers';

// MCP endpoint over HTTP (t.fetch → convex/http.ts → internal.mcp.call), with real agent keys.

type Json = Record<string, any>;

async function agent(owner: Client, name = 'Claude Code') {
  return await owner.action(api.agents.create, { name });
}

function client(t: T, key: string) {
  let id = 0;
  const post = async (body: unknown, headers: Record<string, string> = {}) =>
    await t.fetch('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
        'MCP-Protocol-Version': '2025-11-25',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const rpc = async (method: string, params?: Json) => {
    const response = await post({ jsonrpc: '2.0', id: ++id, method, params });
    return { status: response.status, body: (await response.json()) as Json };
  };
  /** Calls a tool: { ok, value | error } */
  const call = async (name: string, args: Json = {}) => {
    const { status, body } = await rpc('tools/call', { name, arguments: args });
    expect(status).toBe(200);
    const result = body.result as Json;
    if (result.isError) return { ok: false as const, error: String(result.content[0].text), value: undefined as any };
    return { ok: true as const, value: result.structuredContent as any, error: '' };
  };
  return { post, rpc, call };
}

async function rateCount(t: T, agentId: Id<'agents'>) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query('rateWindows')
      .withIndex('by_agent_window', (q) => q.eq('agentId', agentId).eq('window', dayWindow(Date.now())))
      .unique();
    return row?.count ?? 0;
  });
}

describe('MCP over HTTP', () => {
  test('handshake, tool list, 401 without OAuth challenge, 405, .well-known 404, /health', async () => {
    const { t, owner } = setup();
    const { key } = await agent(owner);
    const mcp = client(t, key);
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1' },
    });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'xlr8' } });
    const tools = await mcp.rpc('tools/list');
    expect((tools.body.result.tools as Json[]).map((x) => x.name)).toEqual([
      'search_issues',
      'list_issues',
      'get_issue',
      'create_issues',
      'update_issue',
      'set_status',
      'move_issues',
      'add_comment',
      'get_current_sprint',
      'list_teams',
      'list_projects',
      'list_labels',
      'list_statuses',
      'list_inbox',
      'search_articles',
      'list_articles',
      'get_article',
      'create_article',
      'update_article',
    ]);
    // No tool changes teams or logos.
    expect(JSON.stringify(tools.body.result.tools)).not.toMatch(/logo|create_team|update_team/i);

    const wrong = await client(t, 'xlr8_wrong').rpc('tools/list');
    expect(wrong.status).toBe(401);
    const noKey = await t.fetch('/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get('www-authenticate')).toBeNull();
    expect((await t.fetch('/mcp', { method: 'GET' })).status).toBe(405);
    expect((await t.fetch('/mcp', { method: 'DELETE' })).status).toBe(405);
    expect((await t.fetch('/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await t.fetch('/.well-known/oauth-protected-resource/mcp')).status).toBe(404);
    expect((await t.fetch('/.well-known/oauth-authorization-server')).status).toBe(404);
    const health = await t.fetch('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  test('create_issues: requestId twice → one issue, actor agent, unreviewed, triage, priority warning', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb, { priority: 1 });
    const { key, agentId } = await agent(owner);
    const mcp = client(t, key);
    const args = {
      requestId: 'req-create-0001',
      issues: [
        { team: 'orb', title: 'From the agent', priority: 'urgent', labels: ['bug', 'Design'], project: 'orbit · search', dueDate: '2026-12-01' },
        { team: 'NOVA', title: 'Second', parent: 'ORB-1' },
      ],
    };
    const first = await mcp.call('create_issues', args);
    expect(first.ok, first.error).toBe(true);
    expect(first.value.created.map((c: Json) => c.identifier)).toEqual(['ORB-2', 'NOVA-1']);
    expect(first.value.created[0]).toMatchObject({ status: 'Triage', statusType: 'triage', priority: 'urgent', labels: ['Bug', 'Design'], project: 'Orbit · Search' });
    expect(first.value.created[1]).toMatchObject({ parent: 'ORB-1' });
    expect(first.value.warnings).toEqual([expect.objectContaining({ code: 'budget_warning', team: 'ORB', priority: 'urgent', open: 2 })]);
    const again = await mcp.call('create_issues', args);
    expect(again.value.created.map((c: Json) => c.identifier)).toEqual(['ORB-2', 'NOVA-1']);
    const issues = await t.run(async (ctx) => await ctx.db.query('issues').collect());
    expect(issues).toHaveLength(3);
    const created = issues.find((i) => i.number === 2)!;
    expect(created.createdBy).toEqual({ kind: 'agent', agentId });
    expect(created.reviewedAt).toBeUndefined();
    expect((await historyOf(t, created._id))[0]).toMatchObject({ field: 'created', actor: { kind: 'agent', agentId }, requestId: 'req-create-0001' });

    // Same requestId, different arguments → error, nothing created.
    const reused = await mcp.call('create_issues', { ...args, issues: [{ team: 'ORB', title: 'Different' }] });
    expect(reused.ok).toBe(false);
    expect(reused.error).toMatch(/requestId/);
    // Unknown team / label → error with a plain message, nothing created.
    expect((await mcp.call('create_issues', { requestId: 'req-create-0002', issues: [{ team: 'XYZ', title: 'x' }] })).error).toMatch(
      /Unknown team "XYZ"/,
    );
    expect(
      (await mcp.call('create_issues', { requestId: 'req-create-0003', issues: [{ team: 'ORB', title: 'x', labels: ['Nonexistent'] }] }))
        .error,
    ).toMatch(/Unknown label/);
    expect(await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)).toBe(3);
  });

  test('update_issue: compare-and-set per field, description only with version, requestId makes retries safe', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'todo', labelIds: [f.bug] });
    const { key } = await agent(owner);
    const mcp = client(t, key);
    // Meanwhile the owner sets "in progress"; the agent still expects "todo".
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'in_progress' } });
    const result = await mcp.call('update_issue', {
      identifier: 'ORB-1',
      status: 'in_review',
      priority: 'high',
      labels: ['Feature'],
      expected: { status: 'todo', labels: ['BUG'] },
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.value.changed.sort()).toEqual(['labels', 'priority']);
    expect(result.value.conflicts).toEqual([{ field: 'status', expected: 'todo', actual: 'In Progress' }]);
    const issue = await getIssue(t, id);
    expect(issue.status).toBe('in_progress');
    expect(issue.priority).toBe(2);
    expect(issue.labelIds).toEqual([f.feature]);

    // Description: stale version → not written; current version → written.
    const stale = await mcp.call('update_issue', { identifier: 'ORB-1', description: 'New', expectedDescriptionVersion: 0 });
    expect(stale.value.conflicts).toEqual([{ field: 'description', expected: 0, actual: 1 }]);
    const ok = await mcp.call('update_issue', {
      requestId: 'req-update-0001',
      identifier: 'ORB-1',
      description: 'New',
      expectedDescriptionVersion: 1,
      dueDate: '2026-11-01',
      expected: { dueDate: null },
    });
    expect(ok.value).toMatchObject({ changed: ['dueDate', 'description'], conflicts: [], descriptionVersion: 2 });
    // Retry after a lost response: same result, no conflict with its own change.
    const retry = await mcp.call('update_issue', {
      requestId: 'req-update-0001',
      identifier: 'ORB-1',
      description: 'New',
      expectedDescriptionVersion: 1,
      dueDate: '2026-11-01',
      expected: { dueDate: null },
    });
    expect(retry.value).toEqual(ok.value);
    const body = await t.run(async (ctx) => await ctx.db.query('issueBodies').withIndex('by_issue', (q) => q.eq('issueId', id)).unique());
    expect(body).toMatchObject({ markdown: 'New', version: 2 });
    const history = await historyOf(t, id);
    expect(history.filter((h) => h.field === 'description')).toHaveLength(1);
    expect(history.find((h) => h.field === 'dueDate')).toMatchObject({ actor: { kind: 'agent' }, requestId: 'req-update-0001' });
    // No description without a version (argument validation).
    expect((await mcp.call('update_issue', { identifier: 'ORB-1', description: 'x' })).error).toMatch(/expectedDescriptionVersion/);
  });

  test('set_status and add_comment (requestId: one comment), trash is rejected', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.nova);
    const { key, agentId } = await agent(owner);
    const mcp = client(t, key);
    const status = await mcp.call('set_status', { identifiers: ['orb-1', 'NOVA-1'], status: 'done' });
    expect(status.value).toMatchObject({ status: 'done', changed: 2 });
    expect((await getIssue(t, a.id)).completedAt).toBeDefined();
    const missing = await mcp.call('set_status', { identifiers: ['ORB-1', 'ORB-77'], status: 'todo' });
    expect(missing.error).toMatch(/ORB-77/);
    expect((await getIssue(t, a.id)).status).toBe('done');

    const comment = { requestId: 'req-comment-0001', identifier: 'NOVA-1', body: 'Progress: done.' };
    const c1 = await mcp.call('add_comment', comment);
    const c2 = await mcp.call('add_comment', comment);
    expect(c1.value.commentId).toBe(c2.value.commentId);
    const comments = await t.run(async (ctx) => await ctx.db.query('comments').collect());
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toEqual({ kind: 'agent', agentId });

    await owner.mutation(api.issues.remove, { ids: [b.id] });
    expect((await mcp.call('add_comment', { ...comment, requestId: 'req-comment-0002' })).error).toMatch(/trash/);
  });

  test('move_issues: new identifier, what is dropped, status, alias, idempotency, several at once', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { title: 'Moves', labelIds: [f.bug, f.orbOnly], projectId: f.orbProject, status: 'in_progress', priority: 2 });
    const b = await createOne(owner, f.orb, { title: 'Moves too' });
    const c = await createOne(owner, f.nova, { title: 'Already there' });
    await createOne(owner, f.nova);
    const { key, agentId } = await agent(owner);
    const mcp = client(t, key);

    const args = { requestId: 'req-move-0001', identifiers: ['orb-1', 'ORB-2', 'NOVA-1'], team: 'nova' };
    const r = await mcp.call('move_issues', args);
    expect(r.ok, r.error).toBe(true);
    expect(r.value.team).toBe('NOVA');
    expect(r.value.moved).toEqual([
      { previousIdentifier: 'ORB-1', identifier: 'NOVA-3', status: 'In Progress', previousStatus: 'In Progress', removed: { project: 'Orbit · Search', labels: ['Release'] } },
      { previousIdentifier: 'ORB-2', identifier: 'NOVA-4', status: expect.any(String), previousStatus: expect.any(String), removed: { project: null, labels: [] } },
    ]);
    expect(r.value.unchanged).toEqual(['NOVA-1']);
    expect(r.value.note).toMatch(/alias/i);

    const moved = await getIssue(t, a.id);
    expect(moved.teamId).toBe(f.nova);
    expect(moved.labelIds).toEqual([f.bug]);
    expect(moved.priority).toBe(2);
    expect((await getIssue(t, c.id)).number).toBe(1);
    expect((await getIssue(t, b.id)).teamId).toBe(f.nova);
    const row = (await historyOf(t, a.id)).find((h) => h.field === 'teamId')!;
    expect(row).toMatchObject({ actor: { kind: 'agent', agentId }, requestId: 'req-move-0001', to: { identifier: 'NOVA-3' } });

    // The old identifier still resolves; get_issue shows the new one and readable identifiers in the history.
    const got = await mcp.call('get_issue', { identifier: 'ORB-1' });
    expect(got.value.identifier).toBe('NOVA-3');
    expect(got.value.previousIdentifiers).toContain('ORB-1');
    expect(got.value.recentHistory.find((h: Json) => h.field === 'teamId')).toMatchObject({ from: 'ORB-1', to: 'NOVA-3' });

    // Retry: stored result, nothing twice; different arguments with the same requestId: error.
    expect(await mcp.call('move_issues', args)).toEqual(r);
    expect((await mcp.call('move_issues', { ...args, team: 'ORB' })).error).toMatch(/requestId/);
    // Without requestId, the same again: everything is already in the target team.
    const again = await mcp.call('move_issues', { identifiers: ['ORB-1', 'NOVA-3'], team: 'NOVA' });
    expect(again.value).toMatchObject({ moved: [], unchanged: ['NOVA-3'] });
    expect((await getIssue(t, a.id)).number).toBe(3);
  });

  test('move_issues: unknown identifier or team, trash, dormant team; nothing moves then', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.orb);
    await owner.mutation(api.teams.create, { key: 'OLD', name: 'Old', dormant: true });
    const { key } = await agent(owner);
    const mcp = client(t, key);
    expect((await mcp.call('move_issues', { identifiers: ['ORB-1', 'ORB-77'], team: 'NOVA' })).error).toMatch(/ORB-77.*Nothing was moved/);
    expect((await mcp.call('move_issues', { identifiers: ['ORB-1'], team: 'NOPE' })).error).toMatch(/Unknown team/);
    await owner.mutation(api.issues.remove, { ids: [b.id] });
    expect((await mcp.call('move_issues', { identifiers: ['ORB-1', 'ORB-2'], team: 'NOVA' })).error).toMatch(/trash/);
    expect((await getIssue(t, a.id)).teamId).toBe(f.orb);
    const dormant = await mcp.call('move_issues', { identifiers: ['ORB-1'], team: 'OLD' });
    expect(dormant.value.warnings).toMatchObject([{ code: 'dormant_team', team: 'OLD' }]);
  });

  test('create_issues in a dormant team: created, with a warning', async () => {
    const { t, owner } = setup();
    await fixture(owner);
    await owner.mutation(api.teams.create, { key: 'OLD', name: 'Old', dormant: true });
    const { key } = await agent(owner);
    const mcp = client(t, key);
    const r = await mcp.call('create_issues', { requestId: 'dormant-1', issues: [{ team: 'old', title: 'Into the dormant team' }, { team: 'ORB', title: 'Normal' }] });
    expect(r.ok, r.error).toBe(true);
    expect(r.value.created.map((c: Json) => c.identifier)).toEqual(['OLD-1', 'ORB-1']);
    expect(r.value.warnings).toEqual([expect.objectContaining({ code: 'dormant_team', team: 'OLD' })]);
  });

  test('list_issues: filters via indexes', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const today = berlinDay(Date.now());
    const { teamId: dormant } = await owner.mutation(api.teams.create, { key: 'OLD', name: 'Old', dormant: true });
    await createOne(owner, f.orb, { title: 'Inbox', status: 'triage' }); // ORB-1
    await createOne(owner, f.orb, { title: 'Open high', status: 'todo', priority: 2, labelIds: [f.bug], projectId: f.orbProject }); // ORB-2
    await createOne(owner, f.orb, { title: 'Overdue', status: 'backlog', dueDate: '2020-01-01', priority: 1 }); // ORB-3
    await createOne(owner, f.nova, { title: 'Started', status: 'in_progress', dueDate: today }); // NOVA-1
    await createOne(owner, f.nova, { title: 'Done', status: 'done' }); // NOVA-2
    await createOne(owner, dormant, { title: 'Dormant', status: 'todo' }); // OLD-1
    await createOne(owner, f.nova, { title: 'Done long ago', status: 'done', dueDate: '2020-01-01' }); // NOVA-3
    const removed = await createOne(owner, f.orb, { title: 'Deleted', status: 'todo' }); // ORB-4
    await owner.mutation(api.issues.remove, { ids: [removed.id] });
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [(await createOne(owner, f.nova, { status: 'todo' })).id] }); // NOVA-4
    await owner.mutation(api.sprints.start, { sprintId });

    const { key } = await agent(owner);
    const mcp = client(t, key);
    const ids = async (args: Json) => {
      const r = await mcp.call('list_issues', args);
      expect(r.ok, r.error).toBe(true);
      return (r.value.issues as Json[]).map((i) => i.identifier);
    };
    // assigned: open, not triage, team not dormant, by priority
    expect(await ids({ filter: 'assigned' })).toEqual(['ORB-3', 'ORB-2', 'NOVA-1', 'NOVA-4']);
    expect(await ids({ filter: 'triage' })).toEqual(['ORB-1']);
    expect(await ids({ filter: 'overdue' })).toEqual(['ORB-3']);
    expect(await ids({ filter: 'due', dueWithinDays: 0 })).toEqual(['ORB-3', 'NOVA-1']);
    expect(await ids({ filter: 'in_progress' })).toEqual(['NOVA-1']);
    // same priority: earlier due date first, no due date last
    expect(await ids({ filter: 'done_today' })).toEqual(['NOVA-3', 'NOVA-2']);
    expect(await ids({ filter: 'sprint' })).toEqual(['NOVA-4']);
    expect(await ids({ team: 'nova', status: ['done'] })).toEqual(['NOVA-3', 'NOVA-2']);
    expect(await ids({ label: 'bug' })).toEqual(['ORB-2']);
    expect(await ids({ project: 'Orbit · Search' })).toEqual(['ORB-2']);
    expect(await ids({})).toEqual(['ORB-3', 'ORB-2', 'NOVA-1', 'ORB-1', 'OLD-1', 'NOVA-4']);
    expect(await ids({ filter: 'assigned', limit: 2 })).toEqual(['ORB-3', 'ORB-2']);
    expect((await mcp.call('list_issues', { label: 'Nonexistent' })).error).toMatch(/Unknown label/);
    await expectSprintInvariant(t);
  });

  test('get_issue (also by old identifier), search_issues, get_current_sprint, list_*', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { title: 'Build search field', description: 'With full text', estimate: 3 });
    const b = await createOne(owner, f.orb, { title: 'Blocked', parentId: a.id });
    await owner.mutation(api.relations.add, { fromId: a.id, toId: b.id, type: 'blocks' });
    await owner.mutation(api.comments.add, { issueId: a.id, body: 'First comment' });
    await t.run(async (ctx) => {
      await ctx.db.insert('identifierAliases', { key: 'OLD-7', issueId: a.id });
      const prId = await ctx.db.insert('pullRequests', {
        repo: 'acme/app',
        number: 4,
        title: 'Search field',
        url: 'https://github.com/acme/app/pull/4',
        state: 'open',
        branch: 'orb-1-search-field',
        updatedAt: 1,
      });
      await ctx.db.insert('issuePullRequests', { issueId: a.id, prId, via: 'branch', closes: true });
    });
    const { id: sprintId } = await owner.mutation(api.sprints.create, { goal: 'Search done' });
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [a.id] });
    await owner.mutation(api.sprints.start, { sprintId });
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [b.id] });

    const { key } = await agent(owner);
    const mcp = client(t, key);
    const issue = (await mcp.call('get_issue', { identifier: 'old-7' })).value;
    expect(issue).toMatchObject({
      identifier: 'ORB-1',
      title: 'Build search field',
      estimate: 3,
      description: { markdown: 'With full text', version: 1 },
      relations: [{ type: 'blocks', identifier: 'ORB-2' }],
      subIssues: [{ identifier: 'ORB-2' }],
      pullRequests: [{ repo: 'acme/app', number: 4, closesOnMerge: true }],
      previousIdentifiers: ['OLD-7'],
      createdBy: 'Owner',
    });
    expect(issue.comments).toEqual([expect.objectContaining({ author: 'Owner', body: 'First comment' })]);
    // The owner's display name comes from XLR8_OWNER_NAME.
    process.env.XLR8_OWNER_NAME = 'Sam';
    try {
      expect((await mcp.call('get_issue', { identifier: 'ORB-1' })).value).toMatchObject({ createdBy: 'Sam', comments: [{ author: 'Sam' }] });
    } finally {
      delete process.env.XLR8_OWNER_NAME;
    }
    expect(issue.recentHistory.length).toBeGreaterThan(0);
    expect((await mcp.call('get_issue', { id: String(a.id) })).value.identifier).toBe('ORB-1');
    expect((await mcp.call('get_issue', { identifier: 'ORB-99' })).error).toMatch(/not found/);
    // Identifiers in every spelling the UI search accepts.
    for (const spelling of ['orb1', 'orb 1', 'Orb-001', 'ORB–1', 'orb_1']) {
      expect((await mcp.call('get_issue', { identifier: spelling })).value.identifier).toBe('ORB-1');
    }
    expect((await mcp.call('get_issue', { identifier: 'just text' })).error).toMatch(/not an issue identifier/);

    const found = (await mcp.call('search_issues', { q: 'full text' })).value;
    expect(found.issues).toEqual([expect.objectContaining({ identifier: 'ORB-1', match: 'description' })]);

    const sprint = (await mcp.call('get_current_sprint')).value;
    expect(sprint).toMatchObject({
      sprint: { goal: 'Search done', state: 'active' },
      points: { done: 0, total: 3 },
      counts: { open: 2, planned: 1, addedLater: 1 },
    });
    expect((await mcp.call('list_teams', { includeDormant: false })).value.teams.map((x: Json) => x.key)).toEqual(['ORB', 'NOVA']);
    expect((await mcp.call('list_projects', { team: 'ORB' })).value.projects).toEqual([{ name: 'Orbit · Search', team: 'ORB', state: 'active' }]);
    const labels = (await mcp.call('list_labels', { team: 'NOVA' })).value.labels as Json[];
    expect(labels.map((l) => l.name).sort()).toEqual(['Bug', 'Design', 'Docs', 'Feature']);
    expect(labels.find((l) => l.name === 'Bug')).toMatchObject({ group: 'Type', exclusive: true, scope: 'workspace' });
  });

  test('revocation and rate limit; failed calls count', async () => {
    const { t, owner } = setup();
    await fixture(owner);
    const { key, agentId } = await agent(owner);
    const mcp = client(t, key);
    expect((await mcp.call('list_teams')).ok).toBe(true);
    expect(await rateCount(t, agentId)).toBe(1);
    // Read and write errors count anyway.
    await mcp.call('get_issue', { identifier: 'ORB-404' });
    await mcp.call('create_issues', { requestId: 'req-fail-0001', issues: [{ team: 'XYZ', title: 'x' }] });
    expect(await rateCount(t, agentId)).toBe(3);
    // Minute window full → rate_limited
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('rateWindows')
        .withIndex('by_agent_window', (q) => q.eq('agentId', agentId).eq('window', minuteWindow(Date.now())))
        .unique();
      await ctx.db.patch('rateWindows', row!._id, { count: RATE_PER_MINUTE });
    });
    const limited = await mcp.call('list_teams');
    expect(limited.error).toMatch(/rate_limited/);
    // Revoked → 401
    await owner.mutation(api.agents.revoke, { agentId });
    expect((await mcp.rpc('tools/list')).status).toBe(401);
  });

  test('statuses per team: names and keys, list_statuses, filters, clear errors', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { key } = await agent(owner);
    const mcp = client(t, key);
    const testing = await t.run(async (ctx) =>
      ctx.db.insert('workflowStates', { teamId: f.orb, name: 'Testing', type: 'started', position: 5, createdAt: 0, updatedAt: 0 }),
    );
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.nova);

    const statuses = (await mcp.call('list_statuses', { team: 'orb' })).value.teams[0];
    expect(statuses.team).toBe('ORB');
    expect(statuses.statuses.map((s: Json) => s.name)).toEqual([
      'Triage',
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Testing',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
    expect(statuses.statuses.find((s: Json) => s.name === 'Testing')).toEqual({ name: 'Testing', type: 'started', key: 'in_progress' });
    expect(statuses.statuses.find((s: Json) => s.name === 'Backlog')).toMatchObject({ default: true });

    // Name (case-insensitive) in the issue's own team.
    const byName = await mcp.call('set_status', { identifiers: ['ORB-1'], status: 'testing' });
    expect(byName.ok, byName.error).toBe(true);
    expect(byName.value.issues[0]).toMatchObject({ status: 'Testing', statusType: 'started' });
    expect((await getIssue(t, a.id)).stateId).toBe(testing);

    // Unknown name: error listing the valid names, nothing changed.
    const unknown = await mcp.call('set_status', { identifiers: ['ORB-1', 'NOVA-1'], status: 'Testing' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown status "Testing" for team NOVA\. Valid: "Triage", "Backlog", "Todo", "In Progress"/);
    expect((await getIssue(t, b.id)).status).toBe('backlog');

    // Key across teams: the matching status per team.
    const byKey = await mcp.call('set_status', { identifiers: ['ORB-1', 'NOVA-1'], status: 'in_review' });
    expect(byKey.value.issues.map((i: Json) => i.status)).toEqual(['In Review', 'In Review']);
    expect(byKey.value.changed).toBe(2);

    // Filter by name, key and type.
    const named = await mcp.call('list_issues', { status: ['in review'] });
    expect(named.value.issues.map((i: Json) => i.identifier).sort()).toEqual(['NOVA-1', 'ORB-1']);
    expect((await mcp.call('list_issues', { status: ['started'], team: 'NOVA' })).value.count).toBe(1);
    expect((await mcp.call('list_issues', { status: ['Testing'] })).value.count).toBe(0);
    expect((await mcp.call('list_issues', { status: ['Finished'] })).error).toMatch(/Unknown status "Finished"/);

    // Compare-and-set with names.
    const cas = await mcp.call('update_issue', { identifier: 'ORB-1', status: 'Done', expected: { status: 'In Progress' } });
    expect(cas.value.conflicts).toEqual([{ field: 'status', expected: 'In Progress', actual: 'In Review' }]);
    const ok = await mcp.call('update_issue', { identifier: 'ORB-1', status: 'Done', expected: { status: 'in review' } });
    expect(ok.value.changed).toEqual(['status']);

    // History shows names.
    const issue = (await mcp.call('get_issue', { identifier: 'ORB-1' })).value;
    expect(issue.recentHistory.filter((h: Json) => h.field === 'status').map((h: Json) => [h.from, h.to])).toEqual([
      ['In Review', 'Done'],
      ['Testing', 'In Review'],
      ['Backlog', 'Testing'],
    ]);
    expect(await historyOf(t, a.id)).toBeDefined();
  });

  test('strict order: the agent gets invalid_transition with allowed targets, get_issue shows allowedStatuses', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { key } = await agent(owner);
    const mcp = client(t, key);
    const states = await t.run(async (ctx) => ctx.db.query('workflowStates').withIndex('by_team', (q) => q.eq('teamId', f.orb)).collect());
    const id = (name: string) => states.find((s) => s.name === name)!._id;
    await owner.mutation(api.workflowStates.setWorkflow, { teamId: f.orb, strict: true, exceptions: [{ from: id('In Review'), to: id('In Progress') }] });
    await createOne(owner, f.orb, { status: 'todo' });

    const denied = await mcp.call('set_status', { identifiers: ['ORB-1'], status: 'done' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(
      /^invalid_transition: ORB-1: status "Todo" → "Done" is not allowed \(team ORB requires the workflow order\)\. Allowed: "In Progress", "Canceled", "Duplicate"\./,
    );
    expect(denied.error).toContain('"allowed":["In Progress","Canceled","Duplicate"]');
    const issue = (await mcp.call('get_issue', { identifier: 'ORB-1' })).value;
    expect(issue.allowedStatuses).toEqual(['In Progress', 'Canceled', 'Duplicate']);
    expect((await mcp.call('set_status', { identifiers: ['ORB-1'], status: 'in progress' })).ok).toBe(true);
    const listed = (await mcp.call('list_statuses', { team: 'ORB' })).value.teams[0];
    expect(listed).toMatchObject({ strictOrder: true, exceptions: [{ from: 'In Review', to: 'In Progress' }] });
    // Agent issues start in triage (allowed); directly in "In Progress" is not.
    const created = await mcp.call('create_issues', { requestId: 'req-strict-0001', issues: [{ team: 'ORB', title: 'New', status: 'In Progress' }] });
    expect(created.error).toMatch(/^invalid_transition: New issues in team ORB cannot start in "In Progress"/);
  });
});

describe('MCP: knowledge', () => {
  test('create, search, read, replace with version, append, sources; permissions and errors', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { key, agentId } = await agent(owner);
    const mcp = client(t, key);

    // Without a knowledge area: a clear message.
    const off = await mcp.call('create_article', { requestId: 'wiki-0001', team: 'ORB', title: 'Note' });
    expect(off).toMatchObject({ ok: false });
    expect(off.error).toContain('no knowledge area');
    await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
    expect((await mcp.call('list_teams')).value.teams.find((x: Json) => x.key === 'ORB')).toMatchObject({ wiki: 'on' });

    const created = await mcp.call('create_article', {
      requestId: 'wiki-0002',
      team: 'orb',
      title: 'Electoral law',
      markdown: '# Electoral law\n\nThe five percent threshold applies nationwide.',
      project: 'orbit · search',
      topics: ['Elections', 'Law'],
      sources: [{ url: 'https://example.org/election', title: 'Test source', publishedAt: '2025-02' }],
    });
    expect(created).toMatchObject({ ok: true, value: { title: 'Electoral law', team: 'ORB', version: 1, createdTopics: ['Elections', 'Law'] } });
    const id = created.value.id as string;
    // Retry with the same requestId: the same page.
    expect((await mcp.call('create_article', {
      requestId: 'wiki-0002',
      team: 'orb',
      title: 'Electoral law',
      markdown: '# Electoral law\n\nThe five percent threshold applies nationwide.',
      project: 'orbit · search',
      topics: ['Elections', 'Law'],
      sources: [{ url: 'https://example.org/election', title: 'Test source', publishedAt: '2025-02' }],
    })).value.id).toBe(id);
    const child = await mcp.call('create_article', { requestId: 'wiki-0003', team: 'ORB', title: 'Blocking clause', parent: id, topics: ['elections'] });
    expect(child.value.createdTopics).toBeUndefined();

    const found = await mcp.call('search_articles', { q: 'nationwide' });
    expect(found.value).toMatchObject({ count: 1, articles: [{ id, title: 'Electoral law', team: 'ORB', match: 'text' }] });
    expect((await mcp.call('search_articles', { q: 'blocking', team: 'ORB' })).value.articles[0]).toMatchObject({ title: 'Blocking clause', path: ['Electoral law'], match: 'title' });

    const list = await mcp.call('list_articles', { team: 'ORB', topic: 'Elections' });
    expect(list.value.articles.map((a: Json) => [a.title, a.parent])).toEqual([
      ['Electoral law', null],
      ['Blocking clause', id],
    ]);
    expect(list.value.topics.map((x: Json) => x.name).sort()).toEqual(['Elections', 'Law']);
    expect((await mcp.call('list_articles', { team: 'ORB', topic: 'Unknown' })).ok).toBe(false);

    const page = await mcp.call('get_article', { id });
    expect(page.value).toMatchObject({
      title: 'Electoral law',
      team: 'ORB',
      project: 'Orbit · Search',
      version: 1,
      sources: [{ url: 'https://example.org/election', title: 'Test source', publishedAt: '2025-02' }],
      children: [{ title: 'Blocking clause' }],
      createdBy: 'Claude Code (agent)',
    });
    expect(page.value.topics.sort()).toEqual(['Elections', 'Law']);

    // Replacing needs the version; a stale version writes nothing.
    expect((await mcp.call('update_article', { requestId: 'wiki-0004', id, markdown: 'New' })).error).toContain('expectedVersion');
    const replaced = await mcp.call('update_article', { requestId: 'wiki-0005', id, markdown: 'New state.', expectedVersion: 1, title: 'Electoral law (current)' });
    expect(replaced.value).toMatchObject({ changed: ['title', 'markdown'], version: 2 });
    const stale = await mcp.call('update_article', { requestId: 'wiki-0006', id, markdown: 'Old', expectedVersion: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain('changed since version 1');
    const appended = await mcp.call('update_article', { requestId: 'wiki-0007', id, append: 'Addendum from the agent.', addSources: [{ title: 'Book without URL' }] });
    expect(appended.value).toMatchObject({ changed: ['append', 'sources'], version: 3 });
    const after = (await mcp.call('get_article', { id })).value;
    expect(after.markdown).toBe('New state.\n\nAddendum from the agent.\n');
    expect(after.sources).toHaveLength(2);
    // Earlier versions stay available to the owner (an agent write → a revision).
    const revisions = await owner.query(api.wiki.revisions, { articleId: id as Id<'articles'> });
    expect(revisions.revisions.map((r) => r.preview)).toEqual(['New state.', '# Electoral law\n\nThe five percent threshold applies nationwide.']);

    // Move to the top level, remove the project.
    const moved = await mcp.call('update_article', { requestId: 'wiki-0008', id: child.value.id, parent: null, project: null });
    expect(moved.value.changed).toEqual(['parent']);
    expect((await mcp.call('get_article', { id: child.value.id })).value.path).toEqual([]);

    // Invalid input.
    expect((await mcp.call('get_article', { id: 'broken' })).ok).toBe(false);
    expect((await mcp.call('create_article', { requestId: 'wiki-0009', team: 'ORB', title: 'Q', sources: [{ author: 'Author only' }] })).error).toContain('url or a title');
    expect((await mcp.call('update_article', { requestId: 'wiki-0010', id })).error).toContain('nothing to change');
    expect(await rateCount(t, agentId)).toBeGreaterThan(10);
  });

  test('list_inbox: agent changes as entries, grouped per issue; reviewedBySteven follows the entry', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id, identifier } = await createOne(owner, f.orb, { title: 'Mine' });
    const { key } = await agent(owner, 'Aleister');
    const mcp = client(t, key);
    expect((await mcp.call('list_inbox')).value).toEqual({ count: 0, unread: 0, entries: [] });
    expect((await mcp.call('get_issue', { identifier })).value.reviewedBySteven).toBe(true);

    expect((await mcp.call('set_status', { requestId: 'inbox-0001', identifiers: [identifier], status: 'done' })).ok).toBe(true);
    await mcp.call('add_comment', { requestId: 'inbox-0002', identifier, body: 'Merged.' });
    const inbox = (await mcp.call('list_inbox')).value;
    expect(inbox).toMatchObject({ count: 1, unread: 1 });
    expect(inbox.entries[0]).toMatchObject({ identifier, title: 'Mine', kind: 'changed', unread: true });
    expect(inbox.entries[0].changes.map((c: Json) => [c.field, c.by])).toEqual([
      ['comment', 'Aleister (agent)'],
      ['status', 'Aleister (agent)'],
    ]);
    expect(inbox.entries[0].changes.find((c: Json) => c.field === 'status').to).toBe('Done');
    expect((await mcp.call('get_issue', { identifier })).value.reviewedBySteven).toBe(false);

    // The owner reads it: no longer unread; removing it empties the list again.
    await owner.mutation(api.issues.markRead, { ids: [id], read: true });
    expect((await mcp.call('list_inbox', { unreadOnly: true })).value).toMatchObject({ count: 0, unread: 0 });
    expect((await mcp.call('list_inbox')).value).toMatchObject({ count: 1, unread: 0 });
    expect((await mcp.call('get_issue', { identifier })).value.reviewedBySteven).toBe(true);
    await owner.mutation(api.issues.markReviewed, { ids: [id] });
    expect((await mcp.call('list_inbox')).value.entries).toEqual([]);
  });
});
