import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { capChecks, mergeChecks, PR_LIMITS, type PrSnapshot } from '../lib/githubApi';
import { clipHtml, clipItemsHtml, rewriteMedia, type MediaEntry, type MediaState } from '../lib/githubMedia';
import { checkCounts, type PrDetail, type PrItem, type PrSummary, type PrView } from '../shared/pullRequests';
import { closeIssuesOnMerge, detailOf, githubConfigured } from './github';

// Pull requests in Selfbound: read state from the GitHub API and store it.
//
// - `pullRequests` stays the source for title, state and links. A fetch updates title, branch,
//   head commit and state. It handles the transition to "merged" like the webhook
//   (closeIssuesOnMerge), so issues still get closed when the fetch arrives before the webhook.
//   Whoever comes first closes; the other sees "already merged". If the merge is more than a day
//   old (e.g. an imported PR that never saw a webhook), the fetch only updates the state and
//   closes nothing.
// - `pullRequestDetails` holds the latest state (`data`), errors, media and the debounce.
// - `pullRequestItems` holds comments, reviews and line comments, reconciled by `key`.

/** A merge older than this no longer closes issues on fetch. */
export const MERGE_CLOSE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** GitHub is still computing mergeability: refetch this many times at this interval. */
export const MERGE_RETRIES = 2;
export const MERGE_RETRY_MS = 3000;

/** Fields without undefined (for inserts; in a patch, undefined removes a field). */
const defined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const siteUrl = () => (process.env.CONVEX_SITE_URL ?? '').replace(/\/+$/, '');

async function prByRepoNumber(ctx: QueryCtx, repo: string, number: number) {
  return await ctx.db
    .query('pullRequests')
    .withIndex('by_repo_number', (q) => q.eq('repo', repo).eq('number', number))
    .unique();
}

const ITEM_KEYS = ['key', 'kind', 'author', 'html', 'createdAt', 'updatedAt', 'url', 'reviewState', 'path', 'line', 'replyTo'] as const;

/** PrItem from a document (without _id, prId …), normalized for comparison. */
function itemOf(doc: PrItem): PrItem {
  const out: Record<string, unknown> = {};
  for (const key of ITEM_KEYS) {
    const value = doc[key];
    if (value !== undefined) out[key] = key === 'author' ? { ...(value as object) } : value;
  }
  return out as unknown as PrItem;
}

const sameItem = (a: PrItem, b: PrItem) => JSON.stringify(normalize(itemOf(a))) === JSON.stringify(normalize(itemOf(b)));
const normalize = (item: PrItem) => {
  const a = item.author;
  return { ...item, author: { login: a.login, avatarUrl: a.avatarUrl, bot: a.bot, url: a.url } };
};

function detailFromRow(row: Doc<'pullRequestDetails'> | null): PrDetail | null {
  if (!row?.data || row.fetchedAt === undefined) return null;
  return { ...row.data, fetchedAt: row.fetchedAt, ...(row.error ? { error: row.error } : {}) };
}

// ---------------------------------------------------------------- Reading

export async function prView(ctx: QueryCtx, repo: string, number: number): Promise<PrView | null> {
  const pr = await prByRepoNumber(ctx, repo, number);
  if (!pr) return null;
  const row = await detailOf(ctx, pr._id);
  const items = await ctx.db
    .query('pullRequestItems')
    .withIndex('by_pr_created', (q) => q.eq('prId', pr._id))
    .take(PR_LIMITS.items + 50);
  return {
    pr: {
      id: pr._id,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      branch: pr.branch,
      ...(pr.author ? { author: pr.author } : {}),
      updatedAt: pr.updatedAt,
      ...(pr.mergedAt !== undefined ? { mergedAt: pr.mergedAt } : {}),
    },
    detail: detailFromRow(row),
    items: items.map(itemOf),
    configured: githubConfigured(),
    ...(row?.error ? { error: row.error } : {}),
  };
}

export const SUMMARIES_MAX = 20;

export async function prSummaries(ctx: QueryCtx, prIds: Id<'pullRequests'>[]): Promise<PrSummary[]> {
  const out: PrSummary[] = [];
  for (const prId of prIds.slice(0, SUMMARIES_MAX)) {
    const pr = await ctx.db.get('pullRequests', prId);
    if (!pr) continue;
    const row = await detailOf(ctx, prId);
    out.push({
      id: pr._id,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      branch: pr.branch,
      ...(pr.author ? { author: pr.author } : {}),
      updatedAt: pr.updatedAt,
      ...(row?.data ? { mergeState: row.data.mergeState, checks: checkCounts(row.data.checks) } : {}),
      ...(row?.summary?.review ? { review: row.summary.review } : {}),
      ...(row?.summary ? { comments: row.summary.comments } : {}),
      ...(row?.fetchedAt !== undefined ? { fetchedAt: row.fetchedAt } : {}),
    });
  }
  return out;
}

