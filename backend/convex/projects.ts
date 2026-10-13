import { v } from 'convex/values';
import { ownerWriteMutation } from './lib/auth';
import * as ops from './ops/teams';
import { projectStateValidator } from './schema';

// Each project belongs to exactly one team.

export const create = ownerWriteMutation({
  args: { teamId: v.id('teams'), name: v.string(), state: v.optional(projectStateValidator) },
  handler: async (ctx, args) => await ops.createProject(ctx, ctx.actor, args),
});

export const update = ownerWriteMutation({
  args: { projectId: v.id('projects'), name: v.optional(v.string()), state: v.optional(projectStateValidator) },
  handler: async (ctx, args) => await ops.updateProject(ctx, ctx.actor, args),
});

export const reorder = ownerWriteMutation({
  args: { teamId: v.id('teams'), projectIds: v.array(v.id('projects')) },
  handler: async (ctx, args) => await ops.reorderProjects(ctx, ctx.actor, args),
});
