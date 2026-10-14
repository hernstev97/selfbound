import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { IMAGE_TOO_LARGE } from '../convex/lib/image';
import { TEXT_TABLES } from '../convex/linearFiles';
import { NEW_FILE_GRACE_MS } from '../convex/ops/files';
import { LIMITS } from '../convex/shared/constants';
import { linearUploadPaths, replaceLinearUploads } from '../convex/shared/linearFiles';
import { createOne, fixture, historyOf, setup, type T } from './helpers';

// Files from Linear into Selfbound storage: find, upload, rewrite, repeatable.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
const ORG = 'https://uploads.linear.app/0a1b2c3d-0000-4000-8000-000000000000';
const A = `${ORG}/aaaa1111-0000-4000-8000-000000000000/bbbb2222-0000-4000-8000-000000000000`;
const B = `${ORG}/cccc3333-0000-4000-8000-000000000000/dddd4444-0000-4000-8000-000000000000`;
const VIDEO = `${ORG}/eeee5555-0000-4000-8000-000000000000/ffff6666-0000-4000-8000-000000000000`;
const SIGNED = `${A}?signature=eyJhbGciOiJIUzI1NiJ9.eyJwYXRoIjoiLyJ9.c2ln`;
const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view';

async function store(t: T, bytes: Uint8Array<ArrayBuffer> | string, type: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes], { type })));
}

