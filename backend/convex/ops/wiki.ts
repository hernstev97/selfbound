import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { dayInZone, DAY_MS } from '../lib/dates';
import { hashText, sameValue, stable } from '../lib/equal';
import { fail, invalid, notFound } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { rankBetween } from '../lib/rank';
import { hasAllTerms, searchTerms, snippet } from '../lib/search';
import type { SourceInput, SourcePatch } from '../lib/validators';
import { searchChunks } from '../lib/wikiText';
import { OWNER_KIND, PARTIAL_DATE_RE, WIKI } from '../shared/constants';
import { syncFileRefs } from './files';
import { dropLinksTo, syncArticleLinks } from './links';
import { TRASH_DAYS } from './issues';
import { timeZoneOf } from './instance';
import { checkDay, checkHue, checkName, checkTitle, getTeam } from './validate';

// Knowledge base (wiki): pages per team as a tree, with text, earlier revisions, sources and topics.
// Every write path for pages goes through this file so the search text (articleSearch), image refs
// (ops/files.ts) and revisions always match the text. Tables: schema.ts, section "Knowledge base".
//
// - Text: `baseVersion` as for issue descriptions; if it differs, the write fails with `conflict`.
// - Revisions: before overwriting, the old text is saved if the last revision is older than
//   WIKI.revisionGapMs, a different actor writes, or an agent or the importer writes.
// - Trash: deleting moves the subtree there with one shared `deletedAt`; restoring brings back exactly
//   those pages. After TRASH_DAYS `maintenance.purgeTrash` deletes them for good.
// - Only the owner may delete and restore pages.

// ---------------------------------------------------------------- Validation

function checkArticleText(markdown: string): string {
  if (markdown.length > WIKI.articleMax) {
    invalid(`The text is too long (at most ${WIKI.articleMax.toLocaleString('en-US')} characters).`);
  }
  return markdown;
}

/** Team with a knowledge base. */
export async function wikiTeam(ctx: QueryCtx, teamId: Id<'teams'>): Promise<Doc<'teams'>> {
  const team = await getTeam(ctx, teamId);
  if (!team.wiki) invalid(`Team ${team.key} has no knowledge base.`, { teamId });
  return team;
}

export async function getArticle(ctx: QueryCtx, id: Id<'articles'>, opts: { allowDeleted?: boolean } = {}) {
  const article = (await ctx.db.get('articles', id)) ?? notFound('The page', { articleId: id });
  if (article.deletedAt !== undefined && !opts.allowDeleted) invalid('The page is in the trash.', { articleId: id });
  return article;
}

function assertCanDelete(actor: Actor) {
  if (actor.kind !== OWNER_KIND) fail('access_denied', 'Only the owner may delete and restore pages.');
}

/**
 * Parent page for `articleId` (null = new page): same team, not in the trash, not the page itself
 * or one of its descendants. `height`: levels that move along (the page alone 1, more with
 * subpages); together with the levels above at most WIKI.depthMax.
 */
async function checkParent(ctx: QueryCtx, teamId: Id<'teams'>, articleId: Id<'articles'> | null, parentId: Id<'articles'>, height = 1) {
  const parent = (await ctx.db.get('articles', parentId)) ?? notFound('The parent page', { parentId });
  if (parent.teamId !== teamId) invalid('The parent page belongs to another team.', { parentId });
  if (parent.deletedAt !== undefined) invalid('The parent page is in the trash.', { parentId });
  let current: Doc<'articles'> | null = parent;
  for (let depth = 1; current; depth++) {
    if (current._id === articleId) invalid('A page cannot be placed under itself or one of its subpages.');
    if (depth + height > WIKI.depthMax) invalid(`The tree can have at most ${WIKI.depthMax} levels.`);
    current = current.parentId ? await ctx.db.get('articles', current.parentId) : null;
  }
  return parent;
}

async function checkProject(ctx: QueryCtx, teamId: Id<'teams'>, projectId: Id<'projects'>) {
  const project = (await ctx.db.get('projects', projectId)) ?? notFound('The project', { projectId });
  if (project.teamId !== teamId) invalid(`The project "${project.name}" belongs to another team.`, { projectId });
  return project._id;
}

/** Topics of the same team, deduplicated. Archived ones only if already on the page (`keep`). */
async function checkTopics(
  ctx: QueryCtx,
  teamId: Id<'teams'>,
  topicIds: Id<'wikiTopics'>[],
  keep: readonly Id<'wikiTopics'>[] = [],
) {
  const unique = [...new Set(topicIds)];
  if (unique.length > WIKI.topicsMax) invalid(`At most ${WIKI.topicsMax} topics per page.`);
  for (const topicId of unique) {
    const topic = (await ctx.db.get('wikiTopics', topicId)) ?? notFound('The topic', { topicId });
    if (topic.teamId !== teamId) invalid(`The topic "${topic.name}" belongs to another team.`, { topicId });
    if (topic.archived && !keep.includes(topicId)) invalid(`The topic "${topic.name}" is archived.`, { topicId });
  }
  return unique;
}

function optionalText(value: string | null | undefined, what: string, max: number) {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) invalid(`${what} is too long (at most ${max} characters).`);
  return trimmed || undefined;
}

type SourceFields = Pick<Doc<'articleSources'>, 'url' | 'title' | 'author' | 'publishedAt' | 'accessedAt' | 'note'>;

