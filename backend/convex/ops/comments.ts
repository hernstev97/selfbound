import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { sameValue } from '../lib/equal';
import { fail, invalid, notFound } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { syncFileRefs } from './files';
import { syncArticleLinks } from './links';
import { record } from './history';
import { OWNER_KIND } from '../shared/constants';
import { notifyAgentComment } from './notify';
import { checkComment, getIssue } from './validate';

// Comments: add, edit, (soft) remove. The owner may edit every comment,
// an agent only its own.

async function editableComment(ctx: MutationCtx, actor: Actor, commentId: Id<'comments'>) {
  const comment = (await ctx.db.get('comments', commentId)) ?? notFound('The comment', { commentId });
  if (comment.deletedAt !== undefined) invalid('The comment was removed.', { commentId });
  if (actor.kind !== OWNER_KIND && !sameValue(comment.author, actor)) {
    fail('access_denied', 'Only the author or the owner can change this comment.', { commentId });
  }
  return comment;
}

export async function addComment(
  ctx: MutationCtx,
  actor: Actor,
  args: { issueId: Id<'issues'>; body: string; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'comments.add', { ...args }, async () =>
    addCommentCore(ctx, actor, args),
  );
}

/** Core of addComment without the idempotency wrapper (`requestId` only for the history). */
export async function addCommentCore(
  ctx: MutationCtx,
  actor: Actor,
  args: { issueId: Id<'issues'>; body: string; requestId?: string },
) {
  const issue = await getIssue(ctx, args.issueId);
  const body = checkComment(args.body);
  const now = Date.now();
  const commentId = await ctx.db.insert('comments', { issueId: issue._id, body, author: actor, createdAt: now });
  await syncFileRefs(ctx, commentId, body, now);
  await syncArticleLinks(ctx, { kind: 'comment', id: commentId, issueId: issue._id }, body);
  await ctx.db.patch('issues', issue._id, { updatedAt: now });
  await record(ctx, actor, now, args.requestId, {
    issueId: issue._id,
    field: 'comment',
    to: { commentId, preview: body.slice(0, 120) },
  });
  await notifyAgentComment(ctx, actor, issue, commentId, body, now);
  return { commentId };
}

export async function editComment(
  ctx: MutationCtx,
  actor: Actor,
  args: { commentId: Id<'comments'>; body: string; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'comments.edit', { ...args }, async () => {
    const comment = await editableComment(ctx, actor, args.commentId);
    const body = checkComment(args.body);
    if (body === comment.body) return { commentId: comment._id, changed: false };
    const now = Date.now();
    await ctx.db.patch('comments', comment._id, { body, editedAt: now });
    await syncFileRefs(ctx, comment._id, body, now);
    await syncArticleLinks(ctx, { kind: 'comment', id: comment._id, issueId: comment.issueId }, body);
    await ctx.db.patch('issues', comment.issueId, { updatedAt: now });
    await record(ctx, actor, now, args.requestId, {
      issueId: comment.issueId,
      field: 'comment_edited',
      to: { commentId: comment._id, preview: body.slice(0, 120) },
    });
    return { commentId: comment._id, changed: true };
  });
}

export async function removeComment(
  ctx: MutationCtx,
  actor: Actor,
  args: { commentId: Id<'comments'>; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'comments.remove', { ...args }, async () => {
    const comment = await editableComment(ctx, actor, args.commentId);
    const now = Date.now();
    await ctx.db.patch('comments', comment._id, { deletedAt: now });
    await syncFileRefs(ctx, comment._id, null, now);
    await syncArticleLinks(ctx, { kind: 'comment', id: comment._id, issueId: comment.issueId }, null);
    await ctx.db.patch('issues', comment.issueId, { updatedAt: now });
    await record(ctx, actor, now, args.requestId, {
      issueId: comment.issueId,
      field: 'comment_removed',
      from: { commentId: comment._id },
    });
    return { commentId: comment._id };
  });
}

// ---------------------------------------------------------------- Paged reads

/** Maximum comments per page (issues.detail, comments.page). */
export const COMMENT_PAGE = 100;
/** And maximum characters of comment text per page (a single comment may have 50,000). */
export const COMMENT_PAGE_CHARS = 1_000_000;
/** Comments read per page, including removed ones (read limit). */
const COMMENT_SCAN_MAX = 2000;

/**
 * The newest non-removed comments of an issue before `before` (without it: the newest
 * overall), returned in chronological order. `hasMore`: there are older ones.
 * Order as in the index: createdAt, ties broken by _creationTime.
 */
export async function commentPage(
  ctx: QueryCtx,
  issueId: Id<'issues'>,
  before: Doc<'comments'> | null,
  limit = COMMENT_PAGE,
) {
  const max = Math.max(1, Math.min(COMMENT_PAGE, Math.floor(limit)));
  const sources = before
    ? [
        ctx.db
          .query('comments')
          .withIndex('by_issue', (q) =>
            q.eq('issueId', issueId).eq('createdAt', before.createdAt).lt('_creationTime', before._creationTime),
          )
          .order('desc'),
        ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issueId', issueId).lt('createdAt', before.createdAt))
          .order('desc'),
      ]
    : [
        ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issueId', issueId))
          .order('desc'),
      ];
  const comments: Doc<'comments'>[] = [];
  let chars = 0;
  let scanned = 0;
  let hasMore = false;
  outer: for (const source of sources) {
    for await (const comment of source) {
      if (scanned++ >= COMMENT_SCAN_MAX) {
        hasMore = true;
        break outer;
      }
      if (comment.deletedAt !== undefined) continue;
      if (comments.length >= max || (comments.length > 0 && chars + comment.body.length > COMMENT_PAGE_CHARS)) {
        hasMore = true;
        break outer;
      }
      comments.push(comment);
      chars += comment.body.length;
    }
  }
  return { comments: comments.reverse(), hasMore };
}
