import { v } from 'convex/values';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { invalid } from './lib/errors';
import { requestIdArg } from './lib/validators';
import * as ops from './ops/comments';

/**
 * Load older comments: the (up to 100) non-removed comments before comment `before`, in
 * chronological order. `issues.detail` returns the newest 100 and `commentsHasMore`; `before`
 * is then the oldest of those.
 */
export const page = ownerQuery({
  args: { issueId: v.id('issues'), before: v.id('comments'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const before = await ctx.db.get('comments', args.before);
    if (!before || before.issueId !== args.issueId) invalid('The reference comment does not belong to this issue.');
    return await ops.commentPage(ctx, args.issueId, before, args.limit);
  },
});

export const add = ownerWriteMutation({
  args: { issueId: v.id('issues'), body: v.string(), ...requestIdArg },
  handler: async (ctx, args) => await ops.addComment(ctx, ctx.actor, args),
});

export const edit = ownerWriteMutation({
  args: { commentId: v.id('comments'), body: v.string(), ...requestIdArg },
  handler: async (ctx, args) => await ops.editComment(ctx, ctx.actor, args),
});

export const remove = ownerWriteMutation({
  args: { commentId: v.id('comments'), ...requestIdArg },
  handler: async (ctx, args) => await ops.removeComment(ctx, ctx.actor, args),
});
