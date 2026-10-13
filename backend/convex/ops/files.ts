import type { MutationCtx, QueryCtx } from '../_generated/server';
import { DAY_MS } from '../lib/dates';
import { imageTokens } from '../shared/constants';

// Images: maintain references and clean up orphaned files.
//
// Every text that can contain images (description, comment, earlier revision of a
// description, recurrence template) reports itself on every write via
// `syncFileRefs(ctx, owner, text)` and on delete with `text = null`. That way the backend
// knows, without searching all texts, whether an image is still used anywhere, even if the
// same image was copied into several issues.
//
// A file without references gets `deleteAfter`; the `sweep-files` cron deletes it after
// that. If a reference comes back first (undo, text pasted again), the file stays.

/** Freshly uploaded, not saved anywhere yet (e.g. in a draft in the browser). */
export const NEW_FILE_GRACE_MS = 7 * DAY_MS;
/** Removed from the last text (undo stays possible for one day). */
export const UNREFERENCED_GRACE_MS = 1 * DAY_MS;

async function fileByToken(ctx: QueryCtx, token: string) {
  return await ctx.db
    .query('files')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();
}

/**
 * Syncs the image references of a text. `owner` = ID of the document that holds the text;
 * `text = null` means the text is gone (deleted, removed). Unknown tokens (other
 * deployments, typos) are ignored.
 */
export async function syncFileRefs(ctx: MutationCtx, owner: string, text: string | null, now = Date.now()) {
  const wanted = text ? imageTokens(text) : new Set<string>();
  const existing = await ctx.db
    .query('fileRefs')
    .withIndex('by_owner', (q) => q.eq('owner', owner))
    .collect();
  if (wanted.size === 0 && existing.length === 0) return;
  const have = new Set(existing.map((r) => r.token));
  for (const ref of existing) {
    if (wanted.has(ref.token)) continue;
    await ctx.db.delete('fileRefs', ref._id);
    const other = await ctx.db
      .query('fileRefs')
      .withIndex('by_token', (q) => q.eq('token', ref.token))
      .first();
    if (other) continue;
    const file = await fileByToken(ctx, ref.token);
    if (file && file.deleteAfter === undefined) await ctx.db.patch('files', file._id, { deleteAfter: now + UNREFERENCED_GRACE_MS });
  }
  for (const token of wanted) {
    if (have.has(token)) continue;
    const file = await fileByToken(ctx, token);
    if (!file) continue;
    await ctx.db.insert('fileRefs', { token, owner });
    if (file.deleteAfter !== undefined) await ctx.db.patch('files', file._id, { deleteAfter: undefined });
  }
}

/**
 * Deletes files whose grace period has expired and that (still) have no reference.
 * In batches; `more` = something is left.
 */
export async function sweepFiles(ctx: MutationCtx, now = Date.now(), limit = 100) {
  const due = await ctx.db
    .query('files')
    .withIndex('by_delete_after', (q) => q.gte('deleteAfter', 0).lt('deleteAfter', now))
    .take(limit);
  let deleted = 0;
  let bytes = 0;
  for (const file of due) {
    const ref = await ctx.db
      .query('fileRefs')
      .withIndex('by_token', (q) => q.eq('token', file.token))
      .first();
    if (ref) {
      await ctx.db.patch('files', file._id, { deleteAfter: undefined });
      continue;
    }
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete('files', file._id);
    deleted++;
    bytes += file.size;
  }
  return { deleted, bytes, more: due.length === limit };
}

/** Maximum files the ops page counts per table (read limit; above it the page shows "at least"). */
const USAGE_SCAN_MAX = 8000;

/**
 * Storage usage for the ops page: all files in Convex storage (images, logos, not yet
 * cleaned up), plus the images on their own and how many are waiting to be deleted.
 */
export async function storageUsage(ctx: QueryCtx) {
  let files = 0;
  let bytes = 0;
  for await (const doc of ctx.db.system.query('_storage')) {
    if (files >= USAGE_SCAN_MAX) break;
    files++;
    bytes += doc.size;
  }
  let images = 0;
  let imageBytes = 0;
  let orphaned = 0;
  for await (const file of ctx.db.query('files')) {
    if (images >= USAGE_SCAN_MAX) break;
    images++;
    imageBytes += file.size;
    if (file.deleteAfter !== undefined) orphaned++;
  }
  return { files, bytes, images, imageBytes, orphaned, capped: files >= USAGE_SCAN_MAX || images >= USAGE_SCAN_MAX };
}
