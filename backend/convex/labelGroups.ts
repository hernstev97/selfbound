import { v } from 'convex/values';
import { ownerWriteMutation } from './lib/auth';
import * as ops from './ops/teams';

/** exclusive: true = single choice (at most one label of the group per issue). */
export const create = ownerWriteMutation({
  args: { name: v.string(), exclusive: v.boolean(), hue: v.optional(v.number()), teamId: v.optional(v.id('teams')) },
  handler: async (ctx, args) => await ops.createLabelGroup(ctx, ctx.actor, args),
});

export const update = ownerWriteMutation({
  args: {
    groupId: v.id('labelGroups'),
    name: v.optional(v.string()),
    exclusive: v.optional(v.boolean()),
    hue: v.optional(v.number()),
  },
  handler: async (ctx, args) => await ops.updateLabelGroup(ctx, ctx.actor, args),
});
