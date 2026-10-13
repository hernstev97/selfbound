import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { syncFileRefs } from './files';
import { syncArticleLinks } from './links';

// Descriptions: `issueBodies` (full text, version) and `bodySearch` (search text).
// Every write path for descriptions goes through this file, so the search text always
// matches the description and the image and page references (ops/files.ts, ops/links.ts) stay right.
//
// Why a separate search table: a search index hit returns the whole document. A description
// may have 200,000 characters; 50 hits could read megabytes. `bodySearch` holds only the
// start (BODY_SEARCH_CHARS), so the search misses matches far down in very long descriptions.

export const BODY_SEARCH_CHARS = 8000;

const searchText = (markdown: string) => markdown.slice(0, BODY_SEARCH_CHARS);

async function writeSearch(ctx: MutationCtx, issueId: Id<'issues'>, markdown: string) {
  const row = await ctx.db
    .query('bodySearch')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .unique();
  const text = searchText(markdown);
  if (row) {
    if (row.text !== text) await ctx.db.patch('bodySearch', row._id, { text });
  } else {
    await ctx.db.insert('bodySearch', { issueId, text });
  }
}

/** First description of a new issue (version 1). */
export async function insertBody(ctx: MutationCtx, issueId: Id<'issues'>, markdown: string, actor: Actor, now: number) {
  const bodyId = await ctx.db.insert('issueBodies', { issueId, markdown, version: 1, updatedAt: now, updatedBy: actor });
  await writeSearch(ctx, issueId, markdown);
  await syncFileRefs(ctx, bodyId, markdown, now);
  await syncArticleLinks(ctx, { kind: 'body', id: bodyId, issueId }, markdown);
}

/** New revision: version + 1. Creates the description if there is none. */
export async function writeBody(
  ctx: MutationCtx,
  issueId: Id<'issues'>,
  body: Doc<'issueBodies'> | null,
  markdown: string,
  actor: Actor,
  now: number,
) {
  const version = (body?.version ?? 0) + 1;
  let bodyId = body?._id;
  if (bodyId) await ctx.db.patch('issueBodies', bodyId, { markdown, version, updatedAt: now, updatedBy: actor });
  else bodyId = await ctx.db.insert('issueBodies', { issueId, markdown, version, updatedAt: now, updatedBy: actor });
  await writeSearch(ctx, issueId, markdown);
  await syncFileRefs(ctx, bodyId, markdown, now);
  await syncArticleLinks(ctx, { kind: 'body', id: bodyId, issueId }, markdown);
  return version;
}
