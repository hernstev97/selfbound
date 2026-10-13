import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { bundleMessages } from '../convex/ops/notify';
import { createOne, expectCode, fixture, getIssue, historyOf, setup, type Client, type T } from './helpers';

// Snooze: a day on the issue hides it from the lists; the morning job brings it back to the inbox.

// 2026-10-11 is daylight saving time: 8:00 in Berlin = 6:00 UTC.
const at = (day: number, hourUtc: number) => Date.UTC(2026, 9, day, hourUtc, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

async function events(t: T) {
  return await t.run(async (ctx) => await ctx.db.query('pushEvents').collect());
}

const snooze = async (owner: Client, ids: Id<'issues'>[], until: string | null) =>
  await owner.mutation(api.issues.update, { ids, patch: { snoozedUntil: until } });

describe('snoozing', () => {
  test('sets the day, writes history, bumps updatedAt; null unsnoozes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(11, 4));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'todo' });
    const before = await getIssue(t, id);
    vi.setSystemTime(at(11, 5));
    expect((await snooze(owner, [id], '2026-10-12')).changed).toBe(1);
    const snoozed = await getIssue(t, id);
    expect(snoozed.snoozedUntil).toBe('2026-10-12');
    expect(snoozed.updatedAt).toBeGreaterThan(before.updatedAt);
    expect((await historyOf(t, id)).find((h) => h.field === 'snoozedUntil')).toMatchObject({ to: '2026-10-12', actor: { kind: 'steven' } });
    // Same value: nothing happens.
    expect((await snooze(owner, [id], '2026-10-12')).changed).toBe(0);
    expect((await snooze(owner, [id], null)).changed).toBe(1);
    expect((await getIssue(t, id)).snoozedUntil).toBeUndefined();
  });

  test('only a day after today (Berlin), only for open issues, several at once', async () => {
    vi.useFakeTimers();
    // 23:30 UTC on the 11th is already the 12th in Berlin.
    vi.setSystemTime(Date.UTC(2026, 9, 11, 23, 30));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { status: 'todo' });
    const b = await createOne(owner, f.orb, { status: 'backlog' });
    const done = await createOne(owner, f.orb, { status: 'done' });
    await expectCode(snooze(owner, [a.id], '2026-10-12'), 'invalid');
    await expectCode(snooze(owner, [a.id], '2026-10-11'), 'invalid');
    await expectCode(snooze(owner, [a.id], '2026-13-40'), 'invalid');
    await expectCode(snooze(owner, [done.id], '2026-10-20'), 'invalid');
    expect((await snooze(owner, [a.id, b.id], '2026-10-13')).changed).toBe(2);
    expect((await getIssue(t, b.id)).snoozedUntil).toBe('2026-10-13');
  });

  test('closing an issue ends the snooze; undo restores a day that has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(11, 5));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'todo' });
    await snooze(owner, [id], '2026-10-15');
    await owner.mutation(api.issues.update, { ids: [id], patch: { status: 'done' } });
    expect((await getIssue(t, id)).snoozedUntil).toBeUndefined();
    expect((await historyOf(t, id)).filter((h) => h.field === 'snoozedUntil')).toHaveLength(2);
    // A snooze sent together with closing does not stick either.
    const other = await createOne(owner, f.orb, { status: 'todo' });
    await owner.mutation(api.issues.update, { ids: [other.id], patch: { status: 'canceled', snoozedUntil: '2026-10-20' } });
    expect((await getIssue(t, other.id)).snoozedUntil).toBeUndefined();

    // Undo of an unsnooze: the old day is put back even if it is in the past by now.
    const third = await createOne(owner, f.orb, { status: 'todo' });
    await snooze(owner, [third.id], '2026-10-12');
    await snooze(owner, [third.id], null);
    vi.setSystemTime(at(20, 5));
    await owner.mutation(api.issues.revert, { items: [{ id: third.id, patch: { snoozedUntil: '2026-10-12' }, expect: { snoozedUntil: null } }] });
    expect((await getIssue(t, third.id)).snoozedUntil).toBe('2026-10-12');
    // Compare-and-set: a changed day is a conflict.
    await expectCode(
      owner.mutation(api.issues.revert, { items: [{ id: third.id, patch: { snoozedUntil: null }, expect: { snoozedUntil: '2026-10-13' } }] }),
      'conflict',
    );
  });
});

