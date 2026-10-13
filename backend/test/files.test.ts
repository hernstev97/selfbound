import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { DAY_MS } from '../convex/lib/dates';
import { checkImage, sniffImage } from '../convex/lib/image';
import { NEW_FILE_GRACE_MS, sweepFiles, UNREFERENCED_GRACE_MS } from '../convex/ops/files';
import { purgeTrash } from '../convex/ops/issues';
import { imageTokens, LIMITS } from '../convex/shared/constants';
import { createOne, expectCode, fixture, setup, type Client, type T } from './helpers';

// Images: checks on upload, delivery through /img/<token>, references and cleanup.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00;');
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 26, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8L'), 0, 0, 0, 0]);

async function upload(t: T, bytes: Uint8Array<ArrayBuffer> | string, type: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes], { type })));
}

async function register(t: T, owner: Client, bytes: Uint8Array<ArrayBuffer> | string = PNG, type = 'image/png') {
  const storageId = await upload(t, bytes, type);
  const result = await owner.action(api.files.register, { storageId });
  const token = result.url.split('/img/')[1];
  return { ...result, storageId, token };
}

async function fileOf(t: T, token: string) {
  return await t.run(async (ctx) => await ctx.db.query('files').withIndex('by_token', (q) => q.eq('token', token)).unique());
}

async function storageExists(t: T, id: Id<'_storage'>) {
  return await t.run(async (ctx) => (await ctx.db.system.get('_storage', id)) !== null);
}

const sweep = (t: T, now: number) => t.run(async (ctx) => await sweepFiles(ctx, now));

describe('Checks', () => {
  test('detects PNG, JPEG, GIF, WebP by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  test('rejects wrong types, wrong declared types, empty and oversized files', () => {
    expect(checkImage(PNG, PNG.length, 'image/png')).toEqual({ ok: true, contentType: 'image/png' });
    expect(checkImage(PNG, PNG.length, null)).toEqual({ ok: true, contentType: 'image/png' });
    expect(checkImage(PNG, PNG.length, 'image/jpeg').ok).toBe(false);
    expect(checkImage(PNG, PNG.length, 'image/svg+xml').ok).toBe(false);
    expect(checkImage(new TextEncoder().encode('<html>'), 6, 'image/png').ok).toBe(false);
    expect(checkImage(PNG, 0, 'image/png').ok).toBe(false);
    expect(checkImage(PNG, LIMITS.imageMaxBytes + 1, 'image/png')).toMatchObject({ ok: false, reason: expect.stringContaining('too large') });
  });

  test('imageTokens finds tokens regardless of the host', () => {
    const a = 'A'.repeat(43);
    const b = `${'b'.repeat(42)}_`;
    const text = `![x](https://x.convex.site/img/${a}) and ![y](http://127.0.0.1:13611/img/${b}?v=1) /img/too-short /img/${'c'.repeat(44)}`;
    expect([...imageTokens(text)]).toEqual([a, b]);
    expect(imageTokens('no image').size).toBe(0);
  });
});

describe('Upload and delivery', () => {
  test('register returns an /img address with an unguessable token; the endpoint sets type, CSP, nosniff', async () => {
    const { t, owner } = setup();
    const { url, token, contentType } = await register(t, owner, WEBP, 'image/webp');
    expect(contentType).toBe('image/webp');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:3211\/img\/[A-Za-z0-9_-]{43}$/);
    const response = await t.fetch(`/img/${token}`, { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBP);
    // Unknown tokens, garbage and raw storage IDs → 404.
    expect((await t.fetch(`/img/${'x'.repeat(43)}`, { method: 'GET' })).status).toBe(404);
    expect((await t.fetch('/img/broken', { method: 'GET' })).status).toBe(404);
    const other = await upload(t, PNG, 'image/png');
    expect((await t.fetch(`/img/${other}`, { method: 'GET' })).status).toBe(404);
  });

  // Content ≠ declared type is covered by the unit test above: convex-test stores no content type.
  test('rejected files are deleted and not registered', async () => {
    const { t, owner } = setup();
    for (const [bytes, type] of [
      ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'],
      ['<html><script>alert(1)</script></html>', 'image/png'],
      [new Uint8Array(LIMITS.imageMaxBytes + 1), 'image/png'],
    ] as const) {
      const storageId = await upload(t, bytes, type);
      await expectCode(owner.action(api.files.register, { storageId }), 'invalid');
      expect(await storageExists(t, storageId)).toBe(false);
    }
    expect(await t.run(async (ctx) => await ctx.db.query('files').collect())).toHaveLength(0);
  });

  test('only the owner uploads; the test switch rejects', async () => {
    const { t, owner, stranger } = setup();
    await expectCode(stranger.mutation(api.files.generateUploadUrl, {}), 'access_denied');
    const storageId = await upload(t, PNG, 'image/png');
    await expectCode(stranger.action(api.files.register, { storageId }), 'access_denied');
    await owner.mutation(api.admin.setRejectWrites, { value: true });
    await expectCode(owner.mutation(api.files.generateUploadUrl, {}), 'rejected');
    await expectCode(owner.action(api.files.register, { storageId }), 'rejected');
    expect(await storageExists(t, storageId)).toBe(false);
  });
});