async function scanAll(t: T) {
  const refs = [];
  for (const table of TEXT_TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page: { refs: { table: string; issue: string; paths: string[] }[]; isDone: boolean; cursor: string } = await t.query(
        internal.linearFiles.scan,
        { table, cursor },
      );
      refs.push(...page.refs);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return refs;
}

async function rewriteAll(t: T, apply: boolean, external: { path: string; url: string }[] = []) {
  const docs = [];
  for (const table of TEXT_TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page: { docs: { table: string; issue: string; replaced: number; missing: number; written: boolean }[]; isDone: boolean; cursor: string } =
        await t.mutation(internal.linearFiles.rewrite, { table, cursor, apply, external });
      docs.push(...page.docs);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return docs;
}

const bodyOf = (t: T, issueId: Id<'issues'>) =>
  t.run(async (ctx) => (await ctx.db.query('issueBodies').withIndex('by_issue', (q) => q.eq('issueId', issueId)).unique())!);

describe('finding references', () => {
  test('detects images, links and signed URLs; key without query string', () => {
    const text = `![x](${SIGNED})\n[File](${B}) and <${A}#frag>\nhttps://linear.app/acme/issue/KIU-1`;
    expect(linearUploadPaths(text)).toEqual([A, B]);
    expect(linearUploadPaths('nothing from Linear')).toEqual([]);
  });

  test('replaces only references with a target; the rest stays and is reported', () => {
    const out = replaceLinearUploads(`![x](${SIGNED}) ![y](${A}) [z](${B})`, new Map([[A, 'https://new/img/1']]));
    expect(out.text).toBe(`![x](https://new/img/1) ![y](https://new/img/1) [z](${B})`);
    expect(out.replaced).toBe(2);
    expect(out.missing).toEqual([B]);
  });
});

describe('copying and rewriting', () => {
  test('upload image, rewrite texts, second run changes nothing', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { description: `Before\n\n![Screenshot](${SIGNED})\n\n![b](${B})\n\n[Video](${VIDEO})` });
    const other = await createOne(owner, f.nova);
    const { commentId } = await owner.mutation(api.comments.add, { issueId: other.id, body: `- [Attachment](${A})` });

    const found = await scanAll(t);
    expect(found.map((r) => [r.table, r.issue, r.paths.length])).toEqual([
      ['issueBodies', issue.identifier, 3],
      ['comments', other.identifier, 1],
    ]);

    // Upload A; map B to the same file afterwards (same content).
    const { url } = await t.mutation(internal.linearFiles.uploadUrl, {});
    expect(url).toBeTypeOf('string');
    const reg = await t.action(internal.linearFiles.register, { storageId: await store(t, PNG, 'image/png'), paths: [A] });
    if (!reg.ok) throw new Error(reg.reason);
    await t.mutation(internal.linearFiles.linkPaths, { token: reg.token, paths: [B] });
    expect((await t.query(internal.linearFiles.mapping, {})).files).toEqual([
      { path: A, token: reg.token },
      { path: B, token: reg.token },
    ]);

    // Dry run writes nothing.
    const before = await bodyOf(t, issue.id);
    const dry = await rewriteAll(t, false, [{ path: VIDEO, url: DRIVE }]);
    expect(dry.map((d) => [d.issue, d.replaced, d.missing, d.written])).toEqual([
      [issue.identifier, 3, 0, false],
      [other.identifier, 1, 0, false],
    ]);
    expect((await bodyOf(t, issue.id)).version).toBe(before.version);

    const applied = await rewriteAll(t, true, [{ path: VIDEO, url: DRIVE }]);
    expect(applied.every((d) => d.written)).toBe(true);
    const body = await bodyOf(t, issue.id);
    expect(body.version).toBe(before.version + 1);
    expect(body.updatedBy).toEqual({ kind: 'import' });
    expect(body.markdown).toBe(`Before\n\n![Screenshot](${reg.url})\n\n![b](${reg.url})\n\n[Video](${DRIVE})`);
    const comment = await t.run(async (ctx) => (await ctx.db.get('comments', commentId))!);
    expect(comment.body).toBe(`- [Attachment](${reg.url})`);
    expect(comment.editedAt).toBeUndefined();
    const bodySearch = await t.run(async (ctx) => await ctx.db.query('bodySearch').withIndex('by_issue', (q) => q.eq('issueId', issue.id)).unique());
    expect(bodySearch?.text).toBe(body.markdown);

    // The file now has references (description and comment) and no deletion deadline.
    const refs = await t.run(async (ctx) => await ctx.db.query('fileRefs').withIndex('by_token', (q) => q.eq('token', reg.token)).collect());
    expect(refs.map((r) => r.owner).sort()).toEqual([body._id, commentId].sort());
    const file = await t.run(async (ctx) => await ctx.db.query('files').withIndex('by_token', (q) => q.eq('token', reg.token)).unique());
    expect(file?.deleteAfter).toBeUndefined();
    expect(file?.uploadedBy).toEqual({ kind: 'import' });

    // History: one entry each with actor import.
    expect((await historyOf(t, issue.id)).filter((h) => h.field === 'description').at(-1)?.actor).toEqual({ kind: 'import' });
    expect((await historyOf(t, other.id)).filter((h) => h.field === 'comment_edited')).toHaveLength(1);

    // Second run: nothing left to find, nothing written.
    expect(await scanAll(t)).toEqual([]);
    expect(await rewriteAll(t, true, [{ path: VIDEO, url: DRIVE }])).toEqual([]);
    expect((await bodyOf(t, issue.id)).version).toBe(body.version);
  });

  test('without a target the reference stays; deleted comments stay untouched', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { description: `![a](${A})` });
    const { commentId } = await owner.mutation(api.comments.add, { issueId: issue.id, body: `![a](${A})` });
    await owner.mutation(api.comments.remove, { commentId });

    const dry = await rewriteAll(t, true);
    expect(dry.map((d) => [d.table, d.replaced, d.missing, d.written])).toEqual([
      ['issueBodies', 0, 1, false],
      ['comments', 0, 1, false],
    ]);

    const reg = await t.action(internal.linearFiles.register, { storageId: await store(t, PNG, 'image/png'), paths: [A] });
    if (!reg.ok) throw new Error(reg.reason);
    const docs = await rewriteAll(t, true);
    expect(docs.map((d) => [d.table, d.written, 'deleted' in d])).toEqual([
      ['issueBodies', true, false],
      ['comments', false, true],
    ]);
    const comment = await t.run(async (ctx) => (await ctx.db.get('comments', commentId))!);
    expect(comment.body).toBe(`![a](${A})`);
  });

  test('same check as pasting: no non-images, no duplicates', async () => {
    const { t } = setup();
    const bad = await store(t, '%PDF-1.7', 'application/pdf');
    expect(await t.action(internal.linearFiles.register, { storageId: bad, paths: [A] })).toMatchObject({ ok: false });
    expect(await t.run(async (ctx) => await ctx.db.system.get('_storage', bad))).toBeNull();

    const big = await store(t, new Uint8Array(LIMITS.imageMaxBytes + 1), 'image/png');
    expect(await t.action(internal.linearFiles.register, { storageId: big, paths: [A] })).toMatchObject({ ok: false, reason: IMAGE_TOO_LARGE });

    const first = await t.action(internal.linearFiles.register, { storageId: await store(t, PNG, 'image/png'), paths: [A] });
    expect(first.ok).toBe(true);
    const again = await store(t, PNG, 'image/png');
    await expect(t.action(internal.linearFiles.register, { storageId: again, paths: [A] })).rejects.toThrow('already copied');
    expect(await t.run(async (ctx) => await ctx.db.system.get('_storage', again))).toBeNull();

    // Freshly copied, no reference yet: deletion deadline like a fresh upload.
    const files = await t.run(async (ctx) => await ctx.db.query('files').collect());
    expect(files).toHaveLength(1);
    expect(files[0]!.deleteAfter! - files[0]!.createdAt).toBe(NEW_FILE_GRACE_MS);
  });

  test('external targets only as https URLs', async () => {
    const { t } = setup();
    await expect(
      t.mutation(internal.linearFiles.rewrite, { table: 'issueBodies', cursor: null, apply: false, external: [{ path: VIDEO, url: 'javascript:alert(1)' }] }),
    ).rejects.toThrow('https');
  });
});
