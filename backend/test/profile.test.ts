import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { DAY_MS } from '../convex/lib/dates';
import { sweepFiles, UNREFERENCED_GRACE_MS } from '../convex/ops/files';
import { LIMITS } from '../convex/shared/constants';
import { expectCode, setup, type Client, type T } from './helpers';

// Profile: display name and picture of the owner, shown through meta.get (`owner`).

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 26, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8L'), 0, 0, 0, 0]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00;');

async function register(t: T, owner: Client, bytes: Uint8Array<ArrayBuffer> = PNG, type = 'image/png') {
  const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes], { type })));
  const result = await owner.action(api.files.register, { storageId });
  return { ...result, storageId, token: result.url.split('/img/')[1]! };
}

const profileOf = async (owner: Client) => (await owner.query(api.meta.get, {})).owner;

describe('profile', () => {
  test('empty until set; name is trimmed, collapsed and can be cleared', async () => {
    const { owner } = setup();
    expect(await profileOf(owner)).toEqual({ name: null, avatarUrl: null });
    expect(await owner.mutation(api.profile.setName, { name: '  Jane   Q.  Doe ' })).toEqual({ name: 'Jane Q. Doe' });
    expect((await profileOf(owner)).name).toBe('Jane Q. Doe');
    await owner.mutation(api.profile.setName, { name: '   ' });
    expect((await profileOf(owner)).name).toBeNull();
    await owner.mutation(api.profile.setName, { name: 'Jane' });
    await owner.mutation(api.profile.setName, { name: null });
    expect((await profileOf(owner)).name).toBeNull();
  });

  test('rejects names that are too long or contain control characters', async () => {
    const { owner } = setup();
    await expectCode(owner.mutation(api.profile.setName, { name: 'x'.repeat(LIMITS.profileNameMax + 1) }), 'invalid');
    await expectCode(owner.mutation(api.profile.setName, { name: 'a\nb' }), 'invalid');
    await owner.mutation(api.profile.setName, { name: 'x'.repeat(LIMITS.profileNameMax) });
  });

  test('sets the picture from a registered image, serves it and keeps the name', async () => {
    const { t, owner } = setup();
    await owner.mutation(api.profile.setName, { name: 'Jane' });
    const { token, url } = await register(t, owner);
    expect(await owner.mutation(api.profile.setAvatar, { token })).toEqual({ avatarUrl: url });
    expect(await profileOf(owner)).toEqual({ name: 'Jane', avatarUrl: url });
    // The picture is referenced, so it stays beyond the grace period for fresh uploads.
    const file = await t.run(async (ctx) => await ctx.db.query('files').withIndex('by_token', (q) => q.eq('token', token)).unique());
    expect(file?.deleteAfter).toBeUndefined();
  });

  test('rejects unknown tokens, GIFs and pictures over the size limit', async () => {
    const { t, owner } = setup();
    await expectCode(owner.mutation(api.profile.setAvatar, { token: 'nope' }), 'invalid');
    await expectCode(owner.mutation(api.profile.setAvatar, { token: 'A'.repeat(43) }), 'invalid');
    const gif = await register(t, owner, GIF as Uint8Array<ArrayBuffer>, 'image/gif');
    await expectCode(owner.mutation(api.profile.setAvatar, { token: gif.token }), 'invalid');
    const big = await register(t, owner);
    await t.run(async (ctx) => {
      const file = await ctx.db.query('files').withIndex('by_token', (q) => q.eq('token', big.token)).unique();
      await ctx.db.patch('files', file!._id, { size: LIMITS.avatarMaxBytes + 1 });
    });
    await expectCode(owner.mutation(api.profile.setAvatar, { token: big.token }), 'invalid');
    expect((await profileOf(owner)).avatarUrl).toBeNull();
  });

  test('a replaced or removed picture is swept after the grace period, the current one stays', async () => {
    const { t, owner } = setup();
    const first = await register(t, owner);
    await owner.mutation(api.profile.setAvatar, { token: first.token });
    const second = await register(t, owner, WEBP as Uint8Array<ArrayBuffer>, 'image/webp');
    await owner.mutation(api.profile.setAvatar, { token: second.token });
    const later = Date.now() + UNREFERENCED_GRACE_MS + DAY_MS;
    await t.run(async (ctx) => await sweepFiles(ctx, later));
    const exists = async (id: typeof first.storageId) => await t.run(async (ctx) => (await ctx.db.system.get('_storage', id)) !== null);
    expect(await exists(first.storageId)).toBe(false);
    expect(await exists(second.storageId)).toBe(true);
    expect((await profileOf(owner)).avatarUrl).toBe(second.url);

    expect(await owner.mutation(api.profile.removeAvatar, {})).toEqual({ avatarUrl: null });
    expect((await profileOf(owner)).avatarUrl).toBeNull();
    await t.run(async (ctx) => await sweepFiles(ctx, later + 2 * DAY_MS));
    expect(await exists(second.storageId)).toBe(false);
    // Removing again is harmless
    await owner.mutation(api.profile.removeAvatar, {});
  });

  test('only the owner may change it', async () => {
    const { stranger } = setup();
    await expectCode(stranger.mutation(api.profile.setName, { name: 'Eve' }), 'access_denied');
    await expectCode(stranger.mutation(api.profile.removeAvatar, {}), 'access_denied');
  });
});
