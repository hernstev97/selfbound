import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { QueryCtx } from '../_generated/server';

// Backlog rank as a fractional key (fractional-indexing, base62). The characters are in ASCII
// order and Convex sorts strings byte by byte, so index order and JavaScript comparison agree.
// The rank is global (across all teams); each view sorts its subset by it.

/** Highest assigned rank (deleted and done issues included), otherwise null. */
export async function lastRank(ctx: QueryCtx): Promise<string | null> {
  const last = await ctx.db.query('issues').withIndex('by_rank').order('desc').first();
  return last?.rank ?? null;
}

/** n new ranks at the end of the backlog. */
export async function ranksAtEnd(ctx: QueryCtx, n: number): Promise<string[]> {
  return generateNKeysBetween(await lastRank(ctx), null, n);
}

/** A rank between two neighbors (null = start or end). */
export function rankBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/** Next rank after `rank` in the index (null = none), skipping issue `exclude`. */
export async function rankAfter(ctx: QueryCtx, rank: string, exclude: string): Promise<string | null> {
  const rows = await ctx.db
    .query('issues')
    .withIndex('by_rank', (q) => q.gt('rank', rank))
    .take(2);
  return rows.find((row) => row._id !== exclude)?.rank ?? null;
}

/** Previous rank before `rank` in the index (null = none), skipping issue `exclude`. */
export async function rankBefore(ctx: QueryCtx, rank: string, exclude: string): Promise<string | null> {
  const rows = await ctx.db
    .query('issues')
    .withIndex('by_rank', (q) => q.lt('rank', rank))
    .order('desc')
    .take(2);
  return rows.find((row) => row._id !== exclude)?.rank ?? null;
}
