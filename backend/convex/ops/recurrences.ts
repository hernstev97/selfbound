import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { daysBetween, nextMonthDay, nextWeekday, type Day } from '../lib/dates';
import { invalid, notFound } from '../lib/errors';
import type { Priority } from '../shared/constants';
import { syncFileRefs } from './files';
import { todayOf } from './instance';
import { createIssues } from './issues';
import { assertIssuesAllowed, checkDay, checkDescription, checkEstimate, checkLabels, checkProject, checkTitle, getTeam } from './validate';

// Recurrences: weekly (weekday 1 = Monday … 7 = Sunday) or monthly (monthDay 1–28),
// computed in the instance time zone (ops/instance.ts). An hourly cron creates exactly one issue per
// (template, date) for due dates (recurrenceRuns).

export const SYSTEM: Actor = { kind: 'system' };

type Cadence = 'weekly' | 'monthly';

function checkSchedule(cadence: Cadence, weekday: number | undefined, monthDay: number | undefined) {
  if (cadence === 'weekly') {
    if (weekday === undefined || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      invalid('"Weekly" needs a weekday from 1 (Monday) to 7 (Sunday).');
    }
    if (monthDay !== undefined) invalid('"Weekly" has no day of the month.');
  } else {
    if (monthDay === undefined || !Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28) {
      invalid('"Monthly" needs a day of the month from 1 to 28.');
    }
    if (weekday !== undefined) invalid('"Monthly" has no weekday.');
  }
}

/** Next date from `from` (inclusive or exclusive). */
export function nextOccurrence(
  r: { cadence: Cadence; weekday?: number; monthDay?: number },
  from: Day,
  inclusive: boolean,
): Day {
  return r.cadence === 'weekly' ? nextWeekday(from, r.weekday!, inclusive) : nextMonthDay(from, r.monthDay!, inclusive);
}

export interface RecurrenceFields {
  teamId: Id<'teams'>;
  title: string;
  description?: string;
  priority?: Priority;
  labelIds?: Id<'labels'>[];
  projectId?: Id<'projects'>;
  estimate?: number;
  cadence: Cadence;
  weekday?: number;
  monthDay?: number;
}

export async function createRecurrence(
  ctx: MutationCtx,
  _actor: Actor,
  args: RecurrenceFields & { startDate?: string; sourceIssueId?: Id<'issues'> },
) {
  const team = await getTeam(ctx, args.teamId);
  assertIssuesAllowed(team, 'recurrences');
  checkSchedule(args.cadence, args.weekday, args.monthDay);
  const today = await todayOf(ctx);
  const from = args.startDate ? checkDay(args.startDate, 'The start date') : today;
  const recurrenceId = await ctx.db.insert('recurrences', {
    teamId: team._id,
    title: checkTitle(args.title),
    ...(args.description ? { description: checkDescription(args.description) } : {}),
    priority: args.priority ?? 0,
    labelIds: await checkLabels(ctx, team._id, args.labelIds ?? []),
    ...(args.projectId ? { projectId: (await checkProject(ctx, team._id, args.projectId))._id } : {}),
    ...(args.estimate !== undefined ? { estimate: checkEstimate(args.estimate) } : {}),
    cadence: args.cadence,
    ...(args.weekday !== undefined ? { weekday: args.weekday } : {}),
    ...(args.monthDay !== undefined ? { monthDay: args.monthDay } : {}),
    nextDate: nextOccurrence(args, daysBetween(today, from) < 0 ? today : from, true),
    active: true,
    ...(args.sourceIssueId ? { sourceIssueId: args.sourceIssueId } : {}),
    createdAt: Date.now(),
  });
  await syncFileRefs(ctx, recurrenceId, args.description ?? null);
  return { recurrenceId };
}

export interface UpdateRecurrenceArgs {
  recurrenceId: Id<'recurrences'>;
  title?: string;
  description?: string | null;
  priority?: Priority;
  labelIds?: Id<'labels'>[];
  projectId?: Id<'projects'> | null;
  estimate?: number | null;
  cadence?: Cadence;
  weekday?: number | null;
  monthDay?: number | null;
  active?: boolean;
}

