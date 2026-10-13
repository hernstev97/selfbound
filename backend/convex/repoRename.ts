import { v } from 'convex/values';
import type { Doc, TableNames } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';

// Moves stored GitHub references from one repository name to another. Needed when a repository is
// renamed and its old name is then reused by another repository: GitHub's redirect from the old name
// ends at that moment, and stored references ("owner/name#51", PR URLs) would point at the new one.
//
// Driven page by page by tooling/rename-github-repo.mjs (dry run first, then --apply).
// Covers: pullRequests (repo, url), pullRequestDetails and pullRequestItems of those PRs (URLs),
// githubCheckRuns (repo, URLs) and history entries of linked pull requests. Free text in
// descriptions and comments is left alone (it is the user's text); the dry run counts such links.

const TABLES = ['pullRequests', 'githubCheckRuns', 'history', 'issueBodies', 'comments'] as const;
type Table = (typeof TABLES)[number];
const PAGE = 200;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrites every mention of `from` in a value (exact "owner/name", "owner/name#n", GitHub URLs). */
export function renameIn<T>(value: T, from: string, to: string): { value: T; changed: boolean } {
  const exact = from.toLowerCase();
  const url = new RegExp(`((?:https?://)?(?:www\\.)?(?:github\\.com|raw\\.githubusercontent\\.com|api\\.github\\.com/repos)/)${escape(from)}(?=[/#?"]|$)`, 'gi');
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const lower = x.toLowerCase();
      let out = x;
      if (lower === exact) out = to;
      else if (lower.startsWith(`${exact}#`)) out = `${to}${x.slice(from.length)}`;
      else out = x.replace(url, `$1${to}`);
      if (out !== x) changed = true;
      return out;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  const out = walk(value) as T;
  return { value: changed ? out : value, changed };
}

/** Text links only counted, never changed (see above). */
function mentions(text: string, from: string): boolean {
  return new RegExp(`github\\.com/${escape(from)}(?=[/#?]|$)`, 'i').test(text);
}

async function patchRenamed<T extends TableNames>(ctx: MutationCtx, doc: Doc<T>, from: string, to: string, apply: boolean): Promise<boolean> {
  const { _id, _creationTime, ...fields } = doc as Doc<T> & { _id: Doc<T>['_id']; _creationTime: number };
  const { value, changed } = renameIn(fields, from, to);
  if (changed && apply) await ctx.db.replace(_id, value as never);
  return changed;
}

export const step = internalMutation({
  args: {
    from: v.string(),
    to: v.string(),
    apply: v.boolean(),
    table: v.optional(v.union(v.literal('pullRequests'), v.literal('githubCheckRuns'), v.literal('history'), v.literal('issueBodies'), v.literal('comments'))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { from, to, apply, table = 'pullRequests', cursor = null }) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(from) || !/^[\w.-]+\/[\w.-]+$/.test(to)) throw new Error('from and to must look like "owner/name"');
    let changed = 0;
    let textLinks = 0;
    let isDone: boolean;
    let continueCursor: string;

    if (table === 'pullRequests') {
      // Also the details and items of each PR: their URLs name the repository.
      const page = await ctx.db.query('pullRequests').paginate({ cursor, numItems: 50 });
      for (const pr of page.page) {
        if (pr.repo.toLowerCase() !== from.toLowerCase()) continue;
        if (await patchRenamed(ctx, pr, from, to, apply)) changed++;
        for (const d of await ctx.db.query('pullRequestDetails').withIndex('by_pr', (q) => q.eq('prId', pr._id)).collect()) {
          if (await patchRenamed(ctx, d, from, to, apply)) changed++;
        }
        for (const item of await ctx.db.query('pullRequestItems').withIndex('by_pr_created', (q) => q.eq('prId', pr._id)).collect()) {
          if (await patchRenamed(ctx, item, from, to, apply)) changed++;
        }
      }
      ({ isDone, continueCursor } = page);
    } else if (table === 'githubCheckRuns' || table === 'history') {
      const page = await ctx.db.query(table).paginate({ cursor, numItems: PAGE });
      for (const doc of page.page) {
        if (table === 'history' && (doc as Doc<'history'>).field !== 'pull_request') continue;
        if (await patchRenamed(ctx, doc, from, to, apply)) changed++;
      }
      ({ isDone, continueCursor } = page);
    } else {
      const page = await ctx.db.query(table).paginate({ cursor, numItems: PAGE });
      for (const doc of page.page) {
        const text = table === 'issueBodies' ? (doc as Doc<'issueBodies'>).markdown : (doc as Doc<'comments'>).body;
        if (typeof text === 'string' && mentions(text, from)) textLinks++;
      }
      ({ isDone, continueCursor } = page);
    }

    const next = isDone ? TABLES[TABLES.indexOf(table) + 1] : table;
    return {
      table,
      changed,
      textLinks,
      next: next ? { table: next, cursor: isDone ? null : continueCursor } : null,
    };
  },
});
