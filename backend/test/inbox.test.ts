import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Actor } from '../convex/lib/actor';
import { DAY_MS } from '../convex/lib/dates';
import { addComment, removeComment } from '../convex/ops/comments';
import { cleanupEntries } from '../convex/ops/inbox';
import { INBOX_KEEP_DAYS } from '../convex/ops/inboxChanges';
import { createIssues, purgeIssue, updateIssues } from '../convex/ops/issues';
import { addRelation } from '../convex/ops/relations';
import { createOne, fixture, getIssue, historyOf, setup, stateId, type T } from './helpers';

// Inbox entries: agent changes to existing issues, grouping, the owner's own changes, undo,
// cleanup and the migration of the old markers.

async function makeAgent(t: T, name = 'Aleister'): Promise<Actor> {
  const agentId = await t.run(
    async (ctx) => await ctx.db.insert('agents', { name, keyHash: name.padEnd(64, 'a'), keyPrefix: 'xlr8_aaaaa', createdAt: Date.now() }),
  );
  return { kind: 'agent', agentId };
}

const entries = async (t: T) => await t.run(async (ctx) => await ctx.db.query('inboxEntries').collect());

describe('Agent changes to existing issues', () => {
  test('status and comment by an agent make one entry that names the agent and the changes', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const { id } = await createOne(owner, f.orb, { title: 'Mine' });
    expect(await owner.query(api.inbox.list, {})).toEqual([]);
    const done = await stateId(t, f.orb, 'done');
    await t.run(async (ctx) => {
      await updateIssues(ctx, agent, { ids: [id], patch: { stateId: done } });
      await addComment(ctx, agent, { issueId: id, body: 'All done, see the PR.' });
    });
    const list = await owner.query(api.inbox.list, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ issueId: id, kind: 'changed', actor: agent });
    // The priority row of a closing issue does not matter here (no priority was set).
    expect(list[0].changes.map((c) => c.field)).toEqual(['stateId', 'comment']);
    expect(list[0].changes[0]).toMatchObject({ value: done, actor: agent });
    expect(list[0].changes[1].value).toBe('All done, see the PR.');
    expect(list[0].readAt).toBeUndefined();
  });

  test('several changes to one issue stay one entry: latest value per field, moves up, unread again', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const other = await makeAgent(t, 'Claude Code');
    const a = await createOne(owner, f.orb, { title: 'A' });
    const b = await createOne(owner, f.orb, { title: 'B' });
    const todo = await stateId(t, f.orb, 'todo');
    const doing = await stateId(t, f.orb, 'in_progress');
    await t.run(async (ctx) => await updateIssues(ctx, agent, { ids: [a.id], patch: { stateId: todo, priority: 2 } }));
    await t.run(async (ctx) => await updateIssues(ctx, other, { ids: [b.id], patch: { title: 'B2' } }));
    expect((await owner.query(api.inbox.list, {})).map((e) => e.issueId)).toEqual([b.id, a.id]);
    await owner.mutation(api.issues.markRead, { ids: [a.id], read: true });
    // A again: same entry, the status replaced, the new field added; first in the list, unread.
    await t.run(async (ctx) => {
      await updateIssues(ctx, other, { ids: [a.id], patch: { stateId: doing } });
      await updateIssues(ctx, other, { ids: [a.id], patch: { dueDate: '2026-12-01' } });
    });
    const list = await owner.query(api.inbox.list, {});
    expect(list.map((e) => e.issueId)).toEqual([a.id, b.id]);
    expect(await entries(t)).toHaveLength(2);
    expect(list[0].actor).toEqual(other);
    expect(list[0].readAt).toBeUndefined();
    const byField = Object.fromEntries(list[0].changes.map((c) => [c.field, c]));
    expect(Object.keys(byField).sort()).toEqual(['dueDate', 'priority', 'stateId']);
    expect(byField.stateId).toMatchObject({ value: doing, actor: other });
    expect(byField.priority.actor).toEqual(agent);
  });

  test('an agent change to an agent-created issue joins the created entry', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const created = await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'New' }] }));
    const id = created.issues[0].id;
    await owner.mutation(api.issues.markRead, { ids: [id], read: true });
    await t.run(async (ctx) => await addComment(ctx, agent, { issueId: id, body: 'More context' }));
    const list = await owner.query(api.inbox.list, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'created', changes: [{ field: 'comment' }] });
    expect(list[0].readAt).toBeUndefined();
  });

  test('the owner\'s own changes never make or touch entries; neither do GitHub and the import', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const a = await createOne(owner, f.orb, { title: 'A' });
    const done = await stateId(t, f.orb, 'done');
    await owner.mutation(api.issues.update, { ids: [a.id], patch: { stateId: done } });
    await owner.mutation(api.comments.add, { issueId: a.id, body: 'mine' });
    await t.run(async (ctx) => {
      await updateIssues(ctx, { kind: 'github' }, { ids: [a.id], patch: { title: 'Renamed by GitHub' } });
      await updateIssues(ctx, { kind: 'import' }, { ids: [a.id], patch: { title: 'Renamed by import' } });
    });
    expect(await entries(t)).toEqual([]);
    // With an open entry: the owner's change leaves it exactly as it was.
    await t.run(async (ctx) => await addComment(ctx, agent, { issueId: a.id, body: 'agent' }));
    const [before] = await entries(t);
    await owner.mutation(api.issues.markRead, { ids: [a.id], read: true });
    await owner.mutation(api.comments.add, { issueId: a.id, body: 'mine again' });
    await owner.mutation(api.issues.update, { ids: [a.id], patch: { priority: 3 } });
    expect(await entries(t)).toEqual([{ ...before, readAt: expect.any(Number) }]);
  });

  test('removed entry: the next agent change opens a new one; undo does not bring back a second', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const a = await createOne(owner, f.orb, { title: 'A' });
    await t.run(async (ctx) => await addComment(ctx, agent, { issueId: a.id, body: 'one' }));
    expect(await owner.mutation(api.issues.markReviewed, { ids: [a.id] })).toEqual({ reviewed: 1 });
    expect(await owner.query(api.inbox.list, {})).toEqual([]);
    // The issue itself is unchanged by removing: no priority/status/updatedAt change, no marker.
    const issue = await getIssue(t, a.id);
    expect(issue.reviewedAt).toBeDefined(); // owner-created: legacy creation marker only
    await t.run(async (ctx) => await addComment(ctx, agent, { issueId: a.id, body: 'two' }));
    const list = await owner.query(api.inbox.list, {});
    expect(list).toHaveLength(1);
    expect(list[0].changes).toMatchObject([{ field: 'comment', value: 'two' }]);
    expect(await owner.mutation(api.issues.markUnreviewed, { ids: [a.id] })).toEqual({ unreviewed: 0 });
    expect(await entries(t)).toHaveLength(2);
    // Remove the new one, undo: the newest removed entry comes back.
    await owner.mutation(api.issues.markReviewed, { ids: [a.id] });
    expect(await owner.mutation(api.issues.markUnreviewed, { ids: [a.id] })).toEqual({ unreviewed: 1 });
    expect((await owner.query(api.inbox.list, {}))[0].changes).toMatchObject([{ value: 'two' }]);
  });

  test('what does not make an entry: rank, created, deleted; removed comments and relations name what was removed', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const a = await createOne(owner, f.orb, { title: 'A' });
    const b = await createOne(owner, f.orb, { title: 'B' });
    await t.run(async (ctx) => await updateIssues(ctx, agent, { ids: [a.id], patch: { priority: 0 } }));
    await owner.mutation(api.issues.reorder, { id: a.id, afterId: b.id });
    expect(await entries(t)).toEqual([]);
    const { commentId } = await t.run(async (ctx) => await addComment(ctx, agent, { issueId: b.id, body: 'oops' }));
    await t.run(async (ctx) => await removeComment(ctx, agent, { commentId }));
    const [entry] = await entries(t);
    expect(entry.changes.map((c) => c.field)).toEqual(['comment', 'comment_removed']);
    expect(entry.changes[1].value).toBeUndefined();
  });

  test('labels and relations keep what the activity text needs: first "from", latest value', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const a = await createOne(owner, f.orb, { title: 'A', labelIds: [f.design] });
    const b = await createOne(owner, f.orb, { title: 'B' });
    await t.run(async (ctx) => {
      await updateIssues(ctx, agent, { ids: [a.id], patch: { labelIds: [f.design, f.bug] } });
      await updateIssues(ctx, agent, { ids: [a.id], patch: { labelIds: [f.bug, f.docs] } });
    });
    await t.run(async (ctx) => await addRelation(ctx, agent, { fromId: a.id, toId: b.id, type: 'blocks' }));
    const list = await owner.query(api.inbox.list, {});
    const forA = list.find((e) => e.issueId === a.id)!;
    expect(forA.changes.find((c) => c.field === 'labelIds')).toMatchObject({ from: [f.design], value: [f.bug, f.docs] });
    expect(forA.changes.find((c) => c.field === 'relation')?.value).toBe(`blocks:out:${b.id}`);
    expect(list.find((e) => e.issueId === b.id)!.changes[0].value).toBe(`blocks:in:${a.id}`);
  });

  test('permanent deletion removes the entries; the cleanup drops old removed ones only', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const a = await createOne(owner, f.orb, { title: 'A' });
    const b = await createOne(owner, f.orb, { title: 'B' });
    const c = await createOne(owner, f.orb, { title: 'C' });
    for (const id of [a.id, b.id, c.id]) await t.run(async (ctx) => await addComment(ctx, agent, { issueId: id, body: 'x' }));
    await owner.mutation(api.issues.markReviewed, { ids: [a.id, b.id] });
    const now = Date.now();
    expect(await t.run(async (ctx) => await cleanupEntries(ctx, now, 100))).toBe(0);
    expect(await t.run(async (ctx) => await cleanupEntries(ctx, now + (INBOX_KEEP_DAYS + 1) * DAY_MS, 100))).toBe(2);
    expect((await entries(t)).map((e) => e.issueId)).toEqual([c.id]);
    await t.run(async (ctx) => await purgeIssue(ctx, (await ctx.db.get('issues', c.id))!, now));
    expect(await entries(t)).toEqual([]);
  });
});

