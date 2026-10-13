import { v } from 'convex/values';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { requestIdArg, sprintDecisionValidator } from './lib/validators';
import * as ops from './ops/sprints';

/** All sprints, newest first. */
export const list = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const sprints = await ctx.db.query('sprints').withIndex('by_number').order('desc').take(500);
    return sprints;
  },
});

/**
 * A sprint's items (small: only IDs, kind, origin, times, outcome).
 * The client uses them to tell "planned" from "added late" locally, without growing the issue buckets.
 */
export const items = ownerQuery({
  args: { sprintId: v.id('sprints') },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query('sprintItems')
      .withIndex('by_sprint', (q) => q.eq('sprintId', args.sprintId))
      .take(2000);
    return entries.map((e) => ({
      _id: e._id,
      issueId: e.issueId,
      kind: e.kind,
      carriedFrom: e.carriedFrom ?? null,
      addedAt: e.addedAt,
      addedBy: e.addedBy,
      removedAt: e.removedAt ?? null,
      outcome: e.outcome ?? null,
    }));
  },
});

export const capacitySuggestion = ownerQuery({
  args: {},
  handler: async (ctx) => await ops.capacitySuggestion(ctx),
});

export const create = ownerWriteMutation({
  args: {
    name: v.optional(v.string()),
    goal: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    capacity: v.optional(v.number()),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.createSprint(ctx, ctx.actor, args),
});

export const update = ownerWriteMutation({
  args: {
    sprintId: v.id('sprints'),
    name: v.optional(v.string()),
    goal: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    capacity: v.optional(v.union(v.number(), v.null())),
    retro: v.optional(v.string()),
  },
  handler: async (ctx, args) => await ops.updateSprint(ctx, ctx.actor, args),
});

export const add = ownerWriteMutation({
  args: { sprintId: v.id('sprints'), issueIds: v.array(v.id('issues')), ...requestIdArg },
  handler: async (ctx, args) => await ops.addToSprint(ctx, ctx.actor, args),
});

export const remove = ownerWriteMutation({
  args: { sprintId: v.id('sprints'), issueIds: v.array(v.id('issues')), ...requestIdArg },
  handler: async (ctx, args) => await ops.removeFromSprint(ctx, ctx.actor, args),
});

export const start = ownerWriteMutation({
  args: { sprintId: v.id('sprints') },
  handler: async (ctx, args) => await ops.startSprint(ctx, ctx.actor, args),
});

export const close = ownerWriteMutation({
  args: {
    sprintId: v.id('sprints'),
    decisions: v.array(sprintDecisionValidator),
    nextSprintId: v.optional(v.id('sprints')),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.closeSprint(ctx, ctx.actor, args),
});