/** Validates a source: URL (http/https) or title, dates in the expected format. */
function checkSource(input: SourceInput, today: string): SourceFields {
  const url = input.url?.trim() || undefined;
  if (url !== undefined) {
    if (url.length > 2000) invalid('The source URL is too long (at most 2000 characters).');
    if (!/^https?:\/\/[^\s]+$/i.test(url)) invalid('The source URL must start with http:// or https://.', { url });
  }
  const title = optionalText(input.title, 'The source title', 500);
  if (!url && !title) invalid('A source needs a URL or a title.');
  const publishedAt = input.publishedAt?.trim() || undefined;
  if (publishedAt !== undefined && !PARTIAL_DATE_RE.test(publishedAt)) {
    invalid('The publication date must be YYYY, YYYY-MM or YYYY-MM-DD.', { publishedAt });
  }
  return {
    url,
    title,
    author: optionalText(input.author, 'The source author', 300),
    publishedAt,
    accessedAt: input.accessedAt === undefined ? today : checkDay(input.accessedAt.trim(), 'The access date'),
    note: input.note === undefined ? undefined : checkNote(input.note),
  };
}

function checkNote(note: string) {
  const trimmed = note.trim();
  if (trimmed.length > 2000) invalid('The source note is too long (at most 2000 characters).');
  return trimmed || undefined;
}

// ---------------------------------------------------------------- Tree and rank

/** Children of a page (undefined = top level) by rank, including those in the trash. */
function children(ctx: QueryCtx, teamId: Id<'teams'>, parentId: Id<'articles'> | undefined) {
  return ctx.db.query('articles').withIndex('by_team_parent', (q) => q.eq('teamId', teamId).eq('parentId', parentId));
}

async function lastChildRank(ctx: QueryCtx, teamId: Id<'teams'>, parentId: Id<'articles'> | undefined) {
  return (await children(ctx, teamId, parentId).order('desc').first())?.rank ?? null;
}

/** Next or previous rank among siblings, skipping the page `exclude`. */
async function siblingRank(
  ctx: QueryCtx,
  teamId: Id<'teams'>,
  parentId: Id<'articles'> | undefined,
  rank: string,
  direction: 'after' | 'before',
  exclude: Id<'articles'>,
) {
  const rows = await ctx.db
    .query('articles')
    .withIndex('by_team_parent', (q) =>
      direction === 'after'
        ? q.eq('teamId', teamId).eq('parentId', parentId).gt('rank', rank)
        : q.eq('teamId', teamId).eq('parentId', parentId).lt('rank', rank),
    )
    .order(direction === 'after' ? 'asc' : 'desc')
    .take(2);
  return rows.find((row) => row._id !== exclude)?.rank ?? null;
}

/** All pages in the subtree (including the root) that satisfy `match`; at most WIKI.subtreeMax. */
async function subtree(ctx: QueryCtx, root: Doc<'articles'>, match: (article: Doc<'articles'>) => boolean) {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for await (const child of children(ctx, root.teamId, out[i]!._id)) {
      if (!match(child)) continue;
      out.push(child);
      if (out.length > WIKI.subtreeMax) invalid(`More than ${WIKI.subtreeMax} pages at once. Move or delete subpages individually first.`);
    }
  }
  return out;
}

/** Levels of a subtree outside the trash (the page alone: 1). */
async function subtreeHeight(ctx: QueryCtx, root: Doc<'articles'>) {
  let level = [root];
  let height = 0;
  let seen = 0;
  while (level.length) {
    height++;
    const next: Doc<'articles'>[] = [];
    for (const page of level) {
      for await (const child of children(ctx, root.teamId, page._id)) {
        if (child.deletedAt !== undefined) continue;
        if (++seen > WIKI.subtreeMax) invalid(`More than ${WIKI.subtreeMax} pages at once. Move subpages individually first.`);
        next.push(child);
      }
    }
    level = next;
  }
  return height;
}

// ---------------------------------------------------------------- Text, search text, revisions

async function bodyOf(ctx: QueryCtx, articleId: Id<'articles'>) {
  return await ctx.db
    .query('articleBodies')
    .withIndex('by_article', (q) => q.eq('articleId', articleId))
    .unique();
}

/** Writes only chunks that changed (appending at the end leaves the earlier ones untouched). */
async function writeSearch(ctx: MutationCtx, article: Doc<'articles'>, markdown: string) {
  const chunks = searchChunks(markdown);
  const existing = await ctx.db
    .query('articleSearch')
    .withIndex('by_article', (q) => q.eq('articleId', article._id))
    .collect();
  for (let n = 0; n < Math.max(chunks.length, existing.length); n++) {
    const row = existing[n];
    const text = chunks[n];
    if (text === undefined) await ctx.db.delete('articleSearch', row!._id);
    else if (!row) await ctx.db.insert('articleSearch', { articleId: article._id, teamId: article.teamId, n, text });
    else if (row.text !== text || row.n !== n) await ctx.db.patch('articleSearch', row._id, { n, text });
  }
}

/** Saves the current text as a revision if the revision rule requires it (or `force`). */
async function saveRevision(
  ctx: MutationCtx,
  actor: Actor,
  article: Doc<'articles'>,
  body: Doc<'articleBodies'>,
  now: number,
  force: boolean,
) {
  if (!body.markdown) return;
  const last = await ctx.db
    .query('articleRevisions')
    .withIndex('by_article', (q) => q.eq('articleId', article._id))
    .order('desc')
    .first();
  const due =
    force ||
    !last ||
    now - last.savedAt >= WIKI.revisionGapMs ||
    !sameValue(body.updatedBy, actor) ||
    actor.kind === 'agent' ||
    actor.kind === 'import';
  if (!due || last?.version === body.version) return;
  const revisionId = await ctx.db.insert('articleRevisions', {
    articleId: article._id,
    title: article.title,
    markdown: body.markdown,
    version: body.version,
    at: body.updatedAt,
    actor: body.updatedBy,
    savedAt: now,
  });
  await syncFileRefs(ctx, revisionId, body.markdown, now);
  const count = (body.revisionCount ?? 0) + 1;
  if (count > WIKI.revisionsMax) {
    const oldest = await ctx.db
      .query('articleRevisions')
      .withIndex('by_article', (q) => q.eq('articleId', article._id))
      .first();
    if (oldest) {
      await syncFileRefs(ctx, oldest._id, null, now);
      await ctx.db.delete('articleRevisions', oldest._id);
    }
    return WIKI.revisionsMax;
  }
  return count;
}

