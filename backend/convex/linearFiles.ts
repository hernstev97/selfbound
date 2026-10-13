import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import { checkImage, IMAGE_TOO_LARGE, imageUrl } from './lib/image';
import { base64url } from './lib/keys';
import { assertWritable } from './lib/testSwitches';
import { writeBody } from './ops/bodies';
import { NEW_FILE_GRACE_MS, syncFileRefs } from './ops/files';
import { syncArticleLinks } from './ops/links';
import { record } from './ops/history';
import { IMPORT } from './ops/import';
import { writeArticleBody } from './ops/wiki';
import { identifierOf, LIMITS } from './shared/constants';
import { linearUploadPaths, replaceLinearUploads } from './shared/linearFiles';

// Copy files from Linear into XLR8 storage. Driven by the tool
// `node tooling/linear-import/index.ts files …` (docs/architecture/import.md, section "Files").
//
// 1. `scan`: page through texts looking for references to uploads.linear.app (read-only).
// 2. `uploadUrl` + `register`: check and register a downloaded file like a pasted image.
//    `linearLinks` (kind 'file', linearId = Linear URL without `?…`, localId = image token)
//    remembers the mapping; each file is uploaded only once.
// 3. `rewrite`: replace references with /img/<token> (or a URL supplied by the tool, e.g.
//    Google Drive for videos). Without `apply` it only counts. A second run finds nothing.

const LINK_KIND = 'file';
const PAGE = 100;
const MAX_BYTES = 4 * 1024 * 1024;
/** Maximum mappings returned by `mapping` (a typical workspace: about 24); beyond that it throws instead of returning a partial result. */
const MAPPING_MAX = 5000;

export const TEXT_TABLES = ['issueBodies', 'comments', 'bodyRevisions', 'recurrences', 'articleBodies'] as const;
type TextTable = (typeof TEXT_TABLES)[number];
const tableValidator = v.union(...TEXT_TABLES.map((t) => v.literal(t)));

type TextDoc = Doc<'issueBodies'> | Doc<'comments'> | Doc<'bodyRevisions'> | Doc<'recurrences'> | Doc<'articleBodies'>;

function textOf(table: TextTable, doc: TextDoc): string {
  switch (table) {
    case 'issueBodies':
    case 'bodyRevisions':
    case 'articleBodies':
      return (doc as Doc<'issueBodies'>).markdown;
    case 'comments':
      return (doc as Doc<'comments'>).body;
    case 'recurrences':
      return (doc as Doc<'recurrences'>).description ?? '';
  }
}

async function page(ctx: QueryCtx, table: TextTable, cursor: string | null) {
  return await ctx.db.query(table).paginate({ cursor, numItems: PAGE, maximumBytesRead: MAX_BYTES });
}

/** Issue identifier for a text (for output without content); the team for recurrences and wiki pages. */
async function labelOf(ctx: QueryCtx, table: TextTable, doc: TextDoc) {
  if (table === 'recurrences') {
    const team = await ctx.db.get('teams', (doc as Doc<'recurrences'>).teamId);
    return `Recurrence ${team?.key ?? '?'}`;
  }
  if (table === 'articleBodies') {
    const article = await ctx.db.get('articles', (doc as Doc<'articleBodies'>).articleId);
    const team = article ? await ctx.db.get('teams', article.teamId) : null;
    return `Wiki ${team?.key ?? '?'}`;
  }
  const issue = await ctx.db.get('issues', (doc as Doc<'comments'>).issueId);
  const team = issue ? await ctx.db.get('teams', issue.teamId) : null;
  return issue && team ? identifierOf(team.key, issue.number) : '?';
}

/** One page of a text table: which Linear files appear where (identifiers only). */
export const scan = internalQuery({
  args: { table: tableValidator, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const result = await page(ctx, args.table, args.cursor);
    const refs = [];
    for (const doc of result.page) {
      const paths = linearUploadPaths(textOf(args.table, doc));
      if (paths.length === 0) continue;
      refs.push({
        table: args.table,
        id: doc._id,
        issue: await labelOf(ctx, args.table, doc),
        paths,
        ...(args.table === 'comments' && (doc as Doc<'comments'>).deletedAt !== undefined ? { deleted: true } : {}),
      });
    }
    return { refs, isDone: result.isDone, cursor: result.continueCursor };
  },
});

