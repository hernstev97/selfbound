import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { applyGithubDelivery } from './ops/github';

// Internal, for POST /github (convex/http.ts). The HTTP action has already checked the
// signature. Recording the delivery id and all effects run in THIS one transaction, so a
// redelivered or concurrently duplicated delivery takes effect exactly once.
export const applyDelivery = internalMutation({
  args: { deliveryId: v.string(), event: v.string(), payload: v.any() },
  handler: async (ctx, args) => await applyGithubDelivery(ctx, args),
});
