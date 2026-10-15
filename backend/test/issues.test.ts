import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Actor } from '../convex/lib/actor';
import { DAY_MS } from '../convex/lib/dates';
import { createIssues, purgeTrash, updateIssues } from '../convex/ops/issues';
import { addComment, editComment } from '../convex/ops/comments';
import { BUCKET_SIZE, OWNER_KIND } from '../convex/shared/constants';
import { createOne, expectCode, fixture, getIssue, historyOf, setup, stateId, type T } from './helpers';

async function makeAgent(t: T, name = 'Agent'): Promise<Actor> {
  const agentId = await t.run(
    async (ctx) => await ctx.db.insert('agents', { name, keyHash: 'a'.repeat(64), keyPrefix: 'selfbound_aaaaa', createdAt: Date.now() }),
  );
  return { kind: 'agent', agentId };
}

describe('Create issues', () => {
  test('assigns identifier, seq, bucket, rank, description and exactly one created row', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const result = await owner.mutation(api.issues.create, {
      issues: [
        { teamId: f.orb, title: '  First   issue ', description: '## Goal\n\nText', labelIds: [f.bug, f.design], projectId: f.orbProject },
        { teamId: f.nova, title: 'Second', status: 'triage', priority: 2, estimate: 3, dueDate: '2026-10-20' },
        { teamId: f.orb, title: 'Third', status: 'in_progress' },
      ],
    });
    expect(result.issues.map((i) => i.identifier)).toEqual(['ORB-1', 'NOVA-1', 'ORB-2']);
    expect(result.warnings).toEqual([]);
    const [a, b, c] = await Promise.all(result.issues.map((i) => getIssue(t, i.id)));
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(a.bucket).toBe(0);
    expect(a.title).toBe('First issue');
    expect(a.status).toBe('backlog');
    expect(b.status).toBe('triage');
    expect(c.startedAt).toBeDefined();
    expect(a.rank < b.rank && b.rank < c.rank).toBe(true);
    expect(a.createdBy).toEqual({ kind: OWNER_KIND });
    expect(a.reviewedAt).toBeDefined();
    for (const issue of [a, b, c]) {
      const rows = await historyOf(t, issue._id);
      expect(rows).toHaveLength(1);
      expect(rows[0].field).toBe('created');
      expect(rows[0].actor).toEqual({ kind: OWNER_KIND });
    }
    const detail = await owner.query(api.issues.detail, { id: a._id });
    expect(detail?.body).toMatchObject({ markdown: '## Goal\n\nText', version: 1 });
    expect(await owner.query(api.meta.counter, {})).toEqual({ maxSeq: 2 });
  });

  test('batch of 50 and parallel calls without duplicate numbers or seq', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const batch = await owner.mutation(api.issues.create, {
      issues: Array.from({ length: 50 }, (_, i) => ({ teamId: i % 2 ? f.orb : f.nova, title: `Batch ${i}` })),
    });
    expect(batch.issues).toHaveLength(50);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: `Parallel ${i}` }, { teamId: f.nova, title: `P ${i}` }] }),
      ),
    );
    const all = await t.run(async (ctx) => await ctx.db.query('issues').collect());
    expect(all).toHaveLength(74);
    expect(new Set(all.map((i) => i.seq)).size).toBe(74);
    expect(Math.max(...all.map((i) => i.seq))).toBe(73);
    for (const teamId of [f.orb, f.nova]) {
      const numbers = all.filter((i) => i.teamId === teamId).map((i) => i.number).sort((x, y) => x - y);
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
    }
    expect(all.every((i) => i.bucket === Math.floor(i.seq / BUCKET_SIZE))).toBe(true);
    expect(new Set(all.map((i) => i.rank)).size).toBe(74);
    await expectCode(
      owner.mutation(api.issues.create, { issues: Array.from({ length: 51 }, () => ({ teamId: f.orb, title: 'too many' })) }),
      'invalid',
    );
    await expectCode(owner.mutation(api.issues.create, { issues: [] }), 'invalid');
  });

  test('validates labels (single choice, team), project, parent, title and date', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await expectCode(createOne(owner, f.orb, { labelIds: [f.bug, f.feature] }), 'invalid');
    await expectCode(createOne(owner, f.nova, { labelIds: [f.orbOnly] }), 'invalid');
    await expectCode(createOne(owner, f.orb, { projectId: f.novaProject }), 'invalid');
    await expectCode(createOne(owner, f.orb, { title: '   ' }), 'invalid');
    await expectCode(createOne(owner, f.orb, { dueDate: '2026-02-30' }), 'invalid');
    await expectCode(createOne(owner, f.orb, { estimate: -1 }), 'invalid');
    // Non-exclusive group: several allowed, duplicates are merged.
    const ok = await createOne(owner, f.orb, { labelIds: [f.design, f.docs, f.design, f.bug] });
    const parent = await createOne(owner, f.nova, { parentId: ok.id });
    expect(parent.identifier).toBe('NOVA-1');
  });

  test('agent: actor in history, inbox entry; markReviewed removes the entry with history', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const result = await t.run(
      async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'From the agent', status: 'triage' }] }),
    );
    const issue = await getIssue(t, result.issues[0].id);
    expect(issue.createdBy).toEqual(agent);
    expect(issue.reviewedAt).toBeUndefined();
    expect((await historyOf(t, issue._id))[0].actor).toEqual(agent);
    expect(await owner.query(api.inbox.list, {})).toMatchObject([{ issueId: issue._id, kind: 'created', actor: agent, changes: [] }]);
    expect(await owner.mutation(api.issues.markReviewed, { ids: [issue._id] })).toEqual({ reviewed: 1 });
    expect(await owner.mutation(api.issues.markReviewed, { ids: [issue._id] })).toEqual({ reviewed: 0 });
    expect(await owner.query(api.inbox.list, {})).toEqual([]);
    const rows = await historyOf(t, issue._id);
    expect(rows.map((r) => r.field)).toEqual(['created', 'reviewed']);
    expect(rows[1].actor).toEqual({ kind: OWNER_KIND });
    // Undo: back in the inbox, with history; a second call changes nothing.
    expect(await owner.mutation(api.issues.markUnreviewed, { ids: [issue._id] })).toEqual({ unreviewed: 1 });
    expect(await owner.mutation(api.issues.markUnreviewed, { ids: [issue._id] })).toEqual({ unreviewed: 0 });
    expect(await owner.query(api.inbox.list, {})).toHaveLength(1);
    expect((await historyOf(t, issue._id)).map((r) => r.field)).toEqual(['created', 'reviewed', 'unreviewed']);
  });

  test('inbox: dismissing and reading only touch the entry, the issue stays unchanged', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const result = await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'From the agent', status: 'todo' }] }));
    const before = await getIssue(t, result.issues[0].id);
    expect((await owner.query(api.inbox.list, {}))[0].readAt).toBeUndefined();
    expect(await owner.mutation(api.issues.markRead, { ids: [before._id], read: true })).toEqual({ changed: 1 });
    expect(await owner.mutation(api.issues.markRead, { ids: [before._id], read: true })).toEqual({ changed: 0 });
    expect((await owner.query(api.inbox.list, {}))[0].readAt).toBeDefined();
    expect(await owner.mutation(api.issues.markReviewed, { ids: [before._id] })).toEqual({ reviewed: 1 });
    // The issue document is exactly as before: status, title, updatedAt, markers.
    expect(await getIssue(t, before._id)).toEqual(before);
    expect((await historyOf(t, before._id)).map((r) => r.field)).toEqual(['created', 'reviewed']);
    // Reading something that is no longer in the inbox changes nothing.
    expect(await owner.mutation(api.issues.markRead, { ids: [before._id], read: false })).toEqual({ changed: 0 });
  });
});

