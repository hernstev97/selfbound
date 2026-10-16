import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { fail } from '../lib/errors';
import { identifierOf, OPEN_STATUSES, type Priority } from '../shared/constants';
import { isLimited, limitFor, overLimit, type LimitedPriority, type PriorityLimit } from '../shared/priorityLimits';
import { priorityLimitsOf } from './instance';

// Enforcement of the priority limits (XLR8-91). A "raise" adds an issue to the open issues of a
// team with priority urgent or high: setting the priority, creating, moving to another team,
// restoring from the trash, undo. Hard limits reject a raise that would end above `max`; issues
// already above a lowered limit stay, lowering and other edits remain allowed.

const NAME: Record<LimitedPriority, string> = { 1: 'urgent', 2: 'high' };

/** Counts as open work with this priority (trash excluded). */
export function holds(issue: Pick<Doc<'issues'>, 'priority' | 'status' | 'deletedAt'>, priority: Priority) {
  return issue.priority === priority && issue.deletedAt === undefined && OPEN_STATUSES.includes(issue.status);
}

/** Open, non-deleted issues of a team with this priority (index by_team_priority, no team scan). */
export async function openWithPriority(ctx: QueryCtx, teamId: Id<'teams'>, priority: LimitedPriority) {
  const rows: Doc<'issues'>[] = [];
  for (const status of OPEN_STATUSES) {
    const page = await ctx.db
      .query('issues')
      .withIndex('by_team_priority', (q) => q.eq('teamId', teamId).eq('priority', priority).eq('status', status))
      .take(200);
    for (const row of page) if (row.deletedAt === undefined) rows.push(row);
  }
  return rows;
}

/** The hard limit for (team, priority) if `adding` more issues would go over it; else null. */
async function hardLimitHit(ctx: QueryCtx, teamId: Id<'teams'>, priority: LimitedPriority, adding: number) {
  const limit = limitFor(await priorityLimitsOf(ctx), priority);
  if (!limit?.hard || limit.max === null) return null;
  const open = await openWithPriority(ctx, teamId, priority);
  return overLimit(limit, open.length + adding) ? { limit: limit as PriorityLimit & { max: number }, open } : null;
}

/**
 * Is there room for `adding` more open issues with this priority (0: are the counted ones within
 * the limit)? Soft limits always have room.
 */
export async function hasRoom(ctx: QueryCtx, teamId: Id<'teams'>, priority: Priority, adding = 1) {
  if (!isLimited(priority)) return true;
  return (await hardLimitHit(ctx, teamId, priority, adding)) === null;
}

/**
 * Rejects (`priority_limit`) if `adding` more open issues with this priority would go over the
 * team's hard limit. Called before writing, so nothing is half done.
 */
export async function assertRoom(ctx: QueryCtx, teamId: Id<'teams'>, priority: Priority, adding = 1) {
  if (!isLimited(priority) || adding <= 0) return;
  const hit = await hardLimitHit(ctx, teamId, priority, adding);
  if (!hit) return;
  const team = await ctx.db.get('teams', teamId);
  const key = team?.key ?? '?';
  const word = NAME[priority];
  const { max } = hit.limit;
  const newest = [...hit.open].sort((a, b) => b.updatedAt - a.updatedAt);
  const names = newest.slice(0, 3).map((i) => identifierOf(key, i.number));
  const more = newest.length - names.length;
  const list = names.length ? `: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '';
  const has = `Team ${key} already has ${hit.open.length} open ${word} ${hit.open.length === 1 ? 'issue' : 'issues'}${list}`;
  const what = adding === 1 ? `another ${word} issue is` : `${adding} more ${word} issues are`;
  const message =
    max === 0
      ? `Team ${key} allows no open ${word} issues (hard limit 0). Choose another priority, or raise the limit in Settings → Priorities.`
      : `${has}, and the hard limit is ${max}, so ${what} not allowed. Lower the priority of one of them first, or raise the limit in Settings → Priorities.`;
  fail('priority_limit', message, {
    teamId,
    team: key,
    priority,
    limit: max,
    open: hit.open.length,
    issues: names,
  });
}