/** The page's `updatedAt`/`updatedBy`; for text edits at most once per WIKI.touchGapMs. */
async function touch(ctx: MutationCtx, actor: Actor, article: Doc<'articles'>, now: number, throttle: boolean) {
  if (throttle && now - article.updatedAt < WIKI.touchGapMs && sameValue(article.updatedBy, actor)) return;
  await ctx.db.patch('articles', article._id, { updatedAt: now, updatedBy: actor });
}

/** New text: save a revision, bump the version, update search text and image refs. Returns the new version. */
export async function writeArticleBody(
  ctx: MutationCtx,
  actor: Actor,
  article: Doc<'articles'>,
  body: Doc<'articleBodies'> | null,
  markdown: string,
  now: number,
  opts: { forceRevision?: boolean } = {},
) {
  const version = (body?.version ?? 0) + 1;
  let bodyId = body?._id;
  if (body) {
    const revisionCount = await saveRevision(ctx, actor, article, body, now, opts.forceRevision ?? false);
    await ctx.db.patch('articleBodies', body._id, {
      markdown,
      version,
      updatedAt: now,
      updatedBy: actor,
      ...(revisionCount !== undefined ? { revisionCount } : {}),
    });
  } else {
    bodyId = await ctx.db.insert('articleBodies', { articleId: article._id, markdown, version, updatedAt: now, updatedBy: actor });
  }
  await writeSearch(ctx, article, markdown);
  await syncFileRefs(ctx, bodyId!, markdown, now);
  await syncArticleLinks(ctx, { kind: 'article', id: article._id }, markdown);
  await touch(ctx, actor, article, now, true);
  return version;
}

function conflict(article: Doc<'articles'>, body: Doc<'articleBodies'> | null): never {
  fail('conflict', 'The page has changed in the meantime. Review the latest version and save again.', {
    articleId: article._id,
    version: body?.version ?? 0,
    updatedAt: body?.updatedAt,
    updatedBy: body?.updatedBy,
  });
}

// ---------------------------------------------------------------- Reading

/** All pages of a team outside the trash (without text) and its topics. */
export async function listArticles(ctx: QueryCtx, teamId: Id<'teams'>) {
  const [articles, topics] = await Promise.all([
    ctx.db
      .query('articles')
      .withIndex('by_team_deleted', (q) => q.eq('teamId', teamId).eq('deletedAt', undefined))
      .take(WIKI.articlesPerTeam),
    ctx.db
      .query('wikiTopics')
      .withIndex('by_team', (q) => q.eq('teamId', teamId))
      .take(500),
  ]);
  return { articles, topics, truncated: articles.length === WIKI.articlesPerTeam };
}

/** Page count per project of a team (outside the trash), for the project overview. */
export async function projectCounts(ctx: QueryCtx, teamId: Id<'teams'>) {
  const rows = await ctx.db
    .query('articles')
    .withIndex('by_team_deleted', (q) => q.eq('teamId', teamId).eq('deletedAt', undefined))
    .take(WIKI.articlesPerTeam);
  const counts: Record<string, number> = {};
  for (const row of rows) if (row.projectId) counts[row.projectId] = (counts[row.projectId] ?? 0) + 1;
  return counts;
}

/** A page with text, sources, path (ancestors up to the top) and subpages. Null if it does not exist. */
export async function articleDetail(ctx: QueryCtx, articleId: Id<'articles'>) {
  const article = await ctx.db.get('articles', articleId);
  if (!article) return null;
  const [team, body, sources, kids] = await Promise.all([
    ctx.db.get('teams', article.teamId),
    bodyOf(ctx, article._id),
    ctx.db
      .query('articleSources')
      .withIndex('by_article', (q) => q.eq('articleId', article._id))
      .take(WIKI.sourcesMax + 10),
    children(ctx, article.teamId, article._id).take(WIKI.subtreeMax),
  ]);
  const path: { id: Id<'articles'>; title: string }[] = [];
  let parentId = article.parentId;
  while (parentId && path.length < WIKI.depthMax) {
    const parent = await ctx.db.get('articles', parentId);
    if (!parent) break;
    path.unshift({ id: parent._id, title: parent.title });
    parentId = parent.parentId;
  }
  return {
    article,
    team: team ? { id: team._id, key: team.key, name: team.name, wiki: team.wiki ?? null } : null,
    body: body
      ? { markdown: body.markdown, version: body.version, updatedAt: body.updatedAt, updatedBy: body.updatedBy }
      : { markdown: '', version: 0, updatedAt: article.createdAt, updatedBy: article.createdBy },
    sources,
    path,
    children: kids.filter((c) => c.deletedAt === undefined).map((c) => ({ id: c._id, title: c.title, rank: c.rank })),
  };
}

/**
 * Trash of a team: per delete operation the topmost page and how many pages went with it,
 * newest first.
 */
