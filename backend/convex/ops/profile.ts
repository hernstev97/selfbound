import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fail, invalid } from '../lib/errors';
import { imageUrl } from '../lib/image';
import { AVATAR_TYPES, IMAGE_PATH, LIMITS, OWNER_KIND } from '../shared/constants';
import type { Actor } from '../lib/actor';
import { syncFileRefs } from './files';

// The owner's profile: display name and profile picture. One row in `profile`; a missing row or
// field means "not set" (the UI then shows "You" / initials, MCP the name from XLR8_OWNER_NAME).
//
// The picture is an ordinary registered image (files.register: type and size checked, served via
// /img/<token>). The profile references it under the owner id PROFILE_OWNER, so a replaced or removed
// picture is swept after the usual grace period.

export const PROFILE_OWNER = 'profile';

/** Same lookup for the UI (meta.get) and MCP. */
export async function profileRow(ctx: QueryCtx): Promise<Doc<'profile'> | null> {
  return await ctx.db.query('profile').first();
}

/** Name and picture URL as the UI shows them (null = not set). */
export async function ownerProfile(ctx: QueryCtx) {
  const row = await profileRow(ctx);
  return { name: row?.name ?? null, avatarUrl: row?.avatarToken ? imageUrl(row.avatarToken) : null };
}

/** Trims and collapses whitespace; returns null for an empty name. */
export function cleanName(raw: string | null): string | null {
  if (raw === null) return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  // Control and invisible format characters (zero-width, bidi overrides) would hide in a name.
  if (/[\p{Cc}\p{Cf}]/u.test(name)) invalid('The name must not contain control or invisible characters.');
  if (name.length > LIMITS.profileNameMax) invalid(`The name is too long (at most ${LIMITS.profileNameMax} characters).`);
  return name || null;
}

function assertOwner(actor: Actor) {
  if (actor.kind !== OWNER_KIND) fail('access_denied', 'Only the owner can change the profile.');
}

async function write(ctx: MutationCtx, patch: Partial<Pick<Doc<'profile'>, 'name' | 'avatarToken'>>) {
  const row = await profileRow(ctx);
  const next = { name: row?.name, avatarToken: row?.avatarToken, ...patch };
  // A cleared field is left out of the replacement.
  const value = { ...(next.name ? { name: next.name } : {}), ...(next.avatarToken ? { avatarToken: next.avatarToken } : {}), updatedAt: Date.now() };
  if (row) await ctx.db.replace('profile', row._id, value);
  else await ctx.db.insert('profile', value);
}

export async function setName(ctx: MutationCtx, actor: Actor, args: { name: string | null }) {
  assertOwner(actor);
  const name = cleanName(args.name);
  if (name !== ((await profileRow(ctx))?.name ?? null)) await write(ctx, { name: name ?? undefined });
  return { name };
}

/** Takes a registered image (token from files.register) as the profile picture. */
export async function setAvatar(ctx: MutationCtx, actor: Actor, args: { token: string }) {
  assertOwner(actor);
  if (!/^[A-Za-z0-9_-]{43}$/.test(args.token)) invalid('Unknown image.');
  const file = await ctx.db
    .query('files')
    .withIndex('by_token', (q) => q.eq('token', args.token))
    .unique();
  if (!file) invalid('Unknown image.');
  if (!(AVATAR_TYPES as readonly string[]).includes(file.contentType)) invalid('The profile picture must be a PNG, JPEG or WebP image.');
  if (file.size > LIMITS.avatarMaxBytes) invalid(`The profile picture is too large (at most ${LIMITS.avatarMaxBytes / 1024} KB).`);
  // Reference first: the previous picture loses its reference and gets its grace period.
  await syncFileRefs(ctx, PROFILE_OWNER, `${IMAGE_PATH}${args.token}`);
  await write(ctx, { avatarToken: args.token });
  return { avatarUrl: imageUrl(args.token) };
}

export async function removeAvatar(ctx: MutationCtx, actor: Actor) {
  assertOwner(actor);
  await syncFileRefs(ctx, PROFILE_OWNER, null);
  if ((await profileRow(ctx))?.avatarToken) await write(ctx, { avatarToken: undefined });
  return { avatarUrl: null };
}