/** What an action needs to know about a PR (repo, number, state, latest state, media key). */
export async function prTarget(ctx: QueryCtx, prId: Id<'pullRequests'>) {
  const pr = await ctx.db.get('pullRequests', prId);
  if (!pr) return null;
  const row = await detailOf(ctx, prId);
  const data = row?.data;
  return {
    repo: pr.repo,
    number: pr.number,
    state: pr.state,
    ...(data?.headSha || pr.headSha ? { headSha: data?.headSha || pr.headSha } : {}),
    ...(row?.mediaKey ? { mediaKey: row.mediaKey } : {}),
    ...(data
      ? {
          detail: {
            headRef: data.headRef,
            headBranchDeletable: data.headBranchDeletable,
            deleteBranchOnMerge: data.deleteBranchOnMerge,
          },
        }
      : {}),
  };
}

/** A fetch counts as running for this long (afterwards another call may fetch again). */
export const FETCHING_MS = 30_000;
/** Write `viewedAt` at most this often (every change reloads the view). */
const VIEWED_WRITE_MS = 5 * 60_000;

/**
 * Claims fetches so concurrent calls (list and view, webhook) don't fetch twice. A PR is skipped if
 * a fetch has finished since `notBefore` or has been running since `notBefore` (`fetchingSince`,
 * valid for 30 s). For the rest it sets `fetchingSince = now` and returns them.
 * `viewed`: call from the UI, sets `viewedAt` (webhooks then fetch the PR for 30 min).
 */
export async function claimRefresh(
  ctx: MutationCtx,
  prIds: Id<'pullRequests'>[],
  opts: { notBefore: number; now: number; viewed?: boolean },
): Promise<Id<'pullRequests'>[]> {
  const out: Id<'pullRequests'>[] = [];
  for (const prId of prIds) {
    if (!(await ctx.db.get('pullRequests', prId))) continue;
    const row = await detailOf(ctx, prId);
    const viewedAt = opts.viewed && (row?.viewedAt === undefined || opts.now - row.viewedAt > VIEWED_WRITE_MS) ? { viewedAt: opts.now } : {};
    const done = row?.fetchedAt !== undefined && row.fetchedAt >= opts.notBefore;
    const running = row?.fetchingSince !== undefined && row.fetchingSince >= opts.notBefore && opts.now - row.fetchingSince < FETCHING_MS;
    if (done || running) {
      if (row && 'viewedAt' in viewedAt) await ctx.db.patch('pullRequestDetails', row._id, viewedAt);
      continue;
    }
    if (row) await ctx.db.patch('pullRequestDetails', row._id, { fetchingSince: opts.now, ...viewedAt });
    else await ctx.db.insert('pullRequestDetails', { prId, media: [], fetchingSince: opts.now, ...viewedAt });
    out.push(prId);
  }
  return out;
}

// ---------------------------------------------------------------- Storing

export interface StoreArgs {
  prId: Id<'pullRequests'>;
  fetchedAt: number;
  /** new key in case the PR has none yet (randomness only in actions) */
  mediaKey: string;
  snapshot?: PrSnapshot;
  error?: string;
}

/** Clips items: each at most itemBytes, all together at most itemsTotalBytes (newest first). */
export function clipItems(items: PrItem[]): PrItem[] {
  return clipItemsHtml(items, PR_LIMITS.itemBytes, PR_LIMITS.itemsTotalBytes);
}

/**
 * Stores the result of a fetch (internal mutation `githubPr.store`). On error only `error` and
 * `fetchedAt`; the previous state stays. Returns whether a retry (mergeability) was scheduled and
 * which issues the merge closed.
 */
