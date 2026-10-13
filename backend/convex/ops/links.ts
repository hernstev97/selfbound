import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { aliasKey } from '../lib/identifiers';
import { articleIdsIn, issueRefsIn } from '../shared/links';

// Links between knowledge pages and issues, for "Mentioned in" on the page and the knowledge
// section on the issue. Maintained like the image references (ops/files.ts): every write path of
// a text calls `syncArticleLinks(ctx, source, text)`, and on delete with `text = null`.
//
// - From descriptions and comments: links to knowledge pages (/wiki/<id>, older /wissen/<id>).
// - From a page's text: links to other pages and to issues (/issue/ABC-12 and bare identifiers
//   of known teams). The issueId is stored, so moving an issue to another team breaks nothing.
// Without a page path in the text and without old links, an issue text costs one index query.

export type LinkSource =
  | { kind: 'article'; id: Id<'articles'> }
  | { kind: 'body'; id: Id<'issueBodies'>; issueId: Id<'issues'> }
  | { kind: 'comment'; id: Id<'comments'>; issueId: Id<'issues'> };

type Target = { toArticleId: Id<'articles'> } | { toIssueId: Id<'issues'> };
const keyOf = (t: { toArticleId?: string; toIssueId?: string }) => (t.toArticleId ? `a:${t.toArticleId}` : `i:${t.toIssueId}`);

async function issueByRef(ctx: QueryCtx, ref: string, teams: Map<string, Id<'teams'>>) {
  const [key, n] = ref.split('-');
  const teamId = teams.get(key!);
  const number = Number(n);
  if (teamId) {
    const issue = await ctx.db
      .query('issues')
      .withIndex('by_team_number', (q) => q.eq('teamId', teamId).eq('number', number))
      .unique();
    if (issue) return issue;
  }
  const alias = await ctx.db
    .query('identifierAliases')
    .withIndex('by_key', (q) => q.eq('key', aliasKey(key!, number)))
    .first();
  return alias ? await ctx.db.get('issues', alias.issueId) : null;
}

async function targetsOf(ctx: QueryCtx, source: LinkSource, text: string): Promise<Target[]> {
  const out: Target[] = [];
  for (const raw of articleIdsIn(text)) {
    const id = ctx.db.normalizeId('articles', raw);
    if (!id || id === source.id) continue;
    if (await ctx.db.get('articles', id)) out.push({ toArticleId: id });
  }
  if (source.kind !== 'article') return out;
  const teams = new Map((await ctx.db.query('teams').take(500)).map((t) => [t.key, t._id]));
  const seen = new Set<Id<'issues'>>();
  for (const ref of issueRefsIn(text, new Set(teams.keys()))) {
    const issue = await issueByRef(ctx, ref, teams);
    if (!issue || seen.has(issue._id)) continue;
    seen.add(issue._id);
    out.push({ toIssueId: issue._id });
  }
  return out;
}

/** Syncs the links of a text; `text = null`: the text is gone. */
export async function syncArticleLinks(ctx: MutationCtx, source: LinkSource, text: string | null) {
  const existing = await ctx.db
    .query('articleLinks')
    .withIndex('by_from', (q) => q.eq('from', source.id))
    .collect();
  const wanted = text ? await targetsOf(ctx, source, text) : [];
  if (wanted.length === 0 && existing.length === 0) return;
  const want = new Map(wanted.map((t) => [keyOf(t), t]));
  for (const row of existing) {
    if (want.has(keyOf(row))) want.delete(keyOf(row));
    else await ctx.db.delete('articleLinks', row._id);
  }
  for (const target of want.values()) {
    await ctx.db.insert('articleLinks', {
      from: source.id,
      fromKind: source.kind,
      ...(source.kind === 'article' ? { fromArticleId: source.id } : { fromIssueId: source.issueId }),
      ...target,
    });
  }
}