describe('References and cleanup', () => {
  test('freshly uploaded without a reference: gone after 7 days', async () => {
    const { t, owner } = setup();
    const { token, storageId } = await register(t, owner);
    const now = Date.now();
    expect(await sweep(t, now + NEW_FILE_GRACE_MS - DAY_MS)).toMatchObject({ deleted: 0 });
    expect(await sweep(t, now + NEW_FILE_GRACE_MS + 1000)).toMatchObject({ deleted: 1 });
    expect(await fileOf(t, token)).toBeNull();
    expect(await storageExists(t, storageId)).toBe(false);
    expect((await t.fetch(`/img/${token}`, { method: 'GET' })).status).toBe(404);
  });

  test('description: image stays while referenced; removed → gone after a day; added back → stays', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { url, token, storageId } = await register(t, owner);
    const issue = await createOne(owner, f.orb, { description: `Before\n\n![Screenshot](${url})` });
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    expect(await sweep(t, Date.now() + 30 * DAY_MS)).toMatchObject({ deleted: 0 });

    const r1 = await owner.mutation(api.issues.setDescription, { id: issue.id, markdown: 'No image', baseVersion: 1 });
    const removedAt = Date.now();
    expect((await fileOf(t, token))?.deleteAfter).toBeGreaterThanOrEqual(removedAt + UNREFERENCED_GRACE_MS - 5000);
    // Undo within the grace period: reference is back, file stays.
    await owner.mutation(api.issues.setDescription, { id: issue.id, markdown: `![Screenshot](${url})`, baseVersion: r1.version });
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    expect(await sweep(t, removedAt + 2 * DAY_MS)).toMatchObject({ deleted: 0 });

    await owner.mutation(api.issues.setDescription, { id: issue.id, markdown: '', baseVersion: r1.version + 1 });
    expect(await sweep(t, Date.now() + UNREFERENCED_GRACE_MS - 60_000)).toMatchObject({ deleted: 0 });
    expect(await sweep(t, Date.now() + UNREFERENCED_GRACE_MS + 60_000)).toMatchObject({ deleted: 1 });
    expect(await storageExists(t, storageId)).toBe(false);
  });

  test('the same image in two places: deleted only once both are gone', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { url, token } = await register(t, owner);
    const a = await createOne(owner, f.orb, { description: `![a](${url})` });
    const b = await createOne(owner, f.nova);
    const { commentId } = await owner.mutation(api.comments.add, { issueId: b.id, body: `See ![a](${url})` });
    await owner.mutation(api.issues.setDescription, { id: a.id, markdown: 'gone', baseVersion: 1 });
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    // Edit the comment (without image) → now unreferenced.
    await owner.mutation(api.comments.edit, { commentId, body: 'Image removed' });
    expect((await fileOf(t, token))?.deleteAfter).toBeDefined();
    await owner.mutation(api.comments.edit, { commentId, body: `back again ![a](${url})` });
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    await owner.mutation(api.comments.remove, { commentId });
    expect((await fileOf(t, token))?.deleteAfter).toBeDefined();
  });

  test('permanently deleted issue: images from description and comments disappear', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const one = await register(t, owner);
    const two = await register(t, owner, JPEG, 'image/jpeg');
    const issue = await createOne(owner, f.orb, { description: `![1](${one.url})` });
    await owner.mutation(api.comments.add, { issueId: issue.id, body: `![2](${two.url})` });
    await owner.mutation(api.issues.remove, { ids: [issue.id] });
    // Images stay while the issue is in the trash (it can be restored).
    expect(await sweep(t, Date.now() + 20 * DAY_MS)).toMatchObject({ deleted: 0 });
    const purgeAt = Date.now() + 31 * DAY_MS;
    expect(await t.run(async (ctx) => await purgeTrash(ctx, purgeAt))).toMatchObject({ purged: 1 });
    expect(await t.run(async (ctx) => await ctx.db.query('fileRefs').collect())).toHaveLength(0);
    expect(await sweep(t, purgeAt + UNREFERENCED_GRACE_MS + 60_000)).toMatchObject({ deleted: 2 });
    expect(await storageExists(t, one.storageId)).toBe(false);
    expect(await storageExists(t, two.storageId)).toBe(false);
  });

  test('recurrences keep their images; issues created from them reference them too', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { url, token } = await register(t, owner);
    const { recurrenceId } = await owner.mutation(api.recurrences.create, {
      teamId: f.orb,
      title: 'Weekly',
      description: `![x](${url})`,
      cadence: 'weekly',
      weekday: 1,
    });
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    await owner.mutation(api.recurrences.update, { recurrenceId, description: null });
    expect((await fileOf(t, token))?.deleteAfter).toBeDefined();
    await owner.mutation(api.recurrences.update, { recurrenceId, description: `![x](${url})` });
    await owner.mutation(api.recurrences.remove, { recurrenceId });
    expect((await fileOf(t, token))?.deleteAfter).toBeDefined();
  });

  test('the cron run reschedules itself for many files; the ops page counts storage', async () => {
    const { t, owner } = setup();
    const a = await register(t, owner);
    await register(t, owner, GIF, 'image/gif');
    const status = await owner.query(api.ops.status, {});
    expect(status.storage).toMatchObject({ files: 2, images: 2, orphaned: 2, capped: false });
    expect(status.storage.bytes).toBe(PNG.length + GIF.length);
    expect(status.storage.imageBytes).toBe(PNG.length + GIF.length);
    await t.mutation(internal.files.sweep, {});
    expect(await fileOf(t, a.token)).not.toBeNull();
  });
});