export async function trashOf(ctx: QueryCtx, teamId: Id<'teams'>) {
  const rows = await ctx.db
    .query('articles')
    .withIndex('by_team_deleted', (q) => q.eq('teamId', teamId).gt('deletedAt', 0))
    .order('desc')
    .take(WIKI.subtreeMax);
  const byTime = new Map<number, Doc<'articles'>[]>();
  for (const row of rows) byTime.set(row.deletedAt!, [...(byTime.get(row.deletedAt!) ?? []), row]);
  const out = [];
  for (const group of byTime.values()) {
    const ids = new Set(group.map((a) => a._id));
    for (const root of group.filter((a) => !a.parentId || !ids.has(a.parentId))) {
      out.push({ id: root._id, title: root.title, deletedAt: root.deletedAt!, pages: group.length, parentId: root.parentId ?? null });
    }
  }
  return out;
}

/** Revisions of a page, newest first, without the full text (paginated via `before`). */
export async function revisionPage(ctx: QueryCtx, articleId: Id<'articles'>, before?: number, limit = 20) {
  const max = Math.max(1, Math.min(20, Math.floor(limit)));
  const rows = await ctx.db
    .query('articleRevisions')
    .withIndex('by_article', (q) => (before === undefined ? q.eq('articleId', articleId) : q.eq('articleId', articleId).lt('savedAt', before)))
    .order('desc')
    .take(max + 1);
  return {
    revisions: rows.slice(0, max).map((r) => ({
      id: r._id,
      title: r.title,
      version: r.version,
      at: r.at,
      actor: r.actor,
      savedAt: r.savedAt,
      chars: r.markdown.length,
      preview: r.markdown.slice(0, 200),
    })),
    hasMore: rows.length > max,
  };
}

export type ArticleSearchHit = {
  id: Id<'articles'>;
  title: string;
  teamId: Id<'teams'>;
  parentId: Id<'articles'> | null;
  match: 'title' | 'text';
  snippet?: string;
};

/**
 * Full-text search over titles and text chunks, optionally within one team. Same as issues.search:
 * hits with ALL terms first (title before text), then the rest. Pages in the trash are excluded.
 */
export async function searchArticles(ctx: QueryCtx, args: { q: string; teamId?: Id<'teams'>; limit?: number }) {
  const text = args.q.trim().slice(0, 200);
  const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)));
  if (!text) return [];
  const terms = searchTerms(text);
  const pool = Math.min(200, limit * 5);
  const teamId = args.teamId;
  const [titles, chunks] = await Promise.all([
    ctx.db
      .query('articles')
      .withSearchIndex('search_title', (q) => (teamId ? q.search('title', text).eq('teamId', teamId) : q.search('title', text)))
      .take(pool),
    ctx.db
      .query('articleSearch')
      .withSearchIndex('search_text', (q) => (teamId ? q.search('text', text).eq('teamId', teamId) : q.search('text', text)))
      .take(pool),
  ]);
  type Candidate = { articleId: Id<'articles'>; article?: Doc<'articles'>; match: 'title' | 'text'; source?: string; all: boolean };
  const candidates: Candidate[] = [
    ...titles.map((a) => ({ articleId: a._id, article: a, match: 'title' as const, all: hasAllTerms(a.title, terms) })),
    ...chunks.map((c) => ({ articleId: c.articleId, match: 'text' as const, source: c.text, all: hasAllTerms(c.text, terms) })),
  ];
  const ordered = [...candidates.filter((c) => c.all), ...candidates.filter((c) => !c.all)];
  const seen = new Set<Id<'articles'>>();
  const out: ArticleSearchHit[] = [];
  for (const c of ordered) {
    if (out.length >= limit) break;
    if (seen.has(c.articleId)) continue;
    const article = c.article ?? (await ctx.db.get('articles', c.articleId));
    if (!article || article.deletedAt !== undefined) continue;
    seen.add(article._id);
    out.push({
      id: article._id,
      title: article.title,
      teamId: article.teamId,
      parentId: article.parentId ?? null,
      match: c.match,
      ...(c.source ? { snippet: snippet(c.source, terms) } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Create and update

export interface NewArticle {
  teamId: Id<'teams'>;
  title: string;
  markdown?: string;
  parentId?: Id<'articles'>;
  projectId?: Id<'projects'>;
  topicIds?: Id<'wikiTopics'>[];
  sources?: SourceInput[];
  requestId?: string;
}

export async function createArticle(ctx: MutationCtx, actor: Actor, args: NewArticle) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.create', { ...args }, async () =>
    createArticleCore(ctx, actor, args, Date.now()),
  );
}

/**
 * Core of createArticle without the idempotency wrapper. `at`: explicit timestamps (Linear import).
 * New pages go to the end of their level.
 */
export async function createArticleCore(
  ctx: MutationCtx,
  actor: Actor,
  args: NewArticle,
  now: number,
  at: { createdAt: number; updatedAt: number } = { createdAt: now, updatedAt: now },
) {
  const team = await wikiTeam(ctx, args.teamId);
  const title = checkTitle(args.title);
  const markdown = checkArticleText(args.markdown ?? '');
  const parentId = args.parentId ? (await checkParent(ctx, team._id, null, args.parentId))._id : undefined;
  const projectId = args.projectId ? await checkProject(ctx, team._id, args.projectId) : undefined;
  const topicIds = await checkTopics(ctx, team._id, args.topicIds ?? []);
  const sources = args.sources ?? [];
  if (sources.length > WIKI.sourcesMax) invalid(`At most ${WIKI.sourcesMax} sources per page.`);
  const zone = await timeZoneOf(ctx);
  const checked = sources.map((s) => checkSource(s, dayInZone(now, zone)));
  const rank = rankBetween(await lastChildRank(ctx, team._id, parentId), null);
  const articleId = await ctx.db.insert('articles', {
    teamId: team._id,
    parentId,
    projectId,
    title,
    rank,
    topicIds,
    createdAt: at.createdAt,
    createdBy: actor,
    updatedAt: at.updatedAt,
    updatedBy: actor,
  });
  const article = (await ctx.db.get('articles', articleId))!;
  const bodyId = await ctx.db.insert('articleBodies', { articleId, markdown, version: 1, updatedAt: at.updatedAt, updatedBy: actor });
  await writeSearch(ctx, article, markdown);
  await syncFileRefs(ctx, bodyId, markdown, now);
  await syncArticleLinks(ctx, { kind: 'article', id: articleId }, markdown);
  for (const [order, source] of checked.entries()) {
    await ctx.db.insert('articleSources', { articleId, ...source, order, createdAt: now, createdBy: actor });
  }
  return { articleId };
}

export interface ArticlePatch {
  id: Id<'articles'>;
  title?: string;
  projectId?: Id<'projects'> | null;
  topicIds?: Id<'wikiTopics'>[];
  requestId?: string;
}

/** Title, project, topics. Unchanged fields do not count as a change. */
export async function updateArticle(ctx: MutationCtx, actor: Actor, args: ArticlePatch) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.update', { ...args }, async () =>
    updateArticleCore(ctx, actor, args, Date.now()),
  );
}