describe('return in the morning', () => {
  test('from 8:00 Berlin: snooze cleared, back in the inbox as unread, one push; once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 12));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { title: 'Call the bank', status: 'todo' });
    await owner.mutation(api.issues.markRead, { ids: [id], read: true });
    await snooze(owner, [id], '2026-10-11');
    expect((await getIssue(t, id)).reviewedAt).toBeDefined();

    vi.setSystemTime(at(11, 5)); // 7:00 Berlin: too early
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual([]);
    expect((await getIssue(t, id)).snoozedUntil).toBe('2026-10-11');

    vi.setSystemTime(at(11, 6)); // 8:00 Berlin
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual(['snooze']);
    const issue = await getIssue(t, id);
    expect(issue.snoozedUntil).toBeUndefined();
    expect(issue.reviewedAt).toBeUndefined();
    expect(issue.readAt).toBeUndefined();
    expect(issue.updatedAt).toBe(at(11, 6));
    const history = await historyOf(t, id);
    expect(history.find((h) => h.field === 'snoozedUntil' && h.actor.kind === 'system')).toMatchObject({ from: '2026-10-11' });
    expect(history.find((h) => h.field === 'unreviewed')).toBeDefined();
    const rows = (await events(t)).filter((e) => e.kind === 'snooze');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'ORB-1 is back from snooze', body: 'Call the bank', url: '/issue/ORB-1', issueId: id });

    vi.setSystemTime(at(11, 7));
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual([]);
    expect((await events(t)).filter((e) => e.kind === 'snooze')).toHaveLength(1);
  });

  test('several issues arrive as one bundled push; a missed day is caught up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 12));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { title: 'A', status: 'todo' });
    const b = await createOne(owner, f.nova, { title: 'B', status: 'backlog' });
    await snooze(owner, [a.id], '2026-10-10');
    await snooze(owner, [b.id], '2026-10-11');
    vi.setSystemTime(at(11, 6));
    await t.mutation(internal.push.morning, {});
    const rows = (await events(t)).filter((e) => e.kind === 'snooze');
    expect(rows).toHaveLength(2);
    const [message] = bundleMessages(rows);
    expect(message).toMatchObject({ title: '2 snoozed issues are back', url: '/inbox' });
  });

  test('closed and deleted issues only lose the snooze; a switched-off push still returns the issue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 12));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const open = await createOne(owner, f.orb, { status: 'todo' });
    const trashed = await createOne(owner, f.orb, { status: 'todo' });
    const closed = await createOne(owner, f.orb, { status: 'todo' });
    await snooze(owner, [open.id, trashed.id, closed.id], '2026-10-11');
    await owner.mutation(api.issues.remove, { ids: [trashed.id] });
    // Closed by a path that left the snooze in place (data from before the rule).
    await t.run(async (ctx) => await ctx.db.patch('issues', closed.id, { status: 'done', snoozedUntil: '2026-10-11', reviewedAt: 1 }));
    await owner.mutation(api.push.setEvent, { kind: 'snooze', enabled: false });
    vi.setSystemTime(at(11, 6));
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual([]);
    expect(await events(t)).toHaveLength(0);
    const issue = await getIssue(t, open.id);
    expect(issue.snoozedUntil).toBeUndefined();
    expect(issue.reviewedAt).toBeUndefined();
    for (const id of [trashed.id, closed.id]) {
      const gone = await getIssue(t, id);
      expect(gone.snoozedUntil).toBeUndefined();
      expect(gone.reviewedAt).toBeDefined();
    }
  });

  test('a snoozed issue is left out of the due summary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 12));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const hidden = await createOne(owner, f.orb, { title: 'Hidden', status: 'todo', dueDate: '2026-10-11' });
    await createOne(owner, f.orb, { title: 'Shown', status: 'todo', dueDate: '2026-10-11' });
    await snooze(owner, [hidden.id], '2026-10-20');
    vi.setSystemTime(at(11, 6));
    await t.mutation(internal.push.morning, {});
    const due = (await events(t)).filter((e) => e.kind === 'due');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ title: 'ORB-2 is due today', body: 'Shown' });
  });
});
