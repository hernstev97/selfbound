import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { canonicalTimeZone, dayInZone, dayStartInZone, hourInZone, zoneOffsetMinutes } from '../convex/lib/dates';
import { runDueRecurrences } from '../convex/ops/recurrences';
import { createOne, expectCode, fixture, getIssue, setup, STRANGER, type Client } from './helpers';

// The instance time zone: where a calendar day begins. Stored days are plain strings, so only the
// boundary moves; these tests cover the helpers (including clock changes) and each place that
// reads the zone: snooze, recurrences, the morning job, MCP filters, wiki sources, rate windows.

afterEach(() => {
  vi.useRealTimers();
});

const setZone = async (owner: Client, timeZone: string) => await owner.mutation(api.instance.setTimeZone, { timeZone });

describe('helpers', () => {
  test('offsets and days in zones with whole, half and quarter hours, and across the date line', () => {
    const noon = Date.UTC(2026, 6, 1, 12, 0);
    expect(zoneOffsetMinutes(noon, 'UTC')).toBe(0);
    expect(zoneOffsetMinutes(noon, 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(noon, 'America/New_York')).toBe(-240);
    expect(zoneOffsetMinutes(noon, 'Asia/Kolkata')).toBe(330);
    expect(zoneOffsetMinutes(noon, 'Asia/Kathmandu')).toBe(345);
    expect(zoneOffsetMinutes(noon, 'Pacific/Kiritimati')).toBe(840);
    expect(zoneOffsetMinutes(noon, 'Pacific/Pago_Pago')).toBe(-660);
    // 23:30 UTC on 1 July: already the 2nd in Berlin, Kolkata and Auckland, still the 1st in New York.
    const late = Date.UTC(2026, 6, 1, 23, 30);
    expect(['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Pago_Pago'].map((z) => dayInZone(late, z))).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-01',
      '2026-07-02',
      '2026-07-02',
      '2026-07-01',
    ]);
    expect(hourInZone(late, 'Asia/Kolkata')).toBe(5);
    expect(hourInZone(Date.UTC(2026, 6, 1, 0, 0), 'America/New_York')).toBe(20);
  });

  test('agrees with Intl formatting over several years in several zones', () => {
    for (const zone of ['Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata']) {
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
      for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2029, 0, 1); ms += 53 * 60 * 1000 + 17_000) {
        if (dayInZone(ms, zone) !== fmt.format(ms)) throw new Error(`Mismatch in ${zone} at ${new Date(ms).toISOString()}`);
      }
    }
  });

  test('clock changes: Berlin, New York, Lord Howe (30 minutes)', () => {
    // Berlin 2026-03-29 02:00 → 03:00 (01:00 UTC), 2026-10-25 03:00 → 02:00.
    expect(zoneOffsetMinutes(Date.UTC(2026, 2, 29, 0, 59), 'Europe/Berlin')).toBe(60);
    expect(zoneOffsetMinutes(Date.UTC(2026, 2, 29, 1, 0), 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 25, 0, 59), 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 25, 1, 0), 'Europe/Berlin')).toBe(60);
    // New York 2026-03-08 02:00 → 03:00 (07:00 UTC), 2026-11-01 02:00 → 01:00 (06:00 UTC).
    expect(zoneOffsetMinutes(Date.UTC(2026, 2, 8, 6, 59), 'America/New_York')).toBe(-300);
    expect(zoneOffsetMinutes(Date.UTC(2026, 2, 8, 7, 0), 'America/New_York')).toBe(-240);
    expect(zoneOffsetMinutes(Date.UTC(2026, 10, 1, 5, 59), 'America/New_York')).toBe(-240);
    expect(zoneOffsetMinutes(Date.UTC(2026, 10, 1, 6, 0), 'America/New_York')).toBe(-300);
    // Lord Howe: UTC+10:30 in winter, UTC+11 in summer, the change is 30 minutes (2026-10-04 02:00 → 02:30).
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 1), 'Australia/Lord_Howe')).toBe(630);
    expect(zoneOffsetMinutes(Date.UTC(2026, 11, 1), 'Australia/Lord_Howe')).toBe(660);
    expect(dayInZone(Date.UTC(2026, 9, 3, 13, 29), 'Australia/Lord_Howe')).toBe('2026-10-03');
    expect(dayInZone(Date.UTC(2026, 9, 3, 13, 30), 'Australia/Lord_Howe')).toBe('2026-10-04');
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 3, 15, 29), 'Australia/Lord_Howe')).toBe(630);
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 3, 15, 30), 'Australia/Lord_Howe')).toBe(660);
  });

  test('start of a day: exact boundary, also on days with 23 or 25 hours', () => {
    const cases: [string, string][] = [
      ['Europe/Berlin', '2026-03-29'], // 23-hour day
      ['Europe/Berlin', '2026-10-25'], // 25-hour day
      ['America/New_York', '2026-03-08'],
      ['America/New_York', '2026-11-01'],
      ['Australia/Lord_Howe', '2026-04-05'],
      ['Australia/Lord_Howe', '2026-10-04'],
      ['Asia/Kolkata', '2026-07-01'],
      ['Pacific/Kiritimati', '2026-07-01'],
      ['Pacific/Pago_Pago', '2026-07-01'],
      ['UTC', '2026-07-01'],
    ];
    for (const [zone, day] of cases) {
      const start = dayStartInZone(day, zone);
      expect(dayInZone(start, zone), `${zone} ${day}`).toBe(day);
      expect(dayInZone(start - 1, zone), `${zone} ${day} (the moment before)`).not.toBe(day);
    }
    expect(dayStartInZone('2026-03-29', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 28, 23, 0));
    expect(dayStartInZone('2026-03-30', 'Europe/Berlin') - dayStartInZone('2026-03-29', 'Europe/Berlin')).toBe(23 * 3_600_000);
    expect(dayStartInZone('2026-10-26', 'Europe/Berlin') - dayStartInZone('2026-10-25', 'Europe/Berlin')).toBe(25 * 3_600_000);
  });

  test('start of a day when the clocks skip midnight (Havana, 2026-03-08 00:00 → 01:00)', () => {
    const start = dayStartInZone('2026-03-08', 'America/Havana');
    expect(dayInZone(start, 'America/Havana')).toBe('2026-03-08');
    expect(dayInZone(start - 1, 'America/Havana')).toBe('2026-03-07');
    expect(hourInZone(start, 'America/Havana')).toBe(1);
  });

  test('zone names: canonical form, unknown and odd input', () => {
    expect(canonicalTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(canonicalTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    for (const bad of ['', 'Mars/Olympus', 'Europe/', '../etc', 'Europe/Berlin\n', '+02:00', 'x'.repeat(65)]) expect(canonicalTimeZone(bad), bad).toBeNull();
  });
});

