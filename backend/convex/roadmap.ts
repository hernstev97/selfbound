import { v } from 'convex/values';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { idempotent } from './lib/idempotency';
import { requestIdArg } from './lib/validators';
import * as ops from './ops/roadmap';
import { stageMappingValidator } from './schema';

// Roadmap and progress per team (SELF-113). The page reads the issues from the store; only the public
// cards (title, summary, image of public issues) come from here.

/** Public cards of a team's issues: `[{ issueId, title, summary, image }]` (image = URL or null). */
export const cards = ownerQuery({
  args: { teamId: v.id('teams') },
  handler: async (ctx, { teamId }) => await ops.cardsOfTeam(ctx, teamId),
});

/** Public card of one issue. Only the given fields change; null clears one. */
export const setCard = ownerWriteMutation({
  args: {
    id: v.id('issues'),
    title: v.optional(v.union(v.string(), v.null())),
    summary: v.optional(v.union(v.string(), v.null())),
    image: v.optional(v.union(v.string(), v.null())),
    ...requestIdArg,
  },
  handler: async (ctx, args) =>
    await idempotent(ctx, ctx.actor, args.requestId, 'roadmap.setCard', { ...args }, async () => {
      const { requestId, ...patch } = args;
      return await ops.setPublicCard(ctx, ctx.actor, patch, Date.now(), requestId);
    }),
});

/** A team's roadmap settings (on, category group, stages, export branding); only the given fields. */
export const updateSettings = ownerWriteMutation({
  args: {
    teamId: v.id('teams'),
    on: v.optional(v.boolean()),
    categoryGroupId: v.optional(v.union(v.id('labelGroups'), v.null())),
    stages: v.optional(v.array(stageMappingValidator)),
    title: v.optional(v.union(v.string(), v.null())),
    subtitle: v.optional(v.union(v.string(), v.null())),
    accent: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => await ops.updateRoadmapSettings(ctx, ctx.actor, args),
});
