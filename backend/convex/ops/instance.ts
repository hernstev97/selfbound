import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { canonicalTimeZone, dayInZone, DEFAULT_TIME_ZONE, type Day } from '../lib/dates';
import { fail, invalid } from '../lib/errors';
import { OWNER_KIND } from '../shared/constants';

// Instance settings (one row in `instanceSettings`). For now the time zone in which calendar days
// are counted: due dates, snooze, sprints, recurrences, the morning notification, MCP filters.
// Stored days stay plain "YYYY-MM-DD" strings, so changing the zone converts nothing; it only
// moves where the day boundary lies from now on.

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
  if (actor.kind !== OWNER_KIND) fail('access_denied', 'Only the owner can change the time zone.');
  const stored = await storedTimeZone(ctx);
  if (args.ifUnset && stored !== null) return { timeZone: stored };
  return await writeTimeZone(ctx, args.timeZone);
}
