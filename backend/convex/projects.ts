import { v } from 'convex/values';
import { ownerWriteMutation } from './lib/auth';
import * as ops from './ops/teams';
import { projectStateValidator } from './schema';

// Each project belongs to exactly one team. Goal, "ready when", period and color are for the
// roadmap (SELF-113); null or an empty text clears them.

const roadmapFields = {
  description: v.optional(v.union(v.string(), v.null())),
  readyWhen: v.optional(v.union(v.string(), v.null())),
  period: v.optional(v.union(v.string(), v.null())), // "2027-Q1" or "2027-03"
  hue: v.optional(v.union(v.number(), v.null())),
};

export const create = ownerWriteMutation({
  args: { teamId: v.id('teams'), name: v.string(), state: v.optional(projectStateValidator), ...roadmapFields },
  handler: async (ctx, args) => await ops.createProject(ctx, ctx.actor, args),
});

export const update = ownerWriteMutation({
  args: { projectId: v.id('projects'), name: v.optional(v.string()), state: v.optional(projectStateValidator), ...roadmapFields },
  handler: async (ctx, args) => await ops.updateProject(ctx, ctx.actor, args),
});

export const reorder = ownerWriteMutation({
  args: { teamId: v.id('teams'), projectIds: v.array(v.id('projects')) },
  handler: async (ctx, args) => await ops.reorderProjects(ctx, ctx.actor, args),
});
