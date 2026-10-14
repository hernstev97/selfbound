import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { invalid } from '../lib/errors';
import { getIssue } from './validate';
import { idempotent } from '../lib/idempotency';
import { LIMITS } from '../shared/constants';
import { record } from './history';
import { INBOX_KEEP_DAYS, openEntry, type InboxEntry } from './inboxChanges';

// Reading, removing and listing inbox entries (the rules are described in inboxChanges.ts).

/** Entries in `inbox.list`: the newest ones. More than this is a pile nobody reads. */
export const INBOX_LIST_MAX = 1000;

/** Open entries, newest first (`inbox.list`). */
export async function listOpen(ctx: QueryCtx): Promise<InboxEntry[]> {
  return await ctx.db
    .query('inboxEntries')
    .withIndex('by_removed', (q) => q.eq('removedAt', undefined))
    .order('desc')
    .take(INBOX_LIST_MAX);
}

function checkIds(ids: Id<'issues'>[]) {
  if (ids.length === 0 || ids.length > LIMITS.bulkUpdateMax) invalid(`Between 1 and ${LIMITS.bulkUpdateMax} issues per call.`);
}

/** Removes entries from the inbox (formerly "mark as reviewed"). Takes issue IDs. */
export async function markReviewed(ctx: MutationCtx, actor: Actor, args: { ids: Id<'issues'>[]; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'issues.markReviewed', { ...args }, async () => {
    checkIds(args.ids);
    const now = Date.now();
    let reviewed = 0;
    for (const id of new Set(args.ids)) {
      const issue = await getIssue(ctx, id, { allowDeleted: true });
      const open = await openEntry(ctx, issue._id);
      if (!open) continue;
      await ctx.db.patch('inboxEntries', open._id, { removedAt: now });
      await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'reviewed', to: now });
      reviewed++;
    }
    return { reviewed };
  });
}

/** Undo of "remove from inbox": the entry removed last comes back (not if a newer one is open). */
export async function markUnreviewed(ctx: MutationCtx, actor: Actor, args: { ids: Id<'issues'>[]; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'issues.markUnreviewed', { ...args }, async () => {
    checkIds(args.ids);
    const now = Date.now();
    let unreviewed = 0;
    for (const id of new Set(args.ids)) {
      const issue = await getIssue(ctx, id, { allowDeleted: true });
      if (await openEntry(ctx, issue._id)) continue;
      // Open ones sort first in the index, so the newest removed one is the first with removedAt.
      const last = await ctx.db
        .query('inboxEntries')
        .withIndex('by_issue', (q) => q.eq('issueId', issue._id))
        .order('desc')
        .first();
      if (!last || last.removedAt === undefined) continue;
      await ctx.db.patch('inboxEntries', last._id, { removedAt: undefined });
      await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'unreviewed', from: last.removedAt });
      unreviewed++;
    }
    return { unreviewed };
  });
}

/** Marks entries read or unread. No history: reading is not a change to the issue. */
export async function markRead(ctx: MutationCtx, actor: Actor, args: { ids: Id<'issues'>[]; read: boolean; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'issues.markRead', { ...args }, async () => {
    checkIds(args.ids);
    const now = Date.now();
    let changed = 0;
    for (const id of new Set(args.ids)) {
      const issue = await getIssue(ctx, id, { allowDeleted: true });
      const open = await openEntry(ctx, issue._id);
      if (!open || (open.readAt !== undefined) === args.read) continue;
      await ctx.db.patch('inboxEntries', open._id, { readAt: args.read ? now : undefined });
      changed++;
    }
    return { changed };
  });
}

/** Deletes all entries of an issue (the issue is deleted for good). */
export async function purgeEntries(ctx: MutationCtx, issueId: Id<'issues'>) {
  const rows = await ctx.db
    .query('inboxEntries')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .collect();
  for (const row of rows) await ctx.db.delete('inboxEntries', row._id);
}

/** Cleanup: deletes entries removed more than `INBOX_KEEP_DAYS` days ago (in batches). */
export async function cleanupEntries(ctx: MutationCtx, now: number, limit: number) {
  const old = await ctx.db
    .query('inboxEntries')
    .withIndex('by_removed', (q) => q.gt('removedAt', 0).lt('removedAt', now - INBOX_KEEP_DAYS * 86_400_000))
    .take(limit);
  for (const row of old) await ctx.db.delete('inboxEntries', row._id);
  return old.length;
}