/** Removes links to a target (the target was purged). */
export async function dropLinksTo(ctx: MutationCtx, target: { articleId: Id<'articles'> } | { issueId: Id<'issues'> }) {
  const rows =
    'articleId' in target
      ? await ctx.db.query('articleLinks').withIndex('by_to_article', (q) => q.eq('toArticleId', target.articleId)).collect()
      : await ctx.db.query('articleLinks').withIndex('by_to_issue', (q) => q.eq('toIssueId', target.issueId)).collect();
  for (const row of rows) await ctx.db.delete('articleLinks', row._id);
}

const LINKS_MAX = 200;

export type IssueRef = { id: Id<'issues'>; identifier: string; title: string; status: Doc<'issues'>['status']; stateId: Doc<'issues'>['stateId'] };

/**
 * Where a page is mentioned: issues (description or comment) and other pages, excluding the
 * trash. Plus the issues the page itself links to.
 */
export async function articleBacklinks(ctx: QueryCtx, articleId: Id<'articles'>) {
  const [incoming, outgoing] = await Promise.all([
    ctx.db.query('articleLinks').withIndex('by_to_article', (q) => q.eq('toArticleId', articleId)).take(LINKS_MAX),
    ctx.db.query('articleLinks').withIndex('by_from', (q) => q.eq('from', articleId)).take(LINKS_MAX),
  ]);
  const keys = new Map<Id<'teams'>, string>();
  const teamKey = async (teamId: Id<'teams'>) => {
    if (!keys.has(teamId)) keys.set(teamId, (await ctx.db.get('teams', teamId))?.key ?? '?');
    return keys.get(teamId)!;
  };
  const issues = new Map<Id<'issues'>, IssueRef>();
  const pages = new Map<Id<'articles'>, { id: Id<'articles'>; title: string }>();
  const addIssue = async (map: Map<Id<'issues'>, IssueRef>, id: Id<'issues'> | undefined) => {
    if (!id || map.has(id)) return;
    const issue = await ctx.db.get('issues', id);
    if (!issue || issue.deletedAt !== undefined) return;
    map.set(id, { id, identifier: `${await teamKey(issue.teamId)}-${issue.number}`, title: issue.title, status: issue.status, stateId: issue.stateId });
  };
  for (const row of incoming) {
    if (row.fromArticleId) {
      if (pages.has(row.fromArticleId)) continue;
      const page = await ctx.db.get('articles', row.fromArticleId);
      if (page && page.deletedAt === undefined) pages.set(page._id, { id: page._id, title: page.title });
    } else await addIssue(issues, row.fromIssueId);
  }
  const mentions = new Map<Id<'issues'>, IssueRef>();
  for (const row of outgoing) await addIssue(mentions, row.toIssueId);
  return { issues: [...issues.values()], pages: [...pages.values()], mentions: [...mentions.values()] };
}

/** Knowledge pages for an issue: linked from its texts, or linking to the issue. */
export async function issueArticles(ctx: QueryCtx, issueId: Id<'issues'>) {
  const [fromIssue, toIssue] = await Promise.all([
    ctx.db.query('articleLinks').withIndex('by_from_issue', (q) => q.eq('fromIssueId', issueId)).take(LINKS_MAX),
    ctx.db.query('articleLinks').withIndex('by_to_issue', (q) => q.eq('toIssueId', issueId)).take(LINKS_MAX),
  ]);
  const out = new Map<Id<'articles'>, { id: Id<'articles'>; title: string; teamId: Id<'teams'>; via: 'linked' | 'mentions' }>();
  const add = async (id: Id<'articles'> | undefined, via: 'linked' | 'mentions') => {
    if (!id || out.has(id)) return;
    const page = await ctx.db.get('articles', id);
    if (page && page.deletedAt === undefined) out.set(id, { id, title: page.title, teamId: page.teamId, via });
  };
  for (const row of fromIssue) await add(row.toArticleId, 'linked');
  for (const row of toIssue) await add(row.fromArticleId, 'mentions');
  return [...out.values()];
}
