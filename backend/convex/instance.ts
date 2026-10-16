import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { ownerWriteMutation } from './lib/auth';
import * as ops from './ops/instance';
import { priorityLimitsValidator } from './schema';

// Instance settings. Reading goes through meta.get (`timeZone`, null = not set yet;
// `priorityLimits`, always complete), so there is no extra subscription.

/**
 * Time zone of the instance (IANA name). The app calls this once at the first sign-in with the
 * browser's zone with `ifUnset` (so a stale cache or a second device never overwrites a choice);
 * afterwards the owner changes it in the settings.
 */
export const setTimeZone = ownerWriteMutation({
  args: { timeZone: v.string(), ifUnset: v.optional(v.boolean()) },
  handler: async (ctx, args) => await ops.setTimeZone(ctx, ctx.actor, args),
});

/** Open urgent/high issues per team: `max` (null = no limit) and `hard` (reject instead of warn). */
export const setPriorityLimits = ownerWriteMutation({
  args: { limits: priorityLimitsValidator },
  handler: async (ctx, args) => await ops.setPriorityLimits(ctx, ctx.actor, args.limits),
});

/** For the MCP endpoint (an HTTP action has no database access of its own). */
export const timeZone = internalQuery({
  args: {},
  handler: async (ctx) => await ops.timeZoneOf(ctx),
});