export async function updateArticleCore(ctx: MutationCtx, actor: Actor, args: ArticlePatch, now: number) {
  const article = await getArticle(ctx, args.id);
  const patch: Partial<Doc<'articles'>> = {};
  if (args.title !== undefined) {
    const title = checkTitle(args.title);
    if (title !== article.title) patch.title = title;
  }
  if (args.projectId !== undefined) {
    const projectId = args.projectId === null ? undefined : await checkProject(ctx, article.teamId, args.projectId);
    if (projectId !== article.projectId) patch.projectId = projectId;
  }
  if (args.topicIds !== undefined) {
    const topicIds = await checkTopics(ctx, article.teamId, args.topicIds, article.topicIds);
    if (!sameValue(topicIds, article.topicIds, true)) patch.topicIds = topicIds;
  }
  if (Object.keys(patch).length === 0) return { articleId: article._id, changed: false };
  await ctx.db.patch('articles', article._id, { ...patch, updatedAt: now, updatedBy: actor });
  return { articleId: article._id, changed: true };
}

export interface MoveArticleArgs {
  id: Id<'articles'>;
  /** New parent page, null = top level. */
  parentId: Id<'articles'> | null;
  /** Sibling that ends up directly BEFORE the page. */
  beforeId?: Id<'articles'>;
  /** Sibling that ends up directly AFTER the page. Neither given: move to the end. */
  afterId?: Id<'articles'>;
  requestId?: string;
}

/** Reparent and reorder: new parent page and position among siblings. */
export async function moveArticle(ctx: MutationCtx, actor: Actor, args: MoveArticleArgs) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.move', { ...args }, async () => {
    const article = await getArticle(ctx, args.id);
    const parentId = args.parentId
      ? (await checkParent(ctx, article.teamId, article._id, args.parentId, await subtreeHeight(ctx, article)))._id
      : undefined;
    const sibling = async (id: Id<'articles'> | undefined) => {
      if (!id) return null;
      if (id === article._id) invalid('A page cannot be its own neighbor.');
      const other = await getArticle(ctx, id);
      if (other.teamId !== article.teamId || other.parentId !== parentId) invalid('The neighbor is not on the same level.', { id });
      return other;
    };
    const before = await sibling(args.beforeId);
    const after = await sibling(args.afterId);
    let lo: string | null;
    let hi: string | null;
    if (!before && !after) {
      // To the end of the level; if the page is already there, nothing changes.
      lo = await lastChildRank(ctx, article.teamId, parentId);
      if (lo === article.rank && article.parentId === parentId) return { articleId: article._id, rank: article.rank };
      hi = null;
    } else {
      lo = before?.rank ?? (after ? await siblingRank(ctx, article.teamId, parentId, after.rank, 'before', article._id) : null);
      hi = after?.rank ?? (before ? await siblingRank(ctx, article.teamId, parentId, before.rank, 'after', article._id) : null);
      if (lo !== null && hi !== null && lo >= hi) {
        // Neighbors are no longer adjacent (e.g. after a concurrent change): place directly after `before`.
        if (before) hi = await siblingRank(ctx, article.teamId, parentId, before.rank, 'after', article._id);
        else lo = await siblingRank(ctx, article.teamId, parentId, hi, 'before', article._id);
      }
    }
    const rank = rankBetween(lo, hi);
    await ctx.db.patch('articles', article._id, { parentId, rank, updatedAt: Date.now(), updatedBy: actor });
    return { articleId: article._id, rank };
  });
}

export interface SetBodyArgs {
  id: Id<'articles'>;
  markdown: string;
  baseVersion: number;
  requestId?: string;
}

/** Saves the text. `baseVersion` must be the current version, otherwise `conflict`. */
export async function setArticleBody(ctx: MutationCtx, actor: Actor, args: SetBodyArgs) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.setBody', { ...args }, async () =>
    setArticleBodyCore(ctx, actor, args, Date.now()),
  );
}

export async function setArticleBodyCore(ctx: MutationCtx, actor: Actor, args: SetBodyArgs, now: number) {
  const article = await getArticle(ctx, args.id);
  const markdown = checkArticleText(args.markdown);
  const body = await bodyOf(ctx, article._id);
  if ((body?.version ?? 0) !== args.baseVersion) conflict(article, body);
  if (body && body.markdown === markdown) return { version: body.version, changed: false };
  return { version: await writeArticleBody(ctx, actor, article, body, markdown, now), changed: true };
}

