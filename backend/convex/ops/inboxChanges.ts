import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';

// Inbox: one open entry per issue (`inboxEntries`, removedAt missing). The entry is a note about
// the issue, not part of it: creating, reading and removing entries never change the issue
// (status, `updatedAt`).
//
// - An issue created by an agent (or shared into the inbox) opens an entry of kind `created`.
// - A change by an agent to an existing issue (any history field below) adds to the open entry
//   or opens one of kind `changed`. The entry keeps the latest change per field, moves up in the
//   list (`updatedAt`) and becomes unread again.
// - The owner's own changes never open or touch entries.
// - Removing sets `removedAt` (undo clears it). The cleanup deletes entries removed long ago.
//
// This file is what `record` (ops/history.ts) needs; reading, removing and the list are in inbox.ts.

export type InboxEntry = Doc<'inboxEntries'>;
type Change = InboxEntry['changes'][number];

/** Fields an entry remembers. A change to a field already there replaces the earlier one. */
const CHANGES_MAX = 16;
export const INBOX_KEEP_DAYS = 90;

/**
 * History fields that do not make an entry: how the issue was created (that is the entry's kind),
 * order inside a list, and the inbox's own history rows.
 */
const IGNORED = new Set(['created', 'rank', 'deleted', 'reviewed', 'unreviewed']);

/** The open entry of an issue. */
export async function openEntry(ctx: QueryCtx, issueId: Id<'issues'>): Promise<InboxEntry | null> {
  return await ctx.db
    .query('inboxEntries')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId).eq('removedAt', undefined))
    .first();
}

/** A new entry for an issue that starts in the inbox. */
export async function openCreatedEntry(ctx: MutationCtx, actor: Actor, issueId: Id<'issues'>, now: number, readAt?: number) {
  return await ctx.db.insert('inboxEntries', {
    issueId,
    kind: 'created',
    actor,
    changes: [],
    createdAt: now,
    updatedAt: now,
    ...(readAt !== undefined ? { readAt } : {}),
  });
}

/** What an entry keeps of a history value: IDs, numbers and short texts, no documents. */
function valueOf(field: string, value: unknown): Change['value'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (field === 'teamId') return typeof o.identifier === 'string' ? o.identifier : undefined;
    if (field.startsWith('relation')) return typeof o.otherId === 'string' ? `${o.type}:${o.direction}:${o.otherId}` : undefined;
    if (typeof o.preview === 'string') return o.preview;
  }
  return undefined;
}

/**
 * Called for every history row (`record`). Only agents make entries: the owner knows what they
 * did, GitHub and the import are background noise.
 */
export async function noteChange(
  ctx: MutationCtx,
  actor: Actor,
  at: number,
  entry: { issueId: Id<'issues'>; field: string; from?: unknown; to?: unknown },
) {
  if (actor.kind !== 'agent' || IGNORED.has(entry.field)) return;
  const removed = entry.field === 'comment_removed' || entry.field === 'relation_removed';
  const value = valueOf(entry.field, removed ? entry.from : entry.to);
  const open = await openEntry(ctx, entry.issueId);
  // Labels and team move from something to something; the first "from" of an entry stays.
  let from = entry.field === 'labelIds' || entry.field === 'teamId' ? valueOf(entry.field, entry.from) : undefined;
  from = open?.changes.find((c) => c.field === entry.field)?.from ?? from;
  const change: Change = { field: entry.field, actor, at, ...(value !== undefined ? { value } : {}), ...(from !== undefined && typeof from !== 'number' ? { from } : {}) };
  if (!open) {
    await ctx.db.insert('inboxEntries', { issueId: entry.issueId, kind: 'changed', actor, changes: [change], createdAt: at, updatedAt: at });
    return;
  }
  const changes = [...open.changes.filter((c) => c.field !== change.field), change].slice(-CHANGES_MAX);
  await ctx.db.patch('inboxEntries', open._id, { actor, changes, updatedAt: at, readAt: undefined });
}
