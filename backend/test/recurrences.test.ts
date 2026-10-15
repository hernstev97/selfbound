import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import {
  addDays,
  isDay,
  nextMonday,
  nextMonthDay,
  nextWeekday,
  weekdayOf,
  zoneOffsetMinutes,
} from '../convex/lib/dates';
import { runDueRecurrences } from '../convex/ops/recurrences';
import { berlinDay, expectCode, fixture, historyOf, setup, type T } from './helpers';

describe('Calendar days in Europe/Berlin', () => {
  test('matches Intl over several years (including DST changes)', () => {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
    const start = Date.UTC(2025, 0, 1);
    for (let ms = start; ms < Date.UTC(2031, 0, 1); ms += 37 * 60 * 1000 + 13_000) {
      if (berlinDay(ms) !== fmt.format(ms)) throw new Error(`Mismatch at ${new Date(ms).toISOString()}`);
    }
  });

  test('DST transitions 2026', () => {
    expect(zoneOffsetMinutes(Date.UTC(2026, 2, 29, 0, 59), 'Europe/Berlin')).toBe(60);
    expect(zoneOffsetMinutes(Date.UTC(2026, 2, 29, 1, 0), 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 25, 0, 59), 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 25, 1, 0), 'Europe/Berlin')).toBe(60);
    expect(berlinDay(Date.UTC(2026, 2, 28, 22, 59))).toBe('2026-03-28');
    expect(berlinDay(Date.UTC(2026, 2, 28, 23, 0))).toBe('2026-03-29');
    expect(berlinDay(Date.UTC(2026, 9, 24, 21, 59))).toBe('2026-10-24');
    expect(berlinDay(Date.UTC(2026, 9, 24, 22, 0))).toBe('2026-10-25');
  });

  test('weekday, day of month, next Monday', () => {
    expect(weekdayOf('2026-10-08')).toBe(4);
    expect(weekdayOf('2026-10-11')).toBe(7);
    expect(nextMonday('2026-10-08')).toBe('2026-10-12');
    expect(nextMonday('2026-10-12')).toBe('2026-10-19');
    expect(nextWeekday('2026-10-12', 1, true)).toBe('2026-10-12');
    expect(nextWeekday('2026-10-12', 7, false)).toBe('2026-10-18');
    expect(nextMonthDay('2026-01-29', 28, true)).toBe('2026-02-28');
    expect(nextMonthDay('2026-12-15', 1, true)).toBe('2027-01-01');
    expect(nextMonthDay('2026-12-01', 1, true)).toBe('2026-12-01');
    expect(nextMonthDay('2026-12-01', 1, false)).toBe('2027-01-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-1-01')).toBe(false);
  });
});

async function setNext(t: T, id: Id<'recurrences'>, nextDate: string) {
  await t.run(async (ctx) => {
    await ctx.db.patch('recurrences', id, { nextDate });
  });
}
const run = (t: T, now: number) => t.run(async (ctx) => await runDueRecurrences(ctx, now));
const recurrence = (t: T, id: Id<'recurrences'>) => t.run(async (ctx) => (await ctx.db.get('recurrences', id))!);

