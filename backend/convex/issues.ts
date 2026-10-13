import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { resolveIssue, teamKeys } from './lib/identifiers';
import {
  issuePatchValidator,
  newIssueValidator,
  requestIdArg,
  revertItemValidator,
} from './lib/validators';
import { readCounter, SEQ } from './lib/counters';
import { hasAllTerms, searchTerms, snippet } from './lib/search';
import { BUCKET_SIZE } from './shared/constants';
import { commentPage } from './ops/comments';
import * as ops from './ops/issues';
import { moveIssuesToTeam } from './ops/move';

// ---------------------------------------------------------------- Read

/** One bucket (up to 64 issues) via by_bucket, deleted ones included (the client filters). */
export const bucket = ownerQuery({
  args: { bucket: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query('issues')
      .withIndex('by_bucket', (q) => q.eq('bucket', args.bucket))
      .collect(),
});

/**
 * Highest seq and the newest buckets in one response. The client subscribes to this at startup
 * together with meta.get and meta.counter: the newest issues (at the top of almost every view)
 * arrive with the first response, one round trip before the bucket subscriptions even start.
 */
export const head = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const maxSeq = await readCounter(ctx, SEQ);
    const newest = maxSeq < 0 ? -1 : Math.floor(maxSeq / BUCKET_SIZE);
    // The two newest buckets: the very newest one can be almost empty.
    const buckets = [];
    for (let bucket = newest; bucket >= 0 && bucket > newest - 2; bucket--) {
      buckets.push({ bucket, docs: await ctx.db.query('issues').withIndex('by_bucket', (q) => q.eq('bucket', bucket)).collect() });
    }
    return { maxSeq, buckets };
  },
});

/** Identifier ("KIU-106", "kiu106", an old identifier) or ID → issue ID, otherwise null. */
export const resolve = ownerQuery({
  args: { identifier: v.string() },
  handler: async (ctx, args) => {
    const issue = await resolveIssue(ctx, args.identifier);
    if (!issue) return null;
    return { id: issue._id, identifier: await teamKeys(ctx)(issue) };
  },
});

/**
 * Everything needed only when an issue is opened: description, comments (the newest 100,
 * older ones via comments.page), relations, PRs, history, sprints.
 */
export const detail = ownerQuery({
  args: { id: v.id('issues') },
  handler: async (ctx, { id }) => {
    const issue = await ctx.db.get('issues', id);
    if (!issue) return null;
    const identifier = teamKeys(ctx);
    const [body, commentsPage, outgoing, incoming, links, history, sprintEntries] = await Promise.all([
      ctx.db
        .query('issueBodies')
        .withIndex('by_issue', (q) => q.eq('issueId', id))
        .unique(),
      commentPage(ctx, id, null),
      ctx.db
        .query('relations')
        .withIndex('by_from', (q) => q.eq('fromId', id))
        .take(500),
      ctx.db
        .query('relations')
        .withIndex('by_to', (q) => q.eq('toId', id))
        .take(500),
      ctx.db
        .query('issuePullRequests')
        .withIndex('by_issue', (q) => q.eq('issueId', id))
        .take(200),
      ctx.db
        .query('history')
        .withIndex('by_issue', (q) => q.eq('issueId', id))
        .order('desc')
        .take(100),
      ctx.db
        .query('sprintItems')
        .withIndex('by_issue', (q) => q.eq('issueId', id))
        .take(200),
    ]);
    const brief = async (otherId: Id<'issues'>) => {
      const other = await ctx.db.get('issues', otherId);
      if (!other) return null;
      return {
        id: other._id,
        identifier: await identifier(other),
        title: other.title,
        status: other.status,
        teamId: other.teamId,
        deleted: other.deletedAt !== undefined,
      };
    };
    const relations = [];
    for (const [rows, direction] of [
      [outgoing, 'out'],
      [incoming, 'in'],
    ] as const) {
      for (const relation of rows) {
        const other = await brief(direction === 'out' ? relation.toId : relation.fromId);
        if (other) relations.push({ id: relation._id, type: relation.type, direction, createdAt: relation.createdAt, other });
      }
    }
    const pullRequests = [];
    for (const link of links) {
      const pr = await ctx.db.get('pullRequests', link.prId);
      if (pr) pullRequests.push({ ...pr, via: link.via, closes: link.closes });
    }
    const sprints = [];
    for (const entry of sprintEntries) {
      const sprint = await ctx.db.get('sprints', entry.sprintId);
      if (sprint) {
        sprints.push({
          ...entry,
          sprint: { _id: sprint._id, number: sprint.number, name: sprint.name, state: sprint.state },
        });
      }
    }
    return {
      id,
      identifier: await identifier(issue),
      body: body
        ? { markdown: body.markdown, version: body.version, updatedAt: body.updatedAt, updatedBy: body.updatedBy }
        : { markdown: '', version: 0, updatedAt: issue.createdAt, updatedBy: issue.createdBy },
      comments: commentsPage.comments,
      commentsHasMore: commentsPage.hasMore,
      relations,
      pullRequests,
      history,
      sprints: sprints.sort((a, b) => a.addedAt - b.addedAt),
    };
  },
});

