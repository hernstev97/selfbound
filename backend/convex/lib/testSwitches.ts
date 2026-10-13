import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fail } from './errors';

// Test switches for end-to-end tests ("server rejects → rollback").
// Only effective when XLR8_TEST_SWITCHES=1 is set (local only).

export const REJECT_WRITES = 'rejectWrites';

export function testSwitchesEnabled() {
  return process.env.XLR8_TEST_SWITCHES === '1';
}

export async function rejectWritesActive(ctx: QueryCtx): Promise<boolean> {
  if (!testSwitchesEnabled()) return false;
  const row = await ctx.db
    .query('settings')
    .withIndex('by_key', (q) => q.eq('key', REJECT_WRITES))
    .unique();
  return row?.value === true;
}

/** Throws `rejected` when the test switch "reject writes" is on. */
export async function assertWritable(ctx: QueryCtx) {
  if (await rejectWritesActive(ctx)) {
    fail('rejected', 'The server is rejecting writes right now (test switch).');
  }
}

export async function setRejectWrites(ctx: MutationCtx, value: boolean) {
  if (!testSwitchesEnabled()) fail('access_denied', 'Test switches are disabled on this backend.');
  const row = await ctx.db
    .query('settings')
    .withIndex('by_key', (q) => q.eq('key', REJECT_WRITES))
    .unique();
  if (row) await ctx.db.patch('settings', row._id, { value });
  else await ctx.db.insert('settings', { key: REJECT_WRITES, value });
  return { rejectWrites: value };
}