describe('setting', () => {
  test('not set until saved; meta.get shows it; the canonical name is stored', async () => {
    const { owner } = setup();
    expect((await owner.query(api.meta.get, {})).timeZone).toBeNull();
    expect(await setZone(owner, 'america/new_york')).toEqual({ timeZone: 'America/New_York' });
    expect((await owner.query(api.meta.get, {})).timeZone).toBe('America/New_York');
    // An alias keeps the spelling the user picked.
    await setZone(owner, 'Asia/Kolkata');
    expect((await owner.query(api.meta.get, {})).timeZone).toBe('Asia/Kolkata');
  });

  test('ifUnset (the first sign-in) never overwrites a saved zone', async () => {
    const { owner } = setup();
    expect(await owner.mutation(api.instance.setTimeZone, { timeZone: 'Asia/Tokyo', ifUnset: true })).toEqual({ timeZone: 'Asia/Tokyo' });
    expect(await owner.mutation(api.instance.setTimeZone, { timeZone: 'America/Chicago', ifUnset: true })).toEqual({ timeZone: 'Asia/Tokyo' });
    expect((await owner.query(api.meta.get, {})).timeZone).toBe('Asia/Tokyo');
  });

  test('an unknown zone is rejected; only the owner can set it', async () => {
    const { t, owner } = setup();
    await expectCode(setZone(owner, 'Mars/Olympus'), 'invalid');
    await expectCode(setZone(owner, ''), 'invalid');
    expect((await owner.query(api.meta.get, {})).timeZone).toBeNull();
    await expectCode(t.withIdentity(STRANGER).mutation(api.instance.setTimeZone, { timeZone: 'UTC' }), 'access_denied');
  });

  test('changing the zone changes no stored day', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 11, 12));
    const { id } = await createOne(owner, f.orb, { status: 'todo', dueDate: '2026-10-20' });
    await owner.mutation(api.issues.update, { ids: [id], patch: { snoozedUntil: '2026-10-15' } });
    const sprint = await owner.mutation(api.sprints.create, { startDate: '2026-10-12', endDate: '2026-10-25' });
    await setZone(owner, 'Pacific/Auckland');
    await setZone(owner, 'America/Los_Angeles');
    const issue = await getIssue(t, id);
    expect([issue.dueDate, issue.snoozedUntil]).toEqual(['2026-10-20', '2026-10-15']);
    const row = await t.run(async (ctx) => await ctx.db.get('sprints', sprint.id));
    expect([row?.startDate, row?.endDate]).toEqual(['2026-10-12', '2026-10-25']);
  });
});

