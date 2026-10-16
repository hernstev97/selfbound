import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { canonicalTimeZone, dayInZone, DEFAULT_TIME_ZONE, type Day } from '../lib/dates';
import { fail, invalid } from '../lib/errors';
import { isOwnerKind } from '../shared/constants';
import { DEFAULT_PRIORITY_LIMITS, PRIORITY_LIMIT_MAX, type PriorityLimit, type PriorityLimits } from '../shared/priorityLimits';

// Instance settings (one row in `instanceSettings`). The time zone in which calendar days are
// counted: due dates, snooze, sprints, recurrences, the morning notification, MCP filters.
// Stored days stay plain "YYYY-MM-DD" strings, so changing the zone converts nothing; it only
// moves where the day boundary lies from now on. And the priority limits (XLR8-91).

async function row(ctx: QueryCtx): Promise<Doc<'instanceSettings'> | null> {
  return await ctx.db.query('instanceSettings').first();
}

/** The zone the owner (or the first sign-in) saved; null = never set. */
export async function storedTimeZone(ctx: QueryCtx): Promise<string | null> {
  return (await row(ctx))?.timeZone ?? null;
}

/** The zone in effect: the stored one, else Europe/Berlin (the behavior before the setting existed). */
export async function timeZoneOf(ctx: QueryCtx): Promise<string> {
  return (await storedTimeZone(ctx)) ?? DEFAULT_TIME_ZONE;
}

/** Calendar day of a moment in the instance's time zone. */
export async function todayOf(ctx: QueryCtx, now = Date.now()): Promise<Day> {
  return dayInZone(now, await timeZoneOf(ctx));
}

export async function writeTimeZone(ctx: MutationCtx, timeZone: string, now = Date.now()) {
  const zone = canonicalTimeZone(timeZone) ?? invalid(`Unknown time zone "${timeZone.slice(0, 64)}". Use an IANA name such as Europe/Berlin or America/New_York.`);
  const existing = await row(ctx);
  if (!existing) await ctx.db.insert('instanceSettings', { timeZone: zone, updatedAt: now });
  else if (existing.timeZone !== zone) await ctx.db.patch('instanceSettings', existing._id, { timeZone: zone, updatedAt: now });
  return { timeZone: zone };
}

export async function setTimeZone(ctx: MutationCtx, actor: Actor, args: { timeZone: string; ifUnset?: boolean }) {
  if (!isOwnerKind(actor.kind)) fail('access_denied', 'Only the owner can change the time zone.');
  const stored = await storedTimeZone(ctx);
  if (args.ifUnset && stored !== null) return { timeZone: stored };
  return await writeTimeZone(ctx, args.timeZone);
}

/** The limits in effect: the stored ones, else 1 urgent and 3 high, warning only. */
export async function priorityLimitsOf(ctx: QueryCtx): Promise<PriorityLimits> {
  return (await row(ctx))?.priorityLimits ?? DEFAULT_PRIORITY_LIMITS;
}

function checkLimit(limit: PriorityLimit, name: string): PriorityLimit {
  const { max, hard } = limit;
  if (max !== null && (!Number.isInteger(max) || max < 0 || max > PRIORITY_LIMIT_MAX)) {
    invalid(`The ${name} limit must be a whole number from 0 to ${PRIORITY_LIMIT_MAX}, or null for no limit.`);
  }
  return { max, hard };
}

/**
 * Lowering a limit changes no issue: issues already over it stay, only new raises are warned
 * about or (hard) rejected.
 */
export async function setPriorityLimits(ctx: MutationCtx, actor: Actor, limits: PriorityLimits, now = Date.now()) {
  if (!isOwnerKind(actor.kind)) fail('access_denied', 'Only the owner can change the priority limits.');
  const next: PriorityLimits = { urgent: checkLimit(limits.urgent, 'urgent'), high: checkLimit(limits.high, 'high') };
  const existing = await row(ctx);
  if (!existing) await ctx.db.insert('instanceSettings', { priorityLimits: next, updatedAt: now });
  else await ctx.db.patch('instanceSettings', existing._id, { priorityLimits: next, updatedAt: now });
  return next;
}
