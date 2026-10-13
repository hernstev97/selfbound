import { v } from 'convex/values';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { cadenceValidator } from './lib/validators';
import * as ops from './ops/recurrences';
import { priorityValidator } from './schema';

export const list = ownerQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query('recurrences').take(500),
});

/** weekly: weekday 1 (Monday) … 7 (Sunday); monthly: monthDay 1–28. First occurrence from startDate, or today. */
export const create = ownerWriteMutation({
  args: {
    teamId: v.id('teams'),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    labelIds: v.optional(v.array(v.id('labels'))),
    projectId: v.optional(v.id('projects')),
    estimate: v.optional(v.number()),
    cadence: cadenceValidator,
    weekday: v.optional(v.number()),
    monthDay: v.optional(v.number()),
    startDate: v.optional(v.string()),
    sourceIssueId: v.optional(v.id('issues')),
  },
  handler: async (ctx, args) => await ops.createRecurrence(ctx, ctx.actor, args),
});

export const update = ownerWriteMutation({
  args: {
    recurrenceId: v.id('recurrences'),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    priority: v.optional(priorityValidator),
    labelIds: v.optional(v.array(v.id('labels'))),
    projectId: v.optional(v.union(v.id('projects'), v.null())),
    estimate: v.optional(v.union(v.number(), v.null())),
    cadence: v.optional(cadenceValidator),
    weekday: v.optional(v.union(v.number(), v.null())),
    monthDay: v.optional(v.union(v.number(), v.null())),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => await ops.updateRecurrence(ctx, ctx.actor, args),
});

export const remove = ownerWriteMutation({
  args: { recurrenceId: v.id('recurrences') },
  handler: async (ctx, args) => await ops.removeRecurrence(ctx, ctx.actor, args),
});
