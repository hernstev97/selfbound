import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import { ownerAction, ownerWriteMutation } from './lib/auth';
import { invalid, notFound } from './lib/errors';
import { checkImage, IMAGE_TOO_LARGE, imageUrl } from './lib/image';
import { base64url } from './lib/keys';
import { assertWritable } from './lib/testSwitches';
import { NEW_FILE_GRACE_MS, sweepFiles } from './ops/files';
import { actorValidator } from './schema';
import { LIMITS } from './shared/constants';

// Images in descriptions and comments.
//
// Upload: generateUploadUrl → fetch POST (file) → register (checks it and issues the token)
// → the UI writes `![name](<url>)` into the Markdown. Served via GET /img/<token>
// (convex/http.ts). Cleanup: ops/files.ts and the cron `sweep-files`.

/** Step 1: get an upload URL. */
export const generateUploadUrl = ownerWriteMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Step 2: check the uploaded file and register it as an image. Allowed: PNG, JPEG, WebP, GIF up
 * to 5 MB, content matching the declared type. Rejected files are deleted.
 * Returns the URL for the Markdown.
 */
export const register = ownerAction({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args): Promise<{ url: string; contentType: string; size: number }> => {
    const meta = await ctx.runQuery(internal.files.storageMeta, { storageId: args.storageId });
    if (!meta) notFound('The uploaded file');
    const reject = async (reason: string): Promise<never> => {
      await ctx.storage.delete(args.storageId);
      return invalid(reason);
    };
    // Size from the metadata first: don't even read files that are too large.
    if (meta.size > LIMITS.imageMaxBytes) return await reject(IMAGE_TOO_LARGE);
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) notFound('The uploaded file');
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const check = checkImage(head, meta.size, meta.contentType);
    if (!check.ok) return await reject(check.reason);
    // Randomness only in actions (in mutations it is deterministic).
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    try {
      await ctx.runMutation(internal.files.insert, {
        token,
        storageId: args.storageId,
        contentType: check.contentType,
        size: meta.size,
        actor: ctx.actor,
      });
    } catch (error) {
      await ctx.storage.delete(args.storageId);
      throw error;
    }
    return { url: imageUrl(token), contentType: check.contentType, size: meta.size };
  },
});

/** Internal: storage metadata (size, content type) for the check. */
export const storageMeta = internalQuery({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const meta = await ctx.db.system.get('_storage', args.storageId);
    if (!meta) return null;
    return { size: meta.size, contentType: meta.contentType ?? null };
  },
});

/** Internal: register a checked image. With no reference yet, the grace period for fresh uploads applies. */
export const insert = internalMutation({
  args: { token: v.string(), storageId: v.id('_storage'), contentType: v.string(), size: v.number(), actor: actorValidator },
  handler: async (ctx, { actor, ...args }) => {
    await assertWritable(ctx);
    const now = Date.now();
    await ctx.db.insert('files', { ...args, createdAt: now, uploadedBy: actor, deleteAfter: now + NEW_FILE_GRACE_MS });
  },
});

/** Internal, for GET /img/<token>: file and checked type, otherwise null. */
export const byToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(args.token)) return null;
    const file = await ctx.db
      .query('files')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    return file ? { storageId: file.storageId, contentType: file.contentType } : null;
  },
});

/** Cron: delete orphaned images (in batches, reschedules itself). */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await sweepFiles(ctx, Date.now());
    if (result.more) await ctx.scheduler.runAfter(0, internal.files.sweep, {});
    return result;
  },
});
