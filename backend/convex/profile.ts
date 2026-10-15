import { v } from 'convex/values';
import { ownerWriteMutation } from './lib/auth';
import * as ops from './ops/profile';

// The owner's profile (name and picture). Reading goes through meta.get (`owner`), so there is no
// extra subscription. Upload of the picture: files.generateUploadUrl → POST → files.register →
// profile.setAvatar with the token from the returned URL.

/** Display name; `null` or empty clears it. */
export const setName = ownerWriteMutation({
  args: { name: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => await ops.setName(ctx, ctx.actor, args),
});

/** Picture: the token of an image registered with files.register (PNG, JPEG or WebP, at most 256 KB). */
export const setAvatar = ownerWriteMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => await ops.setAvatar(ctx, ctx.actor, args),
});

export const removeAvatar = ownerWriteMutation({
  args: {},
  handler: async (ctx) => await ops.removeAvatar(ctx, ctx.actor),
});