/**
 * Appends text at the end (no version check, for agents that collect findings over time).
 * A blank line separates the old text from the addition.
 */
export async function appendArticleBodyCore(ctx: MutationCtx, actor: Actor, args: { id: Id<'articles'>; markdown: string }, now: number) {
  const article = await getArticle(ctx, args.id);
  const addition = args.markdown.trim();
  if (!addition) invalid('The appended text must not be empty.');
  const body = await bodyOf(ctx, article._id);
  const old = body?.markdown.trimEnd() ?? '';
  const markdown = checkArticleText(old ? `${old}\n\n${addition}\n` : `${addition}\n`);
  return { version: await writeArticleBody(ctx, actor, article, body, markdown, now), changed: true };
}

/** Restores an earlier revision: writes its text as a new version (which can itself be undone). */
export async function restoreRevision(
  ctx: MutationCtx,
  actor: Actor,
  args: { revisionId: Id<'articleRevisions'>; baseVersion: number; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.restoreRevision', { ...args }, async () => {
    const revision = (await ctx.db.get('articleRevisions', args.revisionId)) ?? notFound('The revision', { revisionId: args.revisionId });
    const article = await getArticle(ctx, revision.articleId);
    const body = await bodyOf(ctx, article._id);
    if ((body?.version ?? 0) !== args.baseVersion) conflict(article, body);
    if (body && body.markdown === revision.markdown) return { version: body.version, changed: false };
    const version = await writeArticleBody(ctx, actor, article, body, revision.markdown, Date.now(), { forceRevision: true });
    return { version, changed: true };
  });
}

// ---------------------------------------------------------------- Trash

/** Moves a page with all its subpages to the trash (all with the same `deletedAt`). */
export async function removeArticle(ctx: MutationCtx, actor: Actor, args: { id: Id<'articles'>; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.remove', { ...args }, async () => {
    assertCanDelete(actor);
    const article = await getArticle(ctx, args.id);
    const pages = await subtree(ctx, article, (a) => a.deletedAt === undefined);
    // Each delete operation within a team gets its own timestamp: it keeps the subtree together.
    const latest = await ctx.db
      .query('articles')
      .withIndex('by_team_deleted', (q) => q.eq('teamId', article.teamId).gt('deletedAt', 0))
      .order('desc')
      .first();
    const now = Math.max(Date.now(), (latest?.deletedAt ?? 0) + 1);
    for (const page of pages) await ctx.db.patch('articles', page._id, { deletedAt: now, updatedAt: now, updatedBy: actor });
    return { articleId: article._id, removed: pages.length, deletedAt: now };
  });
}

/**
 * Restores a page and the subpages deleted with it. If the parent page is still in the trash
 * (or gone), the page moves to the top level.
 */
export async function restoreArticle(ctx: MutationCtx, actor: Actor, args: { id: Id<'articles'>; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.restore', { ...args }, async () => {
    assertCanDelete(actor);
    const article = await getArticle(ctx, args.id, { allowDeleted: true });
    if (article.deletedAt === undefined) return { articleId: article._id, restored: 0, movedToTop: false };
    await wikiTeam(ctx, article.teamId);
    const pages = await subtree(ctx, article, (a) => a.deletedAt === article.deletedAt);
    const parent = article.parentId ? await ctx.db.get('articles', article.parentId) : null;
    const movedToTop = article.parentId !== undefined && (!parent || parent.deletedAt !== undefined);
    const now = Date.now();
    for (const page of pages) {
      const top = page._id === article._id && movedToTop;
      await ctx.db.patch('articles', page._id, {
        deletedAt: undefined,
        updatedAt: now,
        updatedBy: actor,
        ...(top ? { parentId: undefined, rank: rankBetween(await lastChildRank(ctx, article.teamId, undefined), null) } : {}),
      });
    }
    return { articleId: article._id, restored: pages.length, movedToTop };
  });
}

/** Maximum revisions one purge run reads (a single revision can hold 200,000 characters). */
const PURGE_REVISIONS = 40;

/**
 * Permanently deletes a page with its text, search text, revisions, sources and image refs and
 * writes a tombstone. `budget.revisions`: how many revisions this call may still read; if that is
 * not enough, the page stays and the result is `false` (the next run continues).
 * Subpages that were (unusually) not deleted with it move to the top level.
 */