/** All Linear files copied so far: Linear URL → image token. */
export const mapping = internalQuery({
  args: {},
  handler: async (ctx) => {
    const links = await ctx.db
      .query('linearLinks')
      .withIndex('by_kind_linear', (q) => q.eq('kind', LINK_KIND))
      .take(MAPPING_MAX + 1);
    if (links.length > MAPPING_MAX) throw new Error(`More than ${MAPPING_MAX} copied Linear files; the mapping would be incomplete.`);
    return { files: links.map((l) => ({ path: l.linearId, token: l.localId })) };
  },
});

/** Upload URL for a file (like files.generateUploadUrl, without auth, internal only). */
export const uploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    await assertWritable(ctx);
    return { url: await ctx.storage.generateUploadUrl() };
  },
});

/**
 * Checks an uploaded file (same check as pasting an image) and registers it under the given
 * Linear URLs. Rejected files are deleted.
 */
export const register = internalAction({
  args: { storageId: v.id('_storage'), paths: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ ok: true; token: string; url: string; contentType: string; size: number } | { ok: false; reason: string }> => {
    const meta = await ctx.runQuery(internal.files.storageMeta, { storageId: args.storageId });
    if (!meta) return { ok: false, reason: 'The uploaded file is missing.' };
    const reject = async (reason: string) => {
      await ctx.storage.delete(args.storageId);
      return { ok: false as const, reason };
    };
    if (args.paths.length === 0) return await reject('No Linear URL given.');
    if (meta.size > LIMITS.imageMaxBytes) return await reject(IMAGE_TOO_LARGE);
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) return await reject('The uploaded file is missing.');
    const check = checkImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer()), meta.size, meta.contentType);
    if (!check.ok) return await reject(check.reason);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    try {
      await ctx.runMutation(internal.linearFiles.insert, {
        token,
        storageId: args.storageId,
        contentType: check.contentType,
        size: meta.size,
        paths: args.paths,
      });
    } catch (error) {
      await ctx.storage.delete(args.storageId);
      throw error;
    }
    return { ok: true, token, url: imageUrl(token), contentType: check.contentType, size: meta.size };
  },
});

async function linkOf(ctx: QueryCtx, path: string) {
  return await ctx.db
    .query('linearLinks')
    .withIndex('by_kind_linear', (q) => q.eq('kind', LINK_KIND).eq('linearId', path))
    .unique();
}

async function addLinks(ctx: MutationCtx, paths: string[], token: string) {
  for (const path of new Set(paths)) {
    const link = await linkOf(ctx, path);
    if (link && link.localId !== token) throw new Error(`Linear file is already mapped to a different image (${link._id}).`);
    if (!link) await ctx.db.insert('linearLinks', { kind: LINK_KIND, linearId: path, localId: token });
  }
}

/** Internal: register a checked image and map it to its Linear URLs. */
export const insert = internalMutation({
  args: { token: v.string(), storageId: v.id('_storage'), contentType: v.string(), size: v.number(), paths: v.array(v.string()) },
  handler: async (ctx, { paths, ...file }) => {
    await assertWritable(ctx);
    for (const path of paths) {
      if (await linkOf(ctx, path)) throw new Error('Linear file already copied; nothing registered.');
    }
    const now = Date.now();
    // Until the text is rewritten, the grace period for fresh uploads applies (afterwards the reference keeps the file).
    await ctx.db.insert('files', { ...file, createdAt: now, uploadedBy: IMPORT, deleteAfter: now + NEW_FILE_GRACE_MS });
    await addLinks(ctx, paths, file.token);
  },
});

/** Maps further Linear URLs with the same content to an already copied image. */
export const linkPaths = internalMutation({
  args: { token: v.string(), paths: v.array(v.string()) },
  handler: async (ctx, args) => {
    await assertWritable(ctx);
    const file = await ctx.db
      .query('files')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    if (!file) throw new Error('Unknown image.');
    await addLinks(ctx, args.paths, args.token);
  },
});

