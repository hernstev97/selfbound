import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { OWNER_ACTOR, ownerWriteMutation } from './lib/auth';
import * as ops from './ops/workflow';
import { stateTypeValidator } from './schema';

// Configure the workflow states of a team. Owner only; the rules live in ops/workflow.ts.

export const create = ownerWriteMutation({
  args: { teamId: v.id('teams'), name: v.string(), type: stateTypeValidator, color: v.optional(v.string()), description: v.optional(v.string()) },
  handler: async (ctx, args) => await ops.createState(ctx, ctx.actor, args),
});

/** `null` for color resets it to the default; `null` for description clears it. */
export const update = ownerWriteMutation({
  args: {
    stateId: v.id('workflowStates'),
    name: v.optional(v.string()),
    color: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => await ops.updateState(ctx, ctx.actor, args),
});

/** Order within one type. */
export const reorder = ownerWriteMutation({
  args: { teamId: v.id('teams'), stateIds: v.array(v.id('workflowStates')) },
  handler: async (ctx, args) => await ops.reorderStates(ctx, ctx.actor, args),
});

/** Archive; issues in the state move to `moveTo` (more than 200: the rest in the background). */
export const archive = ownerWriteMutation({
  args: { stateId: v.id('workflowStates'), moveTo: v.optional(v.id('workflowStates')) },
  handler: async (ctx, args) => {
    const result = await ops.archiveState(ctx, ctx.actor, args);
    if (result.more) await ctx.scheduler.runAfter(0, internal.workflowStates.archiveRest, { ...args, moveTo: args.moveTo! });
    return result;
  },
});

export const archiveRest = internalMutation({
  args: { stateId: v.id('workflowStates'), moveTo: v.id('workflowStates') },
  handler: async (ctx, args) => {
    const result = await ops.archiveState(ctx, OWNER_ACTOR, args);
    if (result.more) await ctx.scheduler.runAfter(0, internal.workflowStates.archiveRest, args);
    return result;
  },
});

export const restore = ownerWriteMutation({
  args: { stateId: v.id('workflowStates') },
  handler: async (ctx, args) => await ops.restoreState(ctx, ctx.actor, args),
});

/** A team's default state, strict order and exceptions. */
export const setWorkflow = ownerWriteMutation({
  args: {
    teamId: v.id('teams'),
    strict: v.optional(v.boolean()),
    exceptions: v.optional(v.array(v.object({ from: v.id('workflowStates'), to: v.id('workflowStates') }))),
    defaultStateId: v.optional(v.union(v.id('workflowStates'), v.null())),
  },
  handler: async (ctx, args) => await ops.setWorkflow(ctx, ctx.actor, args),
});
