import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import { ownerAction, ownerWriteMutation } from './lib/auth';
import { invalid, notFound } from './lib/errors';
import { checkLogo } from './lib/logo';
import { assertWritable } from './lib/testSwitches';
import { logoVariantValidator } from './lib/validators';
import * as ops from './ops/teams';
import { actorValidator } from './schema';
import { LIMITS } from './shared/constants';

// Teams and team logos. Only the owner (actor kind OWNER_KIND) changes teams and logos; the check
// lives in ops/teams.ts, so it also covers any later MCP path.

export const create = ownerWriteMutation({
  args: {
    key: v.string(),
    name: v.string(),
    hue: v.optional(v.number()),
    dormant: v.optional(v.boolean()),
    wiki: v.optional(v.union(v.literal('on'), v.literal('only'))),
  },
  handler: async (ctx, args) => await ops.createTeam(ctx, ctx.actor, args),
});

/**
 * The key can only change while the team has no issues. `dormant` = inactive team.
 * `wiki`: 'on' = knowledge base next to the issues, 'only' = knowledge base only (only without open
 * issues and active recurrences), null = none (only without pages).
 */
export const update = ownerWriteMutation({
  args: {
    teamId: v.id('teams'),
    key: v.optional(v.string()),
    name: v.optional(v.string()),
    hue: v.optional(v.number()),
    dormant: v.optional(v.boolean()),
    wiki: v.optional(v.union(v.literal('on'), v.literal('only'), v.null())),
  },
  handler: async (ctx, args) => await ops.updateTeam(ctx, ctx.actor, args),
});

export const reorder = ownerWriteMutation({
  args: { teamIds: v.array(v.id('teams')) },
  handler: async (ctx, args) => await ops.reorderTeams(ctx, ctx.actor, args),
});

/** Logo upload step 1: get an upload URL, POST the file to it → storageId. */
export const generateLogoUploadUrl = ownerWriteMutation({
  args: {},
  handler: async (ctx) => {
    ops.assertCanManageLogos(ctx.actor);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Step 2: check the uploaded file and set it as the logo. Allowed: SVG or PNG, square, at most
 * 256 KB, SVG without scripts, event attributes, javascript:, foreignObject and external
 * references. Rejected files are deleted.
 */
export const setLogo = ownerAction({
  args: { teamId: v.id('teams'), storageId: v.id('_storage'), variant: logoVariantValidator },
  handler: async (ctx, args): Promise<{ teamId: string; contentType: string }> => {
    ops.assertCanManageLogos(ctx.actor);
    const meta = await ctx.runQuery(internal.teams.storageMeta, { storageId: args.storageId });
    if (!meta) notFound('The uploaded file');
    const reject = async (reason: string): Promise<never> => {
      await ctx.storage.delete(args.storageId);
      return invalid(reason);
    };
    if (meta.size > LIMITS.logoMaxBytes) {
      return await reject(`The logo is too large (at most ${LIMITS.logoMaxBytes / 1024} KB).`);
    }
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) notFound('The uploaded file');
    const check = checkLogo(new Uint8Array(await blob.arrayBuffer()), meta.contentType);
    if (!check.ok) return await reject(check.reason);
    try {
      await ctx.runMutation(internal.teams.applyLogo, {
        teamId: args.teamId,
        storageId: args.storageId,
        variant: args.variant,
        contentType: check.contentType,
        actor: ctx.actor,
      });
    } catch (error) {
      // Don't leave an orphaned upload behind (e.g. the team was deleted).
      await ctx.storage.delete(args.storageId);
      throw error;
    }
    return { teamId: args.teamId, contentType: check.contentType };
  },
});

export const removeLogo = ownerWriteMutation({
  args: { teamId: v.id('teams'), variant: logoVariantValidator },
  handler: async (ctx, args) => await ops.removeTeamLogo(ctx, ctx.actor, args),
});

/** Internal: storage metadata (size, content type) for the logo check. */
export const storageMeta = internalQuery({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const meta = await ctx.db.system.get('_storage', args.storageId);
    if (!meta) return null;
    return { size: meta.size, contentType: meta.contentType ?? null };
  },
});

/**
 * Internal, for GET /logo/<storageId>: only files a team uses as its logo (light or dark).
 * Otherwise null, so the endpoint does not serve arbitrary uploads.
 */
export const logoFile = internalQuery({
  args: { storageId: v.string() },
  handler: async (ctx, args) => {
    const storageId = ctx.db.system.normalizeId('_storage', args.storageId);
    if (!storageId) return null;
    const teams = await ctx.db.query('teams').take(500);
    if (!teams.some((t) => t.logoId === storageId || t.logoDarkId === storageId)) return null;
    const meta = await ctx.db.system.get('_storage', storageId);
    return meta ? { storageId, contentType: meta.contentType ?? null } : null;
  },
});

/** Internal: set a checked logo. The actor comes from the action's verified identity. */
export const applyLogo = internalMutation({
  args: {
    teamId: v.id('teams'),
    storageId: v.id('_storage'),
    variant: logoVariantValidator,
    contentType: v.string(),
    actor: actorValidator,
  },
  handler: async (ctx, { actor, ...args }) => {
    await assertWritable(ctx);
    return await ops.setTeamLogo(ctx, actor, args);
  },
});