describe('Update issues', () => {
  test('writes only changed fields, with history and timestamps', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { labelIds: [f.design, f.docs], projectId: f.orbProject });
    const before = await getIssue(t, id);
    // Same labels in a different order, same status: no change.
    const same = await owner.mutation(api.issues.update, { ids: [id], patch: { labelIds: [f.docs, f.design], status: 'backlog' } });
    expect(same.changed).toBe(0);
    expect((await getIssue(t, id)).updatedAt).toBe(before.updatedAt);
    expect(await historyOf(t, id)).toHaveLength(1);

    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'in_progress', priority: 3, projectId: null, estimate: 5 } });
    let issue = await getIssue(t, id);
    expect(issue.status).toBe('in_progress');
    expect(issue.startedAt).toBeDefined();
    expect(issue.projectId).toBeUndefined();
    expect(issue.estimate).toBe(5);
    const fields = (await historyOf(t, id)).map((r) => r.field).sort();
    expect(fields).toEqual(['created', 'estimate', 'priority', 'projectId', 'stateId']);
    expect(issue.stateId).toBe(await stateId(t, f.orb, 'in_progress'));

    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'done' } });
    issue = await getIssue(t, id);
    expect(issue.completedAt).toBeDefined();
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'canceled' } });
    issue = await getIssue(t, id);
    expect(issue.completedAt).toBeUndefined();
    expect(issue.canceledAt).toBeDefined();
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'todo' } });
    issue = await getIssue(t, id);
    expect([issue.startedAt, issue.completedAt, issue.canceledAt]).toEqual([undefined, undefined, undefined]);
  });

  test('compare-and-set: differing value → conflict, label arrays compared as sets', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { labelIds: [f.design, f.docs], priority: 3 });
    const b = await createOne(owner, f.orb, { priority: 4 });
    // Matches (labels in a different order): written.
    await owner.mutation(api.issues.update, {
      ids: [a.id, b.id],
      patch: { priority: 1 },
      expect: [{ labelIds: [f.docs, f.design], priority: 3 }, { priority: 4 }],
    });
    expect((await getIssue(t, a.id)).priority).toBe(1);
    // An agent changed the labels in the meantime → conflict, nothing written.
    await t.run(async (ctx) => await updateIssues(ctx, { kind: 'system' }, { ids: [a.id], patch: { labelIds: [f.bug] } }));
    const data = await expectCode(
      owner.mutation(api.issues.update, { ids: [a.id, b.id], patch: { priority: 2 }, expect: [{ labelIds: [f.design, f.docs] }, {}] }),
      'conflict',
    );
    expect(data).toMatchObject({ identifier: 'ORB-1', field: 'labelIds' });
    expect((await getIssue(t, b.id)).priority).toBe(1);
    // null expects "not set".
    await owner.mutation(api.issues.update, { ids: [b.id], patch: { estimate: 2 }, expect: [{ estimate: null }] });
    await expectCode(owner.mutation(api.issues.update, { ids: [b.id], patch: { estimate: 3 }, expect: [{ estimate: null }] }), 'conflict');
    await expectCode(owner.mutation(api.issues.update, { ids: [a.id, b.id], patch: { priority: 2 }, expect: [{}] }), 'invalid');
    await expectCode(owner.mutation(api.issues.update, { ids: [a.id, a.id], patch: { priority: 2 } }), 'invalid');
  });

  test('revert only resets while the value still matches', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { priority: 3 });
    await owner.mutation(api.issues.update, { ids: [id], patch: { priority: 1, status: 'todo' } });
    await owner.mutation(api.issues.revert, { items: [{ id, patch: { priority: 3 }, expect: { priority: 1 } }] });
    expect((await getIssue(t, id)).priority).toBe(3);
    await expectCode(
      owner.mutation(api.issues.revert, { items: [{ id, patch: { status: 'backlog' }, expect: { status: 'in_review' } }] }),
      'conflict',
    );
    expect((await getIssue(t, id)).status).toBe('todo');
  });

  test('parent: no self reference, no cycle', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.orb, { parentId: a.id });
    const c = await createOne(owner, f.orb, { parentId: b.id });
    await expectCode(owner.mutation(api.issues.update, { ids: [a.id], patch: { parentId: a.id } }), 'invalid');
    await expectCode(owner.mutation(api.issues.update, { ids: [a.id], patch: { parentId: c.id } }), 'invalid');
    await owner.mutation(api.issues.update, { ids: [c.id], patch: { parentId: null } });
    await owner.mutation(api.issues.update, { ids: [a.id], patch: { parentId: c.id } });
  });

  test('priority budget: warning on the 2nd urgent and 4th high per team, no error', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    expect((await owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'U1', priority: 1 }] })).warnings).toEqual([]);
    const second = await owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'U2', priority: 1 }] });
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toMatchObject({ code: 'budget_warning', priority: 1, open: 2, budget: 1, teamId: f.orb });
    // Another team is independent.
    expect((await owner.mutation(api.issues.create, { issues: [{ teamId: f.nova, title: 'U', priority: 1 }] })).warnings).toEqual([]);
    const highs = await owner.mutation(api.issues.create, {
      issues: [1, 2, 3].map((n) => ({ teamId: f.nova, title: `H${n}`, priority: 2 as const })),
    });
    expect(highs.warnings).toEqual([]);
    const { id } = await createOne(owner, f.nova, { priority: 4 });
    const update = await owner.mutation(api.issues.update, { ids: [id], patch: { priority: 2 } });
    expect(update.warnings).toMatchObject([{ priority: 2, open: 4, budget: 3 }]);
    // Done issues do not count.
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'done' } });
    expect((await owner.mutation(api.issues.update, { ids: [id], patch: { priority: 2 } })).warnings).toEqual([]);
  });

  test('reorder: new rank between the neighbours', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const res = await owner.mutation(api.issues.create, { issues: ['A', 'B', 'C', 'D'].map((title) => ({ teamId: f.orb, title })) });
    const [a, b, c, d] = res.issues.map((i) => i.id);
    const order = async () => {
      const issues = await t.run(async (ctx) => await ctx.db.query('issues').withIndex('by_rank').collect());
      return issues.map((i) => i.title).join('');
    };
    await owner.mutation(api.issues.reorder, { id: d, beforeId: a, afterId: b });
    expect(await order()).toBe('ADBC');
    await owner.mutation(api.issues.reorder, { id: a, afterId: c });
    expect(await order()).toBe('DBAC');
    await owner.mutation(api.issues.reorder, { id: d, beforeId: c });
    expect(await order()).toBe('BACD');
    // Neighbours in the wrong order (stale client): lands right after `before`.
    await owner.mutation(api.issues.reorder, { id: b, beforeId: c, afterId: a });
    expect(await order()).toBe('ACBD');
    await expectCode(owner.mutation(api.issues.reorder, { id: b }), 'invalid');
    const rows = (await historyOf(t, b)).filter((r) => r.field === 'rank');
    expect(rows).toHaveLength(1);
  });
});