/**
 * Earlier versions of the description that the import overwrote (`import_overwrite`), and
 * Linear versions not applied because of a conflict (`import_conflict`). Newest first, at most
 * 20, each with the full text.
 */
export const revisions = ownerQuery({
  args: { id: v.id('issues') },
  handler: async (ctx, { id }) => {
    const rows = await ctx.db
      .query('bodyRevisions')
      .withIndex('by_issue', (q) => q.eq('issueId', id))
      .order('desc')
      .take(20);
    return rows.map((r) => ({ id: r._id, markdown: r.markdown, version: r.version, reason: r.reason, at: r.at, actor: r.actor }));
  },
});

/**
 * Full-text search for "/": title, description and comments via the search indexes.
 * The search indexes find documents with ANY of the words, so several words bring many fuzzy
 * title hits. Hits that contain ALL words therefore come first (title, then description, then
 * comment), followed by the rest in the same order. That way description and comment hits are
 * not lost behind 20 titles. Issues in the trash are left out.
 */
export const search = ownerQuery({
  args: { q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const text = args.q.trim().slice(0, 200);
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)));
    if (!text) return [];
    const terms = searchTerms(text);
    // More candidates than slots: the strict hits are not always at the front.
    const pool = Math.min(200, limit * 5);
    const [titles, bodies, comments] = await Promise.all([
      ctx.db
        .query('issues')
        .withSearchIndex('search_title', (q) => q.search('title', text))
        .take(pool),
      ctx.db
        .query('bodySearch')
        .withSearchIndex('search_text', (q) => q.search('text', text))
        .take(pool),
      ctx.db
        .query('comments')
        .withSearchIndex('search_comment', (q) => q.search('body', text))
        .take(pool),
    ]);
    type Match = 'title' | 'description' | 'comment';
    type Candidate = { issueId: Id<'issues'>; issue?: Doc<'issues'>; match: Match; source?: string; all: boolean };
    const candidates: Candidate[] = [
      ...titles.map((issue) => ({ issueId: issue._id, issue, match: 'title' as const, all: hasAllTerms(issue.title, terms) })),
      ...bodies.map((body) => ({ issueId: body.issueId, match: 'description' as const, source: body.text, all: hasAllTerms(body.text, terms) })),
      ...comments
        .filter((c) => c.deletedAt === undefined)
        .map((c) => ({ issueId: c.issueId, match: 'comment' as const, source: c.body, all: hasAllTerms(c.body, terms) })),
    ];
    // Stable sort: all words before single words, otherwise title → description → comment.
    const ordered = [...candidates.filter((c) => c.all), ...candidates.filter((c) => !c.all)];
    const identifier = teamKeys(ctx);
    const seen = new Set<Id<'issues'>>();
    const out: {
      id: Id<'issues'>;
      identifier: string;
      title: string;
      status: Doc<'issues'>['status'];
      teamId: Id<'teams'>;
      match: Match;
      snippet?: string;
    }[] = [];
    for (const c of ordered) {
      if (out.length >= limit) break;
      if (seen.has(c.issueId)) continue;
      const issue = c.issue ?? (await ctx.db.get('issues', c.issueId));
      if (!issue || issue.deletedAt !== undefined) continue;
      seen.add(issue._id);
      out.push({
        id: issue._id,
        identifier: await identifier(issue),
        title: issue.title,
        status: issue.status,
        teamId: issue.teamId,
        match: c.match,
        ...(c.source ? { snippet: snippet(c.source, terms) } : {}),
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------- Write

export const create = ownerWriteMutation({
  args: { issues: v.array(newIssueValidator), ...requestIdArg },
  handler: async (ctx, args) => await ops.createIssues(ctx, ctx.actor, args),
});

/**
 * Sharing from another app (Web Share Target): one issue that lands in the inbox, in triage if
 * the team has a triage status. Same requestId = no second issue.
 */
export const share = ownerWriteMutation({
  args: { teamId: v.id('teams'), title: v.string(), description: v.optional(v.string()), ...requestIdArg },
  handler: async (ctx, args) =>
    await ops.createIssues(
      ctx,
      ctx.actor,
      { issues: [{ teamId: args.teamId, title: args.title, description: args.description }], requestId: args.requestId },
      { inbox: true },
    ),
});

export const update = ownerWriteMutation({
  args: {
    ids: v.array(v.id('issues')),
    patch: issuePatchValidator,
    expect: v.optional(v.array(issuePatchValidator)),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.updateIssues(ctx, ctx.actor, args),
});

export const revert = ownerWriteMutation({
  args: { items: v.array(revertItemValidator), ...requestIdArg },
  handler: async (ctx, args) => await ops.revertIssues(ctx, ctx.actor, args),
});

export const setDescription = ownerWriteMutation({
  args: { id: v.id('issues'), markdown: v.string(), baseVersion: v.number(), ...requestIdArg },
  handler: async (ctx, args) => await ops.setDescription(ctx, ctx.actor, args),
});

export const remove = ownerWriteMutation({
  args: { ids: v.array(v.id('issues')), ...requestIdArg },
  handler: async (ctx, args) => await ops.removeIssues(ctx, ctx.actor, args),
});

export const restore = ownerWriteMutation({
  args: { ids: v.array(v.id('issues')), ...requestIdArg },
  handler: async (ctx, args) => await ops.restoreIssues(ctx, ctx.actor, args),
});

export const markReviewed = ownerWriteMutation({
  args: { ids: v.array(v.id('issues')), ...requestIdArg },
  handler: async (ctx, args) => await ops.markReviewed(ctx, ctx.actor, args),
});

export const markUnreviewed = ownerWriteMutation({
  args: { ids: v.array(v.id('issues')), ...requestIdArg },
  handler: async (ctx, args) => await ops.markUnreviewed(ctx, ctx.actor, args),
});

export const markRead = ownerWriteMutation({
  args: { ids: v.array(v.id('issues')), read: v.boolean(), ...requestIdArg },
  handler: async (ctx, args) => await ops.markRead(ctx, ctx.actor, args),
});

export const reorder = ownerWriteMutation({
  args: {
    id: v.id('issues'),
    beforeId: v.optional(v.id('issues')),
    afterId: v.optional(v.id('issues')),
    ...requestIdArg,
  },
  handler: async (ctx, args) => await ops.reorderIssue(ctx, ctx.actor, args),
});

/** Move to another team: new identifier, the old one stays as an alias (triage "accept into …"). */
export const moveTeam = ownerWriteMutation({
  args: { ids: v.array(v.id('issues')), teamId: v.id('teams'), ...requestIdArg },
  handler: async (ctx, args) => await moveIssuesToTeam(ctx, ctx.actor, args),
});
