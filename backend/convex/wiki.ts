import { v } from 'convex/values';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { newArticleValidator, requestIdArg, sourceInputValidator, sourcePatchValidator } from './lib/validators';
import { articleBacklinks, issueArticles } from './ops/links';
import * as ops from './ops/wiki';

// Knowledge base (wiki): pages per team. Logic lives in ops/wiki.ts (shared with MCP and import).
// These queries only run while the knowledge base is open in the UI; meta.get is unaffected.

// ---------------------------------------------------------------- Reading

/** All pages of a team (without text, excluding trash) and its topics. */
export const list = ownerQuery({
  args: { teamId: v.id('teams') },
  handler: async (ctx, args) => await ops.listArticles(ctx, args.teamId),
});

/** A page with text, sources, path and subpages. `id` is a string because it comes from the URL. */
export const get = ownerQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId('articles', args.id);
    return id ? await ops.articleDetail(ctx, id) : null;
  },
});

/** Page count per project of a team (project overview). */
export const projectCounts = ownerQuery({
  args: { teamId: v.id('teams') },
  handler: async (ctx, args) => await ops.projectCounts(ctx, args.teamId),
});

export const trash = ownerQuery({
  args: { teamId: v.id('teams') },
  handler: async (ctx, args) => await ops.trashOf(ctx, args.teamId),
});

/** Earlier revisions, newest first; `before` = `savedAt` of the last one loaded. */
export const revisions = ownerQuery({
  args: { articleId: v.id('articles'), before: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => await ops.revisionPage(ctx, args.articleId, args.before, args.limit),
});

/** One earlier revision with its full text. */
export const revision = ownerQuery({
  args: { revisionId: v.id('articleRevisions') },
  handler: async (ctx, args) => await ctx.db.get('articleRevisions', args.revisionId),
});

/** Where the page is mentioned (issues, other pages) and which issues it mentions itself. */
export const backlinks = ownerQuery({
  args: { articleId: v.id('articles') },
  handler: async (ctx, args) => await articleBacklinks(ctx, args.articleId),
});

/** Wiki pages related to an issue: linked from its description or comments, or linking to the issue. */
export const forIssue = ownerQuery({
  args: { issueId: v.id('issues') },
  handler: async (ctx, args) => await issueArticles(ctx, args.issueId),
});

export const search = ownerQuery({
  args: { q: v.string(), teamId: v.optional(v.id('teams')), limit: v.optional(v.number()) },
  handler: async (ctx, args) => await ops.searchArticles(ctx, args),
});

// ---------------------------------------------------------------- Pages

export const create = ownerWriteMutation({
  args: { ...newArticleValidator, ...requestIdArg },
  handler: async (ctx, args) => await ops.createArticle(ctx, ctx.actor, args),
});

/** Title, project (null = none), topics. */
export const update = ownerWriteMutation({
  args: {
    id: v.id('articles'),
    title: v.optional(v.string()),
    projectId: v.optional(v.union(v.id('projects'), v.null())),
    topicIds: v.optional(v.array(v.id('wikiTopics'))),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.updateArticle(ctx, ctx.actor, args),
});

/** Reparent (parentId, null = top level) and reorder (beforeId/afterId). */
export const move = ownerWriteMutation({
  args: {
    id: v.id('articles'),
    parentId: v.union(v.id('articles'), v.null()),
    beforeId: v.optional(v.id('articles')),
    afterId: v.optional(v.id('articles')),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.moveArticle(ctx, ctx.actor, args),
});

export const setBody = ownerWriteMutation({
  args: { id: v.id('articles'), markdown: v.string(), baseVersion: v.number(), ...requestIdArg },
  handler: async (ctx, args) => await ops.setArticleBody(ctx, ctx.actor, args),
});

export const restoreRevision = ownerWriteMutation({
  args: { revisionId: v.id('articleRevisions'), baseVersion: v.number(), ...requestIdArg },
  handler: async (ctx, args) => await ops.restoreRevision(ctx, ctx.actor, args),
});

export const remove = ownerWriteMutation({
  args: { id: v.id('articles'), ...requestIdArg },
  handler: async (ctx, args) => await ops.removeArticle(ctx, ctx.actor, args),
});

export const restore = ownerWriteMutation({
  args: { id: v.id('articles'), ...requestIdArg },
  handler: async (ctx, args) => await ops.restoreArticle(ctx, ctx.actor, args),
});

// ---------------------------------------------------------------- Sources

export const addSources = ownerWriteMutation({
  args: { articleId: v.id('articles'), sources: v.array(sourceInputValidator), ...requestIdArg },
  handler: async (ctx, args) => await ops.addSources(ctx, ctx.actor, args),
});

export const updateSource = ownerWriteMutation({
  args: { sourceId: v.id('articleSources'), patch: sourcePatchValidator, ...requestIdArg },
  handler: async (ctx, args) => await ops.updateSource(ctx, ctx.actor, args),
});

export const removeSource = ownerWriteMutation({
  args: { sourceId: v.id('articleSources'), ...requestIdArg },
  handler: async (ctx, args) => await ops.removeSource(ctx, ctx.actor, args),
});

export const reorderSources = ownerWriteMutation({
  args: { articleId: v.id('articles'), sourceIds: v.array(v.id('articleSources')), ...requestIdArg },
  handler: async (ctx, args) => await ops.reorderSources(ctx, ctx.actor, args),
});

// ---------------------------------------------------------------- Topics

export const createTopic = ownerWriteMutation({
  args: { teamId: v.id('teams'), name: v.string(), hue: v.optional(v.number()), ...requestIdArg },
  handler: async (ctx, args) => await ops.createTopic(ctx, ctx.actor, args),
});

export const updateTopic = ownerWriteMutation({
  args: {
    topicId: v.id('wikiTopics'),
    name: v.optional(v.string()),
    hue: v.optional(v.number()),
    archived: v.optional(v.boolean()),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.updateTopic(ctx, ctx.actor, args),
});