describe('Idempotency', () => {
  test('same requestId and arguments → same result; different arguments → error', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const args = { issues: [{ teamId: f.orb, title: 'Once' }], requestId: 'req-1' };
    const first = await owner.mutation(api.issues.create, args);
    const second = await owner.mutation(api.issues.create, args);
    expect(second).toEqual(first);
    expect(await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)).toBe(1);
    const data = await expectCode(
      owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'Different' }], requestId: 'req-1' }),
      'invalid',
    );
    expect(String(data.message)).toContain('requestId');
    // A different operation with the same ID is an error too.
    await expectCode(owner.mutation(api.issues.update, { ids: [first.issues[0].id], patch: { priority: 1 }, requestId: 'req-1' }), 'invalid');
    // An agent has its own namespace.
    const agent = await makeAgent(t);
    const agentResult = await t.run(async (ctx) => await createIssues(ctx, agent, args));
    expect(agentResult.issues[0].identifier).toBe('ORB-2');
    // History carries the request ID.
    expect((await historyOf(t, first.issues[0].id))[0].requestId).toBe('req-1');
  });

  test('a failed call stores nothing, a retry runs again', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await expectCode(owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: '' }], requestId: 'r' }), 'invalid');
    expect(await t.run(async (ctx) => (await ctx.db.query('requests').collect()).length)).toBe(0);
    const ok = await owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'x' }], requestId: 'r2' });
    expect(ok.issues[0].identifier).toBe('ORB-1');
  });
});

