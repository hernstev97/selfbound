import { v } from 'convex/values';
import { ownerWriteMutation } from './lib/auth';
import * as ops from './ops/teams';

/** Without teamId: workspace label. With groupId: part of a label group. */
export const create = ownerWriteMutation({
  args: {
    name: v.string(),
    hue: v.number(),
    groupId: v.optional(v.id('labelGroups')),
    teamId: v.optional(v.id('teams')),
  },
  handler: async (ctx, args) => await ops.createLabel(ctx, ctx.actor, args),
});

/** groupId: null takes the label out of its group. archived: true hides it from new assignments. */
export const update = ownerWriteMutation({
  args: {
    labelId: v.id('labels'),
    name: v.optional(v.string()),
    hue: v.optional(v.number()),
    groupId: v.optional(v.union(v.id('labelGroups'), v.null())),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => await ops.updateLabel(ctx, ctx.actor, args),
});