export async function updateRecurrence(ctx: MutationCtx, _actor: Actor, args: UpdateRecurrenceArgs) {
  const r = (await ctx.db.get('recurrences', args.recurrenceId)) ?? notFound('The recurrence');
  const patch: Partial<Doc<'recurrences'>> = {};
  if (args.title !== undefined) patch.title = checkTitle(args.title);
  if (args.description !== undefined) patch.description = args.description === null ? undefined : checkDescription(args.description);
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.labelIds !== undefined) patch.labelIds = await checkLabels(ctx, r.teamId, args.labelIds, new Set(r.labelIds));
  if (args.projectId !== undefined) {
    patch.projectId = args.projectId === null ? undefined : (await checkProject(ctx, r.teamId, args.projectId))._id;
  }
  if (args.estimate !== undefined) patch.estimate = args.estimate === null ? undefined : checkEstimate(args.estimate);
  const scheduleChanged =
    args.cadence !== undefined || args.weekday !== undefined || args.monthDay !== undefined || (args.active === true && !r.active);
  if (args.active !== undefined) patch.active = args.active;
  if (scheduleChanged) {
    const cadence = args.cadence ?? r.cadence;
    const weekday = args.weekday === null ? undefined : (args.weekday ?? (cadence === 'weekly' ? r.weekday : undefined));
    const monthDay = args.monthDay === null ? undefined : (args.monthDay ?? (cadence === 'monthly' ? r.monthDay : undefined));
    checkSchedule(cadence, weekday, monthDay);
    patch.cadence = cadence;
    patch.weekday = weekday;
    patch.monthDay = monthDay;
    patch.nextDate = nextOccurrence({ cadence, weekday, monthDay }, await todayOf(ctx), true);
  }
  await ctx.db.patch('recurrences', r._id, patch);
  if (args.description !== undefined) await syncFileRefs(ctx, r._id, patch.description ?? null);
  return { recurrenceId: r._id };
}

export async function removeRecurrence(ctx: MutationCtx, _actor: Actor, args: { recurrenceId: Id<'recurrences'> }) {
  const r = (await ctx.db.get('recurrences', args.recurrenceId)) ?? notFound('The recurrence');
  const runs = await ctx.db
    .query('recurrenceRuns')
    .withIndex('by_recurrence_date', (q) => q.eq('recurrenceId', r._id))
    .take(4000);
  for (const run of runs) await ctx.db.delete('recurrenceRuns', run._id);
  await ctx.db.delete('recurrences', r._id);
  await syncFileRefs(ctx, r._id, null);
  return { recurrenceId: r._id };
}

/**
 * Creates one issue per due recurrence (nextDate ≤ today in the instance time zone).
 * Idempotent via recurrenceRuns (recurrenceId, date). Missed dates are not all
 * made up: at most one, then it continues with the next date from today.
 * If creating fails for a business reason (e.g. an archived label), the
 * recurrence is paused (active = false).
 */
export async function runDueRecurrences(ctx: MutationCtx, now = Date.now(), limit = 25) {
  const today = await todayOf(ctx, now);
  const due = await ctx.db
    .query('recurrences')
    .withIndex('by_next', (q) => q.eq('active', true).lte('nextDate', today))
    .take(limit);
  const created: { recurrenceId: Id<'recurrences'>; date: Day; issueId: Id<'issues'> }[] = [];
  const paused: Id<'recurrences'>[] = [];
  for (const r of due) {
    const date = r.nextDate;
    const run = await ctx.db
      .query('recurrenceRuns')
      .withIndex('by_recurrence_date', (q) => q.eq('recurrenceId', r._id).eq('date', date))
      .unique();
    if (!run) {
      try {
        const result = await createIssues(
          ctx,
          SYSTEM,
          {
            issues: [
              {
                teamId: r.teamId,
                title: r.title,
                description: r.description,
                status: 'todo',
                priority: r.priority,
                labelIds: r.labelIds,
                projectId: r.projectId,
                estimate: r.estimate,
                dueDate: date,
              },
            ],
          },
          { recurrenceId: r._id },
        );
        const issueId = result.issues[0].id;
        await ctx.db.insert('recurrenceRuns', { recurrenceId: r._id, date, issueId });
        created.push({ recurrenceId: r._id, date, issueId });
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error;
        await ctx.db.patch('recurrences', r._id, { active: false });
        paused.push(r._id);
        continue;
      }
    }
    let next = nextOccurrence(r, date, false);
    if (daysBetween(today, next) < 0) next = nextOccurrence(r, today, true);
    await ctx.db.patch('recurrences', r._id, { nextDate: next });
  }
  return { created, paused, more: due.length === limit };
}