describe('in another zone', () => {
  // 2026-10-11 06:30 UTC: 08:30 in Berlin, 23:30 on the 10th in Los Angeles, 19:30 in Auckland... on the 11th.
  const NOW = Date.UTC(2026, 9, 11, 6, 30);

  test('snooze: "after today" counts in the instance zone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { owner } = setup();
    const f = await fixture(owner);
    const { id } = await createOne(owner, f.orb, { status: 'todo' });
    const snooze = (until: string) => owner.mutation(api.issues.update, { ids: [id], patch: { snoozedUntil: until } });
    // Berlin (default): today is the 11th.
    await expectCode(snooze('2026-10-11'), 'invalid');
    await setZone(owner, 'America/Los_Angeles'); // today is the 10th
    expect((await snooze('2026-10-11')).changed).toBe(1);
    await setZone(owner, 'Pacific/Auckland'); // 19:30 on the 11th
    await expectCode(snooze('2026-10-11'), 'invalid');
    expect((await snooze('2026-10-12')).changed).toBe(1);
  });

  test('recurrences are due from local midnight, also on the day the clocks change', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await setZone(owner, 'America/New_York');
    const { recurrenceId } = await owner.mutation(api.recurrences.create, { teamId: f.orb, title: 'Sunday planning', cadence: 'weekly', weekday: 7 });
    const run = (now: number) => t.run(async (ctx) => await runDueRecurrences(ctx, now));
    const setNext = (nextDate: string) =>
      t.run(async (ctx) => {
        await ctx.db.patch('recurrences', recurrenceId, { nextDate });
      });
    const next = () => t.run(async (ctx) => (await ctx.db.get('recurrences', recurrenceId))!.nextDate);
    // Spring: Sunday 2026-03-08 starts at 05:00 UTC (still standard time, UTC−5).
    await setNext('2026-03-08');
    expect((await run(Date.UTC(2026, 2, 8, 4, 30))).created).toHaveLength(0);
    expect((await run(Date.UTC(2026, 2, 8, 5, 30))).created).toHaveLength(1);
    expect(await next()).toBe('2026-03-15');
    // Autumn: Sunday 2026-11-01 starts at 04:00 UTC (still summer time, UTC−4).
    await setNext('2026-11-01');
    expect((await run(Date.UTC(2026, 10, 1, 3, 30))).created).toHaveLength(0);
    expect((await run(Date.UTC(2026, 10, 1, 4, 30))).created).toHaveLength(1);
    expect(await next()).toBe('2026-11-08');
  });

  test('morning notification: the configured hour in the instance zone, also in a half-hour zone', async () => {
    vi.useFakeTimers();
    const { t, owner } = setup();
    const f = await fixture(owner);
    await setZone(owner, 'Asia/Kolkata'); // UTC+5:30
    await createOne(owner, f.orb, { title: 'Due', dueDate: '2026-10-11' });
    const morning = async (ms: number) => {
      vi.setSystemTime(ms);
      return (await t.mutation(internal.push.morning, {})).sent;
    };
    // 08:00 in Kolkata is 02:30 UTC; the hourly cron runs at :00, so the first run in the 8 o'clock hour is 03:00 UTC (08:30).
    expect(await morning(Date.UTC(2026, 9, 11, 2, 0))).toEqual([]); // 07:30
    expect(await morning(Date.UTC(2026, 9, 11, 3, 0))).toEqual(['due']); // 08:30
    expect(await morning(Date.UTC(2026, 9, 11, 4, 0))).toEqual([]); // once a day
    // The key carries the day in Kolkata: 19:00 UTC on the 11th is already the 12th there.
    const keys = await t.run(async (ctx) => (await ctx.db.query('pushEvents').collect()).map((e) => e.key));
    expect(keys).toEqual(['due:2026-10-11']);
  });

  test('MCP overdue and done_today use the instance zone', async () => {
    vi.useFakeTimers();
    // 02:30 UTC on 2026-10-12: Monday morning in Berlin, still Sunday evening (19:30) in Los Angeles.
    vi.setSystemTime(Date.UTC(2026, 9, 12, 2, 30));
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb, { title: 'Due Sunday', status: 'todo', dueDate: '2026-10-11' }); // ORB-1
    const done = await createOne(owner, f.orb, { title: 'Done now', status: 'todo' }); // ORB-2
    await owner.mutation(api.issues.update, { ids: [done.id], patch: { status: 'done' } });
    const { key } = await owner.action(api.agents.create, { name: 'Claude Code' });
    const list = async (filter: string) => {
      const response = await t.fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_issues', arguments: { filter } } }),
      });
      const body = (await response.json()) as { result: { structuredContent: { issues: { identifier: string }[] } } };
      return body.result.structuredContent.issues.map((i) => i.identifier);
    };
    await setZone(owner, 'America/Los_Angeles');
    // Still the 11th there: the issue due on the 11th is not overdue, the one closed 19:30 on the 11th is done today.
    expect(await list('overdue')).toEqual([]);
    expect(await list('done_today')).toEqual(['ORB-2']);
    // One hour into the 12th in Los Angeles: due yesterday, and the issue was closed yesterday.
    vi.setSystemTime(Date.UTC(2026, 9, 12, 8, 0));
    expect(await list('overdue')).toEqual(['ORB-1']);
    expect(await list('done_today')).toEqual([]);
    // Berlin at the same moment (10:00 on the 12th): the issue was closed 04:30 today.
    await setZone(owner, 'Europe/Berlin');
    expect(await list('done_today')).toEqual(['ORB-2']);
  });

  test('wiki source access date and rate window use the instance zone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 12, 2, 30)); // the 12th in Berlin, the 11th in Los Angeles
    const { owner } = setup();
    const f = await fixture(owner);
    await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
    await setZone(owner, 'America/Los_Angeles');
    const { articleId } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Sources', sources: [{ title: 'Book' }] });
    expect((await owner.query(api.wiki.get, { id: articleId }))!.sources[0]!.accessedAt).toBe('2026-10-11');
    const { dayWindow } = await import('../convex/ops/agents');
    expect(dayWindow(Date.now(), 'America/Los_Angeles')).toBe('d:2026-10-11');
    expect(dayWindow(Date.now())).toBe('d:2026-10-12');
  });
});