/**
 * Rewrites one page of a text table: Linear references → /img/<token> (from `linearLinks`)
 * or → `external` (a URL per Linear file, e.g. a Drive link for a video). Without `apply`
 * it only counts. Deleted comments stay untouched (counted as `deleted`).
 * Descriptions get a new version with a history entry (actor `import`), comments a
 * `comment_edited` history entry; the issue gets a new `updatedAt`.
 */
export const rewrite = internalMutation({
  args: {
    table: tableValidator,
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
    external: v.array(v.object({ path: v.string(), url: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.apply) await assertWritable(ctx);
    for (const e of args.external) {
      if (!/^https:\/\/[^\s()<>[\]"'`]+$/.test(e.url)) throw new Error('Target must be an https URL without whitespace or brackets.');
    }
    const now = Date.now();
    const targets = new Map(args.external.map((e) => [e.path, e.url]));
    const result = await page(ctx, args.table, args.cursor);
    const docs = [];
    for (const doc of result.page) {
      const text = textOf(args.table, doc);
      const paths = linearUploadPaths(text);
      if (paths.length === 0) continue;
      for (const path of paths) {
        if (targets.has(path)) continue;
        const link = await linkOf(ctx, path);
        if (link) targets.set(path, imageUrl(link.localId));
      }
      const next = replaceLinearUploads(text, targets);
      const deleted = args.table === 'comments' && (doc as Doc<'comments'>).deletedAt !== undefined;
      const max = args.table === 'comments' ? LIMITS.commentMax : LIMITS.descriptionMax;
      const tooLong = next.text.length > max;
      const entry = {
        table: args.table,
        id: doc._id,
        issue: await labelOf(ctx, args.table, doc),
        replaced: next.replaced,
        missing: next.missing.length,
        ...(deleted ? { deleted: true } : {}),
        ...(tooLong ? { tooLong: true } : {}),
        written: false,
      };
      if (args.apply && next.replaced > 0 && !deleted && !tooLong) {
        await writeText(ctx, args.table, doc, next.text, now);
        entry.written = true;
      }
      docs.push(entry);
    }
    return { docs, isDone: result.isDone, cursor: result.continueCursor };
  },
});

async function writeText(ctx: MutationCtx, table: TextTable, doc: TextDoc, text: string, now: number) {
  switch (table) {
    case 'issueBodies': {
      const body = doc as Doc<'issueBodies'>;
      const version = await writeBody(ctx, body.issueId, body, text, IMPORT, now);
      await ctx.db.patch('issues', body.issueId, { updatedAt: now });
      await record(ctx, IMPORT, now, undefined, {
        issueId: body.issueId,
        field: 'description',
        from: { version: body.version },
        to: { version, preview: text.slice(0, 120) },
      });
      return;
    }
    case 'comments': {
      const comment = doc as Doc<'comments'>;
      await ctx.db.patch('comments', comment._id, { body: text });
      await syncFileRefs(ctx, comment._id, text, now);
      await syncArticleLinks(ctx, { kind: 'comment', id: comment._id, issueId: comment.issueId }, text);
      await ctx.db.patch('issues', comment.issueId, { updatedAt: now });
      await record(ctx, IMPORT, now, undefined, {
        issueId: comment.issueId,
        field: 'comment_edited',
        to: { commentId: comment._id, preview: text.slice(0, 120) },
      });
      return;
    }
    case 'bodyRevisions':
      await ctx.db.patch('bodyRevisions', doc._id as Id<'bodyRevisions'>, { markdown: text });
      await syncFileRefs(ctx, doc._id, text, now);
      return;
    case 'recurrences':
      await ctx.db.patch('recurrences', doc._id as Id<'recurrences'>, { description: text });
      await syncFileRefs(ctx, doc._id, text, now);
      return;
    case 'articleBodies': {
      // New version like any text change (keeps a revision of the old text, actor `import`).
      const body = doc as Doc<'articleBodies'>;
      const article = await ctx.db.get('articles', body.articleId);
      if (article) await writeArticleBody(ctx, IMPORT, article, body, text, now);
      return;
    }
  }
}
