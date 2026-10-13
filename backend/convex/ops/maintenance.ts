import type { MutationCtx, QueryCtx } from '../_generated/server';
import { DAY_MS } from '../lib/dates';
import { cleanupPushEvents } from './notify';

// Cleanup and ops status (the ops page).

export const REQUESTS_KEEP_DAYS = 30;
export const DELIVERIES_KEEP_DAYS = 30;
export const RATE_WINDOWS_KEEP_DAYS = 2;

export async function writeOpsStatus(ctx: MutationCtx, key: string, value: unknown, now = Date.now()) {
  const row = await ctx.db
    .query('opsStatus')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  if (row) await ctx.db.patch('opsStatus', row._id, { value, at: now });
  else await ctx.db.insert('opsStatus', { key, value, at: now });
}

export async function readOpsStatus(ctx: QueryCtx, key: string) {
  const row = await ctx.db
    .query('opsStatus')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  return row ? { value: row.value, at: row.at } : null;
}

/**
 * Deletes old idempotency entries (30 days), webhook deliveries and check runs from deliveries (30 days),
 * rate windows (2 days) and push events (7 days) in batches. `more` = something is left.
 */
export async function cleanupOld(ctx: MutationCtx, now = Date.now(), limit = 500) {
  const requests = await ctx.db
    .query('requests')
    .withIndex('by_created', (q) => q.lt('createdAt', now - REQUESTS_KEEP_DAYS * DAY_MS))
    .take(limit);
  for (const row of requests) await ctx.db.delete('requests', row._id);
  const deliveries = await ctx.db
    .query('githubDeliveries')
    .withIndex('by_received', (q) => q.lt('receivedAt', now - DELIVERIES_KEEP_DAYS * DAY_MS))
    .take(limit);
  for (const row of deliveries) await ctx.db.delete('githubDeliveries', row._id);
  const checkRuns = await ctx.db
    .query('githubCheckRuns')
    .withIndex('by_received', (q) => q.lt('receivedAt', now - DELIVERIES_KEEP_DAYS * DAY_MS))
    .take(limit);
  for (const row of checkRuns) await ctx.db.delete('githubCheckRuns', row._id);
  const windows = await ctx.db
    .query('rateWindows')
    .withIndex('by_creation_time', (q) => q.lt('_creationTime', now - RATE_WINDOWS_KEEP_DAYS * DAY_MS))
    .take(limit);
  for (const row of windows) await ctx.db.delete('rateWindows', row._id);
  const push = await cleanupPushEvents(ctx, now, limit);
  return {
    requests: requests.length,
    deliveries: deliveries.length,
    checkRuns: checkRuns.length,
    rateWindows: windows.length,
    push,
    more:
      requests.length === limit ||
      deliveries.length === limit ||
      checkRuns.length === limit ||
      windows.length === limit ||
      push >= limit,
  };
}