export async function purgeArticle(ctx: MutationCtx, article: Doc<'articles'>, now: number, budget = { revisions: PURGE_REVISIONS }) {
  const revisions = await ctx.db
    .query('articleRevisions')
    .withIndex('by_article', (q) => q.eq('articleId', article._id))
    .take(budget.revisions + 1);
  for (const revision of revisions.slice(0, budget.revisions)) {
    await syncFileRefs(ctx, revision._id, null, now);
    await ctx.db.delete('articleRevisions', revision._id);
  }
  if (revisions.length > budget.revisions) {
    budget.revisions = 0;
    return false;
  }
  budget.revisions -= revisions.length;
  const body = await bodyOf(ctx, article._id);
  if (body) {
    await syncFileRefs(ctx, body._id, null, now);
    await ctx.db.delete('articleBodies', body._id);
  }
  await syncArticleLinks(ctx, { kind: 'article', id: article._id }, null);
  await dropLinksTo(ctx, { articleId: article._id });
  for (const table of ['articleSearch', 'articleSources'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_article', (q) => q.eq('articleId', article._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  for (const child of await children(ctx, article.teamId, article._id).collect()) {
    const rank = rankBetween(await lastChildRank(ctx, article.teamId, undefined), null);
    await ctx.db.patch('articles', child._id, { parentId: undefined, rank });
  }
  const links = await ctx.db
    .query('linearLinks')
    .withIndex('by_local', (q) => q.eq('localId', article._id))
    .collect();
  for (const link of links) await ctx.db.patch('linearLinks', link._id, { purgedAt: now });
  await ctx.db.insert('articleTombstones', { articleId: article._id, teamId: article.teamId, purgedAt: now });
  await ctx.db.delete('articles', article._id);
  return true;
}

/** Permanently deletes what has been in the trash longer than TRASH_DAYS (in batches). */
export async function purgeArticleTrash(ctx: MutationCtx, now: number, limit = 25) {
  const cutoff = now - TRASH_DAYS * DAY_MS;
  const due = await ctx.db
    .query('articles')
    .withIndex('by_deleted', (q) => q.gte('deletedAt', 0).lt('deletedAt', cutoff))
    .take(limit);
  const budget = { revisions: PURGE_REVISIONS };
  let purged = 0;
  for (const article of due) {
    if (!(await purgeArticle(ctx, article, now, budget))) return { purged, more: true };
    purged++;
  }
  return { purged, more: due.length === limit };
}

// ---------------------------------------------------------------- Sources

async function sourceOf(ctx: QueryCtx, sourceId: Id<'articleSources'>) {
  const source = (await ctx.db.get('articleSources', sourceId)) ?? notFound('The source', { sourceId });
  const article = await getArticle(ctx, source.articleId);
  return { source, article };
}

export async function addSources(
  ctx: MutationCtx,
  actor: Actor,
  args: { articleId: Id<'articles'>; sources: SourceInput[]; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.addSources', { ...args }, async () =>
    addSourcesCore(ctx, actor, args, Date.now()),
  );
}

export async function addSourcesCore(ctx: MutationCtx, actor: Actor, args: { articleId: Id<'articles'>; sources: SourceInput[] }, now: number) {
  const article = await getArticle(ctx, args.articleId);
  if (args.sources.length === 0) invalid('No source given.');
  const existing = await ctx.db
    .query('articleSources')
    .withIndex('by_article', (q) => q.eq('articleId', article._id))
    .take(WIKI.sourcesMax + 1);
  if (existing.length + args.sources.length > WIKI.sourcesMax) invalid(`At most ${WIKI.sourcesMax} sources per page.`);
  const zone = await timeZoneOf(ctx);
  const checked = args.sources.map((s) => checkSource(s, dayInZone(now, zone)));
  let order = existing.reduce((max, s) => Math.max(max, s.order), -1);
  const sourceIds = [];
  for (const source of checked) {
    sourceIds.push(await ctx.db.insert('articleSources', { articleId: article._id, ...source, order: ++order, createdAt: now, createdBy: actor }));
  }
  await touch(ctx, actor, article, now, false);
  return { sourceIds };
}

export async function updateSource(
  ctx: MutationCtx,
  actor: Actor,
  args: { sourceId: Id<'articleSources'>; patch: SourcePatch; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.updateSource', { ...args }, async () => {
    const { source, article } = await sourceOf(ctx, args.sourceId);
    const now = Date.now();
    const merged: SourceInput = {
      url: args.patch.url === undefined ? source.url : (args.patch.url ?? undefined),
      title: args.patch.title === undefined ? source.title : (args.patch.title ?? undefined),
      author: args.patch.author === undefined ? source.author : (args.patch.author ?? undefined),
      publishedAt: args.patch.publishedAt === undefined ? source.publishedAt : (args.patch.publishedAt ?? undefined),
      accessedAt: args.patch.accessedAt ?? source.accessedAt,
      note: args.patch.note === undefined ? source.note : (args.patch.note ?? undefined),
    };
    const zone = await timeZoneOf(ctx);
    const checked = checkSource(merged, dayInZone(now, zone));
    const { _id, _creationTime, articleId, order, createdAt, createdBy, ...current } = source;
    if (sameValue(checked, current)) return { sourceId: source._id, changed: false };
    await ctx.db.replace('articleSources', source._id, { articleId, order, createdAt, createdBy, ...checked });
    await touch(ctx, actor, article, now, false);
    return { sourceId: source._id, changed: true };
  });
}

export async function removeSource(ctx: MutationCtx, actor: Actor, args: { sourceId: Id<'articleSources'>; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.removeSource', { ...args }, async () => {
    const { source, article } = await sourceOf(ctx, args.sourceId);
    await ctx.db.delete('articleSources', source._id);
    await touch(ctx, actor, article, Date.now(), false);
    return { sourceId: source._id };
  });
}

/** New source order: position in the list; missing ones go to the end. */
export async function reorderSources(
  ctx: MutationCtx,
  actor: Actor,
  args: { articleId: Id<'articles'>; sourceIds: Id<'articleSources'>[]; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.reorderSources', { ...args }, async () => {
    const article = await getArticle(ctx, args.articleId);
    const sources = await ctx.db
      .query('articleSources')
      .withIndex('by_article', (q) => q.eq('articleId', article._id))
      .take(WIKI.sourcesMax + 10);
    const ids = new Set(sources.map((s) => s._id));
    for (const id of args.sourceIds) if (!ids.has(id)) invalid('The source does not belong to this page.', { sourceId: id });
    const position = new Map([...new Set(args.sourceIds)].map((id, i) => [id, i]));
    const ordered = [...sources].sort((a, b) => (position.get(a._id) ?? Infinity) - (position.get(b._id) ?? Infinity) || a.order - b.order);
    for (const [order, source] of ordered.entries()) {
      if (source.order !== order) await ctx.db.patch('articleSources', source._id, { order });
    }
    await touch(ctx, actor, article, Date.now(), false);
    return { articleId: article._id };
  });
}

// ---------------------------------------------------------------- Topics