describe('Description', () => {
  test('version, conflict with the current state, history with preview only', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { description: 'old' });
    const long = 'x'.repeat(500);
    expect(await owner.mutation(api.issues.setDescription, { id, markdown: long, baseVersion: 1 })).toEqual({ version: 2, changed: true });
    const conflict = await expectCode(owner.mutation(api.issues.setDescription, { id, markdown: 'too late', baseVersion: 1 }), 'conflict');
    expect(conflict).toMatchObject({ version: 2, updatedBy: { kind: OWNER_KIND } });
    expect(typeof conflict.updatedAt).toBe('number');
    expect(await owner.mutation(api.issues.setDescription, { id, markdown: long, baseVersion: 2 })).toEqual({ version: 2, changed: false });
    const row = (await historyOf(t, id)).find((r) => r.field === 'description')!;
    expect(row.from).toEqual({ version: 1 });
    expect(row.to).toEqual({ version: 2, preview: 'x'.repeat(120) });
    const detail = await owner.query(api.issues.detail, { id });
    expect(detail?.body.markdown).toBe(long);
  });
});

describe('Trash', () => {
  test('remove, restore, purge after 30 days including dependents', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.orb);
    const child = await createOne(owner, f.orb, { parentId: a.id });
    await owner.mutation(api.comments.add, { issueId: a.id, body: 'Comment' });
    await owner.mutation(api.relations.add, { fromId: a.id, toId: b.id, type: 'blocks' });
    const { id: sprintId } = await owner.mutation(api.sprints.create, {});
    await owner.mutation(api.sprints.add, { sprintId, issueIds: [a.id] });
    await t.run(async (ctx) => {
      await ctx.db.insert('identifierAliases', { key: 'OLD-1', issueId: a.id });
    });

    expect(await owner.mutation(api.issues.remove, { ids: [a.id] })).toMatchObject({ removed: 1 });
    let issue = await getIssue(t, a.id);
    expect(issue.deletedAt).toBeDefined();
    expect(issue.sprintId).toBeUndefined();
    // Stays in the bucket (the client filters).
    expect((await owner.query(api.issues.bucket, { bucket: 0 })).map((i) => i._id)).toContain(a.id);
    await expectCode(owner.mutation(api.issues.update, { ids: [a.id], patch: { priority: 1 } }), 'invalid');
    await owner.mutation(api.issues.restore, { ids: [a.id] });
    issue = await getIssue(t, a.id);
    expect(issue.deletedAt).toBeUndefined();
    expect((await historyOf(t, a.id)).map((r) => r.field)).toContain('restored');

    await owner.mutation(api.issues.remove, { ids: [a.id] });
    // Nothing happens before expiry.
    expect(await t.run(async (ctx) => await purgeTrash(ctx, Date.now() + 29 * DAY_MS))).toEqual({ purged: 0, more: false });
    expect(await t.run(async (ctx) => await purgeTrash(ctx, Date.now() + 31 * DAY_MS))).toEqual({ purged: 1, more: false });
    const left = await t.run(async (ctx) => ({
      issue: await ctx.db.get('issues', a.id),
      bodies: (await ctx.db.query('issueBodies').collect()).filter((x) => x.issueId === a.id).length,
      comments: (await ctx.db.query('comments').collect()).length,
      relations: (await ctx.db.query('relations').collect()).length,
      items: (await ctx.db.query('sprintItems').collect()).filter((x) => x.issueId === a.id).length,
      aliases: (await ctx.db.query('identifierAliases').collect()).length,
      history: (await ctx.db.query('history').collect()).filter((x) => x.issueId === a.id).length,
      child: await ctx.db.get('issues', child.id),
    }));
    expect(left).toMatchObject({ issue: null, bodies: 0, comments: 0, relations: 0, items: 0, aliases: 0, history: 0 });
    expect(left.child?.parentId).toBeUndefined();
    expect(await owner.query(api.issues.detail, { id: a.id })).toBeNull();
  });
});

