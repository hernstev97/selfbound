import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { noteChange } from './inboxChanges';

// History: one row per changed field. The actor always comes from the verified
// identity (UI: requireOwner, MCP: agent key, cron: system).
//
// Field names: 'created' (exactly one row on creation), the issue fields
// (title, status, priority, labelIds, projectId, estimate, dueDate, parentId,
// model, rank), 'sprint', 'description' (version and preview only), 'comment',
// 'comment_edited', 'comment_removed', 'relation', 'relation_removed',
// 'deleted', 'restored', 'reviewed', 'unreviewed'.

export interface HistoryEntry {
  issueId: Id<'issues'>;
  field: string;
  from?: unknown;
  to?: unknown;
}

export async function record(
  ctx: MutationCtx,
  actor: Actor,
  at: number,
  requestId: string | undefined,
  entry: HistoryEntry,
) {
  await ctx.db.insert('history', {
    issueId: entry.issueId,
    field: entry.field,
    ...(entry.from === undefined || entry.from === null ? {} : { from: entry.from }),
    ...(entry.to === undefined || entry.to === null ? {} : { to: entry.to }),
    actor,
    at,
    ...(requestId ? { requestId } : {}),
  });
  // An agent's change to an existing issue also shows up in the owner's inbox.
  await noteChange(ctx, actor, at, entry);
}
