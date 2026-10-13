import { v } from 'convex/values';
import { ownerWriteMutation } from './lib/auth';
import { requestIdArg } from './lib/validators';
import * as ops from './ops/relations';
import { relationTypeValidator } from './schema';

/** blocks: from blocks to · related · duplicate: from is a duplicate of to (markDuplicate sets from to 'duplicate'). */
export const add = ownerWriteMutation({
  args: {
    fromId: v.id('issues'),
    toId: v.id('issues'),
    type: relationTypeValidator,
    markDuplicate: v.optional(v.boolean()),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.addRelation(ctx, ctx.actor, args),
});

export const remove = ownerWriteMutation({
  args: { relationId: v.id('relations'), ...requestIdArg },
  handler: async (ctx, args) => await ops.removeRelation(ctx, ctx.actor, args),
});