async function assertTopicNameFree(ctx: QueryCtx, teamId: Id<'teams'>, name: string, except?: Id<'wikiTopics'>) {
  const topics = await ctx.db
    .query('wikiTopics')
    .withIndex('by_team', (q) => q.eq('teamId', teamId))
    .take(500);
  const lower = name.toLocaleLowerCase('de');
  const clash = topics.find((t) => t._id !== except && t.name.toLocaleLowerCase('de') === lower);
  if (clash) invalid(`The topic "${clash.name}" already exists${clash.archived ? ' (archived)' : ''}.`, { topicId: clash._id });
  return topics.length;
}

export async function createTopic(
  ctx: MutationCtx,
  actor: Actor,
  args: { teamId: Id<'teams'>; name: string; hue?: number; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.createTopic', { ...args }, async () => {
    const team = await wikiTeam(ctx, args.teamId);
    const name = checkName(args.name, 'The topic', 60);
    const count = await assertTopicNameFree(ctx, team._id, name);
    if (count >= 500) invalid('At most 500 topics per team.');
    const topicId = await ctx.db.insert('wikiTopics', {
      teamId: team._id,
      name,
      hue: args.hue === undefined ? (count * 67 + 30) % 360 : checkHue(args.hue),
    });
    return { topicId };
  });
}

export async function updateTopic(
  ctx: MutationCtx,
  actor: Actor,
  args: { topicId: Id<'wikiTopics'>; name?: string; hue?: number; archived?: boolean; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'wiki.updateTopic', { ...args }, async () => {
    const topic = (await ctx.db.get('wikiTopics', args.topicId)) ?? notFound('The topic', { topicId: args.topicId });
    const patch: Partial<Doc<'wikiTopics'>> = {};
    if (args.name !== undefined) {
      const name = checkName(args.name, 'The topic', 60);
      if (name !== topic.name) {
        await assertTopicNameFree(ctx, topic.teamId, name, topic._id);
        patch.name = name;
      }
    }
    if (args.hue !== undefined) patch.hue = checkHue(args.hue);
    if (args.archived !== undefined) patch.archived = args.archived || undefined;
    if (Object.keys(patch).length) await ctx.db.patch('wikiTopics', topic._id, patch);
    return { topicId: topic._id };
  });
}

// ---------------------------------------------------------------- Linear import

export interface ImportDocumentArgs {
  linearId: string;
  teamKey: string;
  projectName?: string;
  title: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
  sources: SourceInput[];
  /** Turn on the team's knowledge base ('on') if it is off. */
  enableWiki: boolean;
}

const IMPORT_ACTOR: Actor = { kind: 'import' };

/**
 * Imports a Linear document as a page (actor `import`). Repeatable without duplicates via
 * `linearLinks` (kind 'document'): same content → no-op; changed title or text → new version
 * (with a revision of the old text). A page in the trash or purged stays that way. Sources are only
 * added the first time.
 */
export async function importDocument(ctx: MutationCtx, args: ImportDocumentArgs) {
  const team = await ctx.db
    .query('teams')
    .withIndex('by_key', (q) => q.eq('key', args.teamKey.trim().toUpperCase()))
    .unique();
  if (!team) notFound(`Team ${args.teamKey}`);
  let enabledWiki = false;
  if (!team.wiki) {
    if (!args.enableWiki) invalid(`Team ${team.key} has no knowledge base (set enableWiki).`);
    await ctx.db.patch('teams', team._id, { wiki: 'on', updatedAt: Date.now() });
    enabledWiki = true;
  }
  let projectId: Id<'projects'> | undefined;
  if (args.projectName !== undefined) {
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_team', (q) => q.eq('teamId', team._id))
      .take(500);
    const matches = projects.filter((p) => p.name === args.projectName);
    if (matches.length !== 1) invalid(`Project in team ${team.key}: ${matches.length} matches instead of exactly one.`);
    projectId = matches[0]!._id;
  }
  const hash = hashText(stable({ title: args.title, markdown: args.markdown }));
  const link = await ctx.db
    .query('linearLinks')
    .withIndex('by_kind_linear', (q) => q.eq('kind', 'document').eq('linearId', args.linearId))
    .unique();
  const now = Date.now();
  if (link) {
    const article = await ctx.db.get('articles', link.localId as Id<'articles'>);
    if (link.purgedAt !== undefined || !article) return { result: 'purged' as const, articleId: link.localId, enabledWiki };
    if (article.deletedAt !== undefined) return { result: 'in_trash' as const, articleId: article._id, enabledWiki };
    if (link.hash === hash) return { result: 'unchanged' as const, articleId: article._id, enabledWiki };
    if (article.title !== checkTitle(args.title)) await updateArticleCore(ctx, IMPORT_ACTOR, { id: article._id, title: args.title }, now);
    const body = await bodyOf(ctx, article._id);
    if (body?.markdown !== args.markdown) {
      const fresh = (await ctx.db.get('articles', article._id))!;
      await writeArticleBody(ctx, IMPORT_ACTOR, fresh, body, checkArticleText(args.markdown), now);
    }
    await ctx.db.patch('linearLinks', link._id, { hash });
    return { result: 'updated' as const, articleId: article._id, enabledWiki };
  }
  const { articleId } = await createArticleCore(
    ctx,
    IMPORT_ACTOR,
    { teamId: team._id, title: args.title, markdown: args.markdown, projectId, sources: args.sources },
    now,
    { createdAt: args.createdAt, updatedAt: args.updatedAt },
  );
  await ctx.db.insert('linearLinks', { kind: 'document', linearId: args.linearId, localId: articleId, hash });
  return { result: 'created' as const, articleId, enabledWiki };
}