describe('Relations and comments', () => {
  test('relations: no self reference, no duplicates, both directions, duplicate sets status', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.nova);
    await expectCode(owner.mutation(api.relations.add, { fromId: a.id, toId: a.id, type: 'related' }), 'invalid');
    const { relationId } = await owner.mutation(api.relations.add, { fromId: a.id, toId: b.id, type: 'related' });
    await expectCode(owner.mutation(api.relations.add, { fromId: b.id, toId: a.id, type: 'related' }), 'invalid');
    await owner.mutation(api.relations.add, { fromId: a.id, toId: b.id, type: 'duplicate', markDuplicate: true });
    expect((await getIssue(t, a.id)).status).toBe('duplicate');
    expect((await getIssue(t, a.id)).canceledAt).toBeDefined();
    const detailB = await owner.query(api.issues.detail, { id: b.id });
    expect(detailB?.relations.map((r) => [r.type, r.direction, r.other.identifier])).toEqual([
      ['related', 'in', 'ORB-1'],
      ['duplicate', 'in', 'ORB-1'],
    ]);
    await owner.mutation(api.relations.remove, { relationId });
    expect((await owner.query(api.issues.detail, { id: a.id }))?.relations).toHaveLength(1);
    const fields = (await historyOf(t, b.id)).map((r) => r.field);
    expect(fields).toEqual(['created', 'relation', 'relation', 'relation_removed']);
  });

  test('comments: add, edit, remove; an agent may only change its own', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb);
    const { commentId } = await owner.mutation(api.comments.add, { issueId: id, body: ' Hello ' });
    await owner.mutation(api.comments.edit, { commentId, body: 'Hello world' });
    const agent = await makeAgent(t);
    await expectCode(t.run(async (ctx) => await editComment(ctx, agent, { commentId, body: 'hijacked' })), 'access_denied');
    const own = await t.run(async (ctx) => await addComment(ctx, agent, { issueId: id, body: 'from the agent' }));
    await t.run(async (ctx) => await editComment(ctx, agent, { commentId: own.commentId, body: 'from the agent, corrected' }));
    await owner.mutation(api.comments.remove, { commentId });
    const detail = await owner.query(api.issues.detail, { id });
    expect(detail?.comments.map((c) => c.body)).toEqual(['from the agent, corrected']);
    expect(detail?.comments[0].editedAt).toBeDefined();
    const rows = await historyOf(t, id);
    expect(rows.map((r) => [r.field, r.actor.kind])).toEqual([
      ['created', OWNER_KIND],
      ['comment', OWNER_KIND],
      ['comment_edited', OWNER_KIND],
      ['comment', 'agent'],
      ['comment_edited', 'agent'],
      ['comment_removed', OWNER_KIND],
    ]);
  });
});