describe('Migration migrations.inboxBackfill', () => {
  test('entries from the old markers, idempotent, the issues stay untouched', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const mine = await createOne(owner, f.orb, { title: 'Mine' });
    const created = await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'Unread' }, { teamId: f.orb, title: 'Read' }, { teamId: f.orb, title: 'Removed' }, { teamId: f.orb, title: 'Trashed' }] }));
    const [unread, read, removed, trashed] = created.issues.map((i) => i.id);
    // State before this change: markers on the issues, no entries.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('inboxEntries').collect()) await ctx.db.delete('inboxEntries', row._id);
      await ctx.db.patch('issues', read, { readAt: 1234 });
      await ctx.db.patch('issues', removed, { reviewedAt: 5678 });
      await ctx.db.patch('issues', trashed, { deletedAt: Date.now() });
    });
    const snapshot = async () => await t.run(async (ctx) => await ctx.db.query('issues').collect());
    const issuesBefore = await snapshot();

    const dry = await t.mutation(internal.migrations.inboxBackfill, {});
    expect(dry).toMatchObject({ applied: false, missing: 3, existing: 0, done: true });
    expect(await entries(t)).toEqual([]);

    const run = await t.mutation(internal.migrations.inboxBackfill, { apply: true });
    expect(run).toMatchObject({ applied: true, missing: 3, done: true });
    const list = await entries(t);
    expect(list.map((e) => e.issueId).sort()).toEqual([unread, read, trashed].sort());
    const entryOf = (id: Id<'issues'>) => list.find((e) => e.issueId === id)!;
    expect(entryOf(unread)).toMatchObject({ kind: 'created', actor: agent, changes: [] });
    expect(entryOf(unread).readAt).toBeUndefined();
    expect(entryOf(read).readAt).toBe(1234);
    expect(entryOf(unread).updatedAt).toBe((await getIssue(t, unread)).createdAt);
    expect(await snapshot()).toEqual(issuesBefore);
    expect(await getIssue(t, mine.id)).toMatchObject({ reviewedAt: expect.any(Number) });

    // Visible in the list: the trashed one is there but the client hides it until restored.
    expect(await owner.query(api.inbox.list, {})).toHaveLength(3);

    // The owner removes an entry; running again must not bring it back (note in opsStatus).
    await owner.mutation(api.issues.markReviewed, { ids: [unread] });
    expect(await t.mutation(internal.migrations.inboxBackfill, { apply: true })).toMatchObject({ applied: false, skipped: 'already done' });
    // Even when forced: every issue already has an entry (open or removed).
    expect(await t.mutation(internal.migrations.inboxBackfill, { apply: true, force: true })).toMatchObject({ missing: 0, existing: 3 });
    expect((await owner.query(api.inbox.list, {})).map((e) => e.issueId).sort()).toEqual([read, trashed].sort());
    expect((await historyOf(t, read)).map((r) => r.field)).toEqual(['created']);
  });

  test('pages: several pages give the same result', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    const created = await t.run(async (ctx) => await createIssues(ctx, agent, { issues: Array.from({ length: 7 }, (_, i) => ({ teamId: f.orb, title: `Agent ${i}` })) }));
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('inboxEntries').collect()) await ctx.db.delete('inboxEntries', row._id);
    });
    // Each page also reschedules itself in production; here the pages are driven by hand.
    let page = await t.mutation(internal.migrations.inboxBackfill, { apply: true, numItems: 3 });
    expect(page.done).toBe(false);
    while (!page.done) page = await t.mutation(internal.migrations.inboxBackfill, { apply: true, numItems: 3, cursor: 'cursor' in page ? page.cursor : undefined });
    expect(await entries(t)).toHaveLength(7);
    expect(new Set((await entries(t)).map((e) => e.issueId))).toEqual(new Set(created.issues.map((i) => i.id)));
    void owner;
  });
});