describe('Recurring tasks', () => {
  test('create validates the cadence and sets the first date', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await expectCode(owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'x', cadence: 'weekly' }), 'invalid');
    await expectCode(owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'x', cadence: 'weekly', weekday: 8 }), 'invalid');
    await expectCode(owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'x', cadence: 'monthly', monthDay: 29 }), 'invalid');
    await expectCode(
      owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'x', cadence: 'monthly', monthDay: 3, weekday: 1 }),
      'invalid',
    );
    const today = berlinDay(Date.now());
    await owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'Mondays', cadence: 'weekly', weekday: 1 });
    await owner.mutation(api.recurrences.create, {
      teamId: f.orb,
      title: 'Later',
      cadence: 'monthly',
      monthDay: 15,
      startDate: '2030-01-20',
    });
    const list = await owner.query(api.recurrences.list, {});
    expect(list.map((r) => r.nextDate)).toEqual([nextWeekday(today, 1, true), '2030-02-15']);
  });

  test('exactly one issue per date (idempotent), next date across the month boundary', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { recurrenceId } = await owner.mutation(api.recurrences.create, {
      teamId: f.orb,
      title: 'Month-end close',
      description: 'Sort receipts',
      cadence: 'monthly',
      monthDay: 28,
      priority: 3,
      labelIds: [f.docs],
      projectId: f.orbProject,
      estimate: 2,
    });
    await setNext(t, recurrenceId, '2026-01-28');
    const at = Date.UTC(2026, 0, 28, 9, 0);
    const first = await run(t, at);
    expect(first.created).toHaveLength(1);
    const issueId = first.created[0].issueId;
    const issue = await t.run(async (ctx) => (await ctx.db.get('issues', issueId))!);
    expect(issue).toMatchObject({
      title: 'Month-end close',
      status: 'todo',
      priority: 3,
      labelIds: [f.docs],
      projectId: f.orbProject,
      estimate: 2,
      dueDate: '2026-01-28',
      recurrenceId,
      createdBy: { kind: 'system' },
    });
    expect((await historyOf(t, issueId)).map((r) => [r.field, r.actor.kind])).toEqual([['created', 'system']]);
    expect((await recurrence(t, recurrenceId)).nextDate).toBe('2026-02-28');
    // Same date again (e.g. after a reset): no second issue.
    await setNext(t, recurrenceId, '2026-01-28');
    expect((await run(t, at + 3600_000)).created).toHaveLength(0);
    expect((await recurrence(t, recurrenceId)).nextDate).toBe('2026-02-28');
    // Nothing happens before the date.
    expect((await run(t, Date.UTC(2026, 1, 27, 12))).created).toHaveLength(0);
    expect((await run(t, Date.UTC(2026, 1, 28, 0, 30))).created).toHaveLength(1);
    expect((await recurrence(t, recurrenceId)).nextDate).toBe('2026-03-28');
    const runs = await t.run(async (ctx) => await ctx.db.query('recurrenceRuns').collect());
    expect(runs.map((r) => r.date)).toEqual(['2026-01-28', '2026-02-28']);
  });

  test('DST: due from midnight Berlin time, not UTC', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { recurrenceId } = await owner.mutation(api.recurrences.create, {
      teamId: f.orb,
      title: 'Sunday planning',
      cadence: 'weekly',
      weekday: 7,
    });
    // Spring: Sunday 2026-03-29 starts in Berlin at 23:00 UTC the day before (still standard time).
    await setNext(t, recurrenceId, '2026-03-29');
    expect((await run(t, Date.UTC(2026, 2, 28, 22, 30))).created).toHaveLength(0);
    expect((await run(t, Date.UTC(2026, 2, 28, 23, 30))).created).toHaveLength(1);
    expect((await recurrence(t, recurrenceId)).nextDate).toBe('2026-04-05');
    // Autumn: Sunday 2026-10-25 starts at 22:00 UTC the day before (still summer time).
    await setNext(t, recurrenceId, '2026-10-25');
    expect((await run(t, Date.UTC(2026, 9, 24, 21, 30))).created).toHaveLength(0);
    expect((await run(t, Date.UTC(2026, 9, 24, 22, 30))).created).toHaveLength(1);
    expect((await recurrence(t, recurrenceId)).nextDate).toBe('2026-11-01');
  });

  test('missed dates: at most one is caught up, then continue from today', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { recurrenceId } = await owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'Mondays', cadence: 'weekly', weekday: 1 });
    await setNext(t, recurrenceId, '2026-09-07');
    // Wednesday 2026-10-07: four Mondays missed.
    const result = await run(t, Date.UTC(2026, 9, 7, 10));
    expect(result.created.map((c) => c.date)).toEqual(['2026-09-07']);
    expect((await recurrence(t, recurrenceId)).nextDate).toBe('2026-10-12');
  });

  test('pauses on a business error, update and delete', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { recurrenceId } = await owner.mutation(api.recurrences.create, {
      teamId: f.orb,
      title: 'With label',
      cadence: 'weekly',
      weekday: 3,
      labelIds: [f.docs],
    });
    await owner.mutation(api.labels.update, { labelId: f.docs, archived: true });
    await setNext(t, recurrenceId, '2026-10-07');
    expect(await run(t, Date.UTC(2026, 9, 7, 10))).toMatchObject({ created: [], paused: [recurrenceId] });
    expect((await recurrence(t, recurrenceId)).active).toBe(false);
    await owner.mutation(api.recurrences.update, { recurrenceId, labelIds: [], active: true, cadence: 'monthly', weekday: null, monthDay: 5 });
    const r = await recurrence(t, recurrenceId);
    expect(r).toMatchObject({ active: true, cadence: 'monthly', monthDay: 5 });
    expect(r.weekday).toBeUndefined();
    expect(r.nextDate).toBe(nextMonthDay(berlinDay(Date.now()), 5, true));
    await owner.mutation(api.recurrences.remove, { recurrenceId });
    expect(await owner.query(api.recurrences.list, {})).toEqual([]);
  });

  test('the cron job runs through the internal mutation', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { recurrenceId } = await owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'Today', cadence: 'weekly', weekday: 1 });
    await setNext(t, recurrenceId, berlinDay(Date.now()));
    const result = await t.mutation(internal.maintenance.runDueRecurrences, {});
    expect(result.created).toHaveLength(1);
  });
});