describe('Read', () => {
  test('head: highest seq and the two newest buckets (start without waiting for meta.counter)', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    expect(await owner.query(api.issues.head, {})).toEqual({ maxSeq: -1, buckets: [] });
    for (let i = 0; i < 2; i++) await owner.mutation(api.issues.create, { issues: Array.from({ length: 50 }, (_, j) => ({ teamId: f.orb, title: `Issue ${i}-${j}` })) });
    const head = await owner.query(api.issues.head, {});
    expect(head.maxSeq).toBe(99);
    expect(head.buckets.map((b) => [b.bucket, b.docs.length])).toEqual([
      [1, 100 - BUCKET_SIZE],
      [0, BUCKET_SIZE],
    ]);
    const bucket1 = await owner.query(api.issues.bucket, { bucket: 1 });
    expect(head.buckets[0].docs.map((d) => d._id)).toEqual(bucket1.map((d) => d._id));
  });

  test('search across title, description and comments; resolve identifiers', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { title: 'Speed up the indexer' });
    const b = await createOne(owner, f.nova, { title: 'Something else', description: 'The indexer is slow.' });
    const c = await createOne(owner, f.nova, { title: 'One more thing' });
    await owner.mutation(api.comments.add, { issueId: c.id, body: 'Blocked on the indexer' });
    const hits = await owner.query(api.issues.search, { q: 'indexer' });
    expect(hits.map((h) => [h.identifier, h.match])).toEqual([
      ['ORB-1', 'title'],
      ['NOVA-1', 'description'],
      ['NOVA-2', 'comment'],
    ]);
    await owner.mutation(api.issues.remove, { ids: [b.id] });
    expect((await owner.query(api.issues.search, { q: 'indexer' })).map((h) => h.identifier)).toEqual(['ORB-1', 'NOVA-2']);
    expect(await owner.query(api.issues.search, { q: '  ' })).toEqual([]);

    expect(await owner.query(api.issues.resolve, { identifier: 'orb-1' })).toEqual({ id: a.id, identifier: 'ORB-1' });
    expect(await owner.query(api.issues.resolve, { identifier: 'NOVA2' })).toEqual({ id: c.id, identifier: 'NOVA-2' });
    await t.run(async (ctx) => {
      await ctx.db.insert('identifierAliases', { key: 'ALT-7', issueId: c.id });
    });
    expect(await owner.query(api.issues.resolve, { identifier: 'alt-7' })).toEqual({ id: c.id, identifier: 'NOVA-2' });
    expect(await owner.query(api.issues.resolve, { identifier: a.id })).toEqual({ id: a.id, identifier: 'ORB-1' });
    expect(await owner.query(api.issues.resolve, { identifier: 'XYZ-9' })).toBeNull();
  });

  test('multi-word search: description and comment with all words despite many fuzzy title hits', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    // 30 titles with only ONE of the words: the search index returns them all (OR semantics).
    await owner.mutation(api.issues.create, {
      issues: Array.from({ length: 30 }, (_, n) => ({ teamId: f.orb, title: `Error when saving ${n}` })),
    });
    const body = await createOne(owner, f.nova, { title: 'List stutters', description: 'There is a spike when first opening the list.' });
    const talk = await createOne(owner, f.nova, { title: 'Measurement' });
    await owner.mutation(api.comments.add, { issueId: talk.id, body: 'I see the spike when first opening it too.' });
    const hits = await owner.query(api.issues.search, { q: 'spike when first opening', limit: 20 });
    expect(hits.length).toBe(20);
    expect(hits.slice(0, 2).map((h) => [h.id, h.match])).toEqual([
      [body.id, 'description'],
      [talk.id, 'comment'],
    ]);
    expect(hits[0].snippet).toContain('spike when first opening');
    // Single word as before: title first.
    const single = await owner.query(api.issues.search, { q: 'spike' });
    expect(single.map((h) => h.match)).toEqual(['description', 'comment']);
  });

  test('meta.get returns master data without the counter, meta.counter the highest seq', async () => {
    const { owner } = setup();
    expect(await owner.query(api.meta.counter, {})).toEqual({ maxSeq: -1 });
    const f = await fixture(owner);
    await createOne(owner, f.orb);
    const meta = await owner.query(api.meta.get, {});
    expect(meta.teams.map((team) => team.key)).toEqual(['ORB', 'NOVA']);
    expect(meta.teams[0].logoUrl).toBeNull();
    expect(meta.labels).toHaveLength(5);
    expect(meta.labelGroups.map((g) => [g.name, g.exclusive])).toEqual([
      ['Type', true],
      ['Area', false],
    ]);
    expect(meta.projects).toHaveLength(2);
    expect(meta.rejectWrites).toBe(false);
    expect(JSON.stringify(meta)).not.toContain('maxSeq');
    expect(await owner.query(api.meta.counter, {})).toEqual({ maxSeq: 0 });
  });
});

describe('Test switch rejectWrites', () => {
  test('only works with SELFBOUND_TEST_SWITCHES=1 and then rejects all UI writes', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await owner.mutation(api.admin.setRejectWrites, { value: true });
    expect((await owner.query(api.meta.get, {})).rejectWrites).toBe(true);
    await expectCode(createOne(owner, f.orb), 'rejected');
    await expectCode(owner.mutation(api.teams.create, { key: 'NEW', name: 'New' }), 'rejected');
    // Also write paths through actions (agent keys, logos).
    await expectCode(owner.action(api.agents.create, { name: 'New' }), 'rejected');
    await owner.mutation(api.admin.setRejectWrites, { value: false });
    await createOne(owner, f.orb);

    // Switch off: neither settable nor effective.
    await owner.mutation(api.admin.setRejectWrites, { value: true });
    process.env.SELFBOUND_TEST_SWITCHES = '0';
    await createOne(owner, f.orb);
    expect((await owner.query(api.meta.get, {})).rejectWrites).toBe(false);
    await expectCode(owner.mutation(api.admin.setRejectWrites, { value: false }), 'access_denied');
  });
});

export type { Id };
