import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

// Counters live in their own table (`counters`) so that creating an issue does not re-run every
// client's meta query. The stored value is always the last value HANDED OUT. Convex serializes
// concurrent transactions (OCC with automatic retry), so no value is handed out twice.
//
// Names: 'seq' (highest assigned seq, starts at −1), 'team:<teamId>' (highest number in the
// team, starts at 0), 'sprint' (highest sprint number, starts at 0).

export const SEQ = 'seq';
export const SPRINT = 'sprint';
export const teamCounter = (teamId: Id<'teams'>) => `team:${teamId}`;

function start(name: string) {
  return name === SEQ ? -1 : 0;
}

async function row(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query('counters')
    .withIndex('by_name', (q) => q.eq('name', name))
    .unique();
}

export async function readCounter(ctx: QueryCtx, name: string): Promise<number> {
  return (await row(ctx, name))?.value ?? start(name);
}

/** Hands out `count` consecutive values and returns the first. */
export async function takeCounter(ctx: MutationCtx, name: string, count = 1): Promise<number> {
  const existing = await row(ctx, name);
  const current = existing?.value ?? start(name);
  if (existing) await ctx.db.patch('counters', existing._id, { value: current + count });
  else await ctx.db.insert('counters', { name, value: current + count });
  return current + 1;
}

/** Sets a counter (seed, import). Never lowers it, unless `force` is set. */
export async function setCounter(ctx: MutationCtx, name: string, value: number, force = false) {
  const existing = await row(ctx, name);
  if (!existing) await ctx.db.insert('counters', { name, value });
  else if (force || value > existing.value) await ctx.db.patch('counters', existing._id, { value });
}