export async function storeSnapshot(ctx: MutationCtx, args: StoreArgs, now = Date.now()) {
  const pr = await ctx.db.get('pullRequests', args.prId);
  if (!pr) return { stored: false, retry: false, closed: [] as string[] };
  const row = await detailOf(ctx, args.prId);
  // An older fetch (that finished later) doesn't overwrite a newer one.
  if (row?.fetchedAt !== undefined && args.fetchedAt < row.fetchedAt) return { stored: false, retry: false, closed: [] as string[] };
  // A scheduled fetch is done; a newer one (refreshAt in the future) stays.
  const refreshDone = row?.refreshAt !== undefined && row.refreshAt <= now;
  // "running" only applies to the fetch finishing now (or older ones).
  const fetchingDone = row?.fetchingSince !== undefined && row.fetchingSince <= args.fetchedAt ? { fetchingSince: undefined } : {};

  if (!args.snapshot) {
    const error = args.error || 'Fetching from GitHub failed.';
    if (row)
      await ctx.db.patch('pullRequestDetails', row._id, {
        fetchedAt: args.fetchedAt,
        error,
        ...(refreshDone ? { refreshAt: undefined } : {}),
        ...fetchingDone,
      });
    else await ctx.db.insert('pullRequestDetails', { prId: args.prId, media: [], fetchedAt: args.fetchedAt, error });
    return { stored: true, retry: false, closed: [] as string[] };
  }

  const snap = args.snapshot;
  const mediaKey = row?.mediaKey ?? args.mediaKey;
  const media: MediaEntry[] = (row?.media ?? []).map((m) => ({ ...m }));
  const state: MediaState = { siteUrl: siteUrl(), mediaKey, repo: pr.repo, media, now: args.fetchedAt, source: 'body' };
  const prUrl = snap.url ?? pr.url;
  const bodyHtml = clipHtml(rewriteMedia(snap.detail.bodyHtml, state), PR_LIMITS.bodyBytes, prUrl);
  const items = clipItems(
    snap.items.slice(-PR_LIMITS.items).map((item) => {
      state.source = item.key;
      return { ...item, html: rewriteMedia(item.html, state) };
    }),
  );

  // Check runs from webhook deliveries (third-party apps; fine-grained tokens can't read them through the API)
  const webhookRuns = snap.detail.headSha
    ? await ctx.db
        .query('githubCheckRuns')
        .withIndex('by_repo_sha', (q) => q.eq('repo', pr.repo).eq('headSha', snap.detail.headSha))
        .take(200)
    : [];
  const checks = capChecks(mergeChecks(snap.detail.checks, webhookRuns.map((r) => r.check)));
  const data = { ...snap.detail, bodyHtml, checks };

  // Mergeability still unknown: again in 3 s (at most twice).
  const open = snap.state === 'open' || snap.state === 'draft';
  const retries = row?.mergeRetries ?? 0;
  const retry = open && data.mergeState === 'unknown' && retries < MERGE_RETRIES && githubConfigured();
  const pendingRefresh = row?.refreshAt !== undefined && row.refreshAt > now;
  const fields = {
    mediaKey,
    media,
    fetchedAt: args.fetchedAt,
    error: snap.warnings.length ? snap.warnings.join(' ') : undefined,
    data,
    summary: snap.summary,
    mergeRetries: retry ? retries + 1 : undefined,
    refreshAt: retry && !pendingRefresh ? now + MERGE_RETRY_MS : refreshDone ? undefined : row?.refreshAt,
    ...fetchingDone,
  };
  if (row) await ctx.db.patch('pullRequestDetails', row._id, fields);
  else await ctx.db.insert('pullRequestDetails', { prId: args.prId, ...defined(fields) });
  if (retry && !pendingRefresh) await ctx.scheduler.runAfter(MERGE_RETRY_MS, internal.githubPr.refreshOne, { prId: args.prId, since: now });

  // ---- Reconcile items: insert new, replace changed, delete vanished
  const existing = await ctx.db
    .query('pullRequestItems')
    .withIndex('by_pr_created', (q) => q.eq('prId', args.prId))
    .take(1000);
  const byKey = new Map(existing.map((d) => [d.key, d]));
  for (const item of items) {
    const doc = byKey.get(item.key);
    if (!doc) {
      await ctx.db.insert('pullRequestItems', { prId: args.prId, ...item });
      continue;
    }
    byKey.delete(item.key);
    if (!sameItem(doc, item)) await ctx.db.replace('pullRequestItems', doc._id, { prId: args.prId, ...item });
  }
  for (const doc of byKey.values()) await ctx.db.delete('pullRequestItems', doc._id);

  // ---- Update pullRequests
  const patch: Partial<Doc<'pullRequests'>> = {};
  if (snap.title && snap.title !== pr.title) patch.title = snap.title;
  if (snap.branch && snap.branch !== pr.branch) patch.branch = snap.branch;
  if (data.headSha && data.headSha !== pr.headSha) patch.headSha = data.headSha;
  let newlyMerged = false;
  if (pr.state !== 'merged') {
    if (snap.state === 'merged') {
      patch.state = 'merged';
      if (snap.mergedAt !== undefined) patch.mergedAt = snap.mergedAt;
      newlyMerged = true;
    } else if (snap.state !== pr.state && (snap.updatedAt ?? 0) >= pr.updatedAt) {
      patch.state = snap.state;
    }
  }
  if (snap.updatedAt !== undefined && snap.updatedAt > pr.updatedAt) patch.updatedAt = snap.updatedAt;
  if (Object.keys(patch).length > 0) await ctx.db.patch('pullRequests', pr._id, patch);
  let closed: string[] = [];
  if (newlyMerged && snap.mergedAt !== undefined && now - snap.mergedAt <= MERGE_CLOSE_WINDOW_MS) {
    closed = await closeIssuesOnMerge(ctx, pr._id, { ref: `${pr.repo}#${pr.number}`, number: pr.number, title: patch.title ?? pr.title }, now);
  }
  return { stored: true, retry, closed };
}

// ---------------------------------------------------------------- Media proxy

/** Entry for GET /ghmedia/<key>/<index> and the other attachments from the same post. */
export async function mediaTarget(ctx: QueryCtx, key: string, index: number) {
  if (!key) return null;
  const row = await ctx.db
    .query('pullRequestDetails')
    .withIndex('by_media_key', (q) => q.eq('mediaKey', key))
    .unique();
  const entry = row?.media[index];
  if (!row || !entry) return null;
  const pr = await ctx.db.get('pullRequests', row.prId);
  if (!pr) return null;
  const siblings =
    entry.kind === 'attachment' && entry.source
      ? row.media.flatMap((m, i) => (m.kind === 'attachment' && m.source === entry.source ? [{ index: i, url: m.url }] : []))
      : [];
  return { entry, repo: pr.repo, number: pr.number, siblings };
}

async function detailByKey(ctx: QueryCtx, key: string) {
  return await ctx.db
    .query('pullRequestDetails')
    .withIndex('by_media_key', (q) => q.eq('mediaKey', key))
    .unique();
}

/** Stores fresh signed URLs (from the proxy after refetching a post). */
export async function updateSigned(ctx: MutationCtx, key: string, updates: { index: number; url: string }[], signedAt: number) {
  const row = await detailByKey(ctx, key);
  if (!row) return;
  const media = row.media.map((m) => ({ ...m }));
  let changed = false;
  for (const u of updates) {
    const entry = media[u.index];
    if (!entry || entry.kind !== 'attachment' || (entry.signedAt ?? 0) > signedAt) continue;
    const { resigningAt: _, ...rest } = entry;
    media[u.index] = { ...rest, url: u.url, signedAt };
    changed = true;
  }
  if (changed) await ctx.db.patch('pullRequestDetails', row._id, { media });
}

/** Briefly remembers a fetched download_url of a repo file (so the proxy doesn't query the Contents API every time). */
export async function cacheResolved(ctx: MutationCtx, key: string, index: number, url: string, at: number) {
  const row = await detailByKey(ctx, key);
  const entry = row?.media[index];
  if (!row || !entry || entry.kind !== 'repo' || (entry.resolvedAt ?? 0) >= at) return;
  const media = row.media.map((m, i) => (i === index ? { ...m, resolved: url, resolvedAt: at } : m));
  await ctx.db.patch('pullRequestDetails', row._id, { media });
}

/** "Being refetched" holds for this long; afterwards another call may fetch itself. */
export const RESIGN_MS = 10_000;

/**
 * Claims re-signing an attachment. Result: `fresh` (another call was faster, here is the URL), `wait`
 * (another call is fetching the same post) or `go` (fetch yourself; marks all attachments of the
 * same post).
 */
export async function claimResign(
  ctx: MutationCtx,
  key: string,
  index: number,
  now: number,
  freshMs: number,
): Promise<{ kind: 'fresh'; url: string; signedAt: number } | { kind: 'wait' } | { kind: 'go' } | null> {
  const row = await detailByKey(ctx, key);
  const entry = row?.media[index];
  if (!row || !entry || entry.kind !== 'attachment') return null;
  if (entry.signedAt !== undefined && now - entry.signedAt < freshMs) return { kind: 'fresh', url: entry.url, signedAt: entry.signedAt };
  if (entry.resigningAt !== undefined && now - entry.resigningAt < RESIGN_MS) return { kind: 'wait' };
  const media = row.media.map((m, i) =>
    i === index || (m.kind === 'attachment' && entry.source !== undefined && m.source === entry.source) ? { ...m, resigningAt: now } : m,
  );
  await ctx.db.patch('pullRequestDetails', row._id, { media });
  return { kind: 'go' };
}
