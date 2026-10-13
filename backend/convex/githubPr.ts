import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, type ActionCtx } from './_generated/server';
import { isLocalDeployment, ownerAction, ownerQuery } from './lib/auth';
import { fail, invalid, notFound, type ErrorCode } from './lib/errors';
import {
  createComment,
  deleteBranch,
  ensureRepoWebhooks,
  fetchPullRequest,
  fileDownloadUrl,
  githubClient,
  GithubApiError,
  mergePullRequest,
  NOT_CONFIGURED,
  PR_LIMITS,
  capChecks,
  setPullRequestState,
  sourceHtml,
  type PrSnapshot,
  type WebhookReport,
} from './lib/githubApi';
import { attachmentUuid, clipHtml, clipItemsHtml, findSignedUrl, repoFileTarget, SIGNED_FRESH_MS } from './lib/githubMedia';
import { randomId } from './lib/keys';
import { readOpsStatus, writeOpsStatus } from './ops/maintenance';
import {
  cacheResolved as saveResolved,
  claimRefresh,
  claimResign as claimResignOp,
  mediaTarget as findMedia,
  prSummaries,
  prTarget,
  prView,
  storeSnapshot,
  updateSigned as saveSigned,
} from './ops/githubPr';
import { mergeMethodValidator, prItemValidator, prDetailDataValidator, prStateValidator } from './schema';
import type { GithubConnection, PrSummary, PrView } from './shared/pullRequests';

// Pull requests in XLR8: view, summaries, fetching through the GitHub API, actions (merge,
// close/reopen, comment) and the webhooks in all repos of the token.
// Access only through the instance's GITHUB_TOKEN (fine-grained PAT); the token never leaves the backend.

const token = () => process.env.GITHUB_TOKEN || undefined;

// ---------------------------------------------------------------- Reading

/** View of a PR; null if XLR8 doesn't know the PR (no linked issue). */
export const view = ownerQuery({
  args: { repo: v.string(), number: v.number() },
  handler: async (ctx, args): Promise<PrView | null> => await prView(ctx, args.repo, args.number),
});

/** Summaries for the list on the issue, in input order; unknown ones are left out. At most 20. */
export const summaries = ownerQuery({
  args: { prIds: v.array(v.id('pullRequests')) },
  handler: async (ctx, args): Promise<PrSummary[]> => await prSummaries(ctx, args.prIds),
});

export const status = ownerQuery({
  args: {},
  handler: async (): Promise<{ configured: boolean }> => ({ configured: !!token() }),
});

// ---------------------------------------------------------------- Fetching

const snapshotValidator = v.object({
  detail: prDetailDataValidator,
  items: v.array(prItemValidator),
  summary: v.object({ comments: v.number(), review: v.optional(v.union(v.literal('approved'), v.literal('changes_requested'))) }),
  state: prStateValidator,
  title: v.string(),
  branch: v.string(),
  url: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
  mergedAt: v.optional(v.number()),
  warnings: v.array(v.string()),
});

export const target = internalQuery({
  args: { prId: v.id('pullRequests') },
  handler: async (ctx, args) => await prTarget(ctx, args.prId),
});

export const claim = internalMutation({
  args: { prIds: v.array(v.id('pullRequests')), notBefore: v.number(), viewed: v.optional(v.boolean()) },
  handler: async (ctx, args) => await claimRefresh(ctx, args.prIds, { notBefore: args.notBefore, now: Date.now(), viewed: args.viewed }),
});

export const store = internalMutation({
  args: {
    prId: v.id('pullRequests'),
    fetchedAt: v.number(),
    mediaKey: v.string(),
    snapshot: v.optional(snapshotValidator),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => await storeSnapshot(ctx, args),
});

/** Text for the UI; unknown errors without details (those go to the log). */
function messageOf(error: unknown) {
  return error instanceof GithubApiError ? error.message : 'Fetching from GitHub failed.';
}

/**
 * Limits sizes before passing to the mutation (argument size): description roughly, items together
 * at most PR_LIMITS.itemsTotalBytes (oldest clipped first), checks at most PR_LIMITS.checks.
 * The mutation clips again precisely after rewriting the media.
 */
function preclip(snapshot: PrSnapshot): PrSnapshot {
  return {
    ...snapshot,
    detail: {
      ...snapshot.detail,
      bodyHtml: clipHtml(snapshot.detail.bodyHtml, PR_LIMITS.bodyBytes, snapshot.url),
      checks: capChecks(snapshot.detail.checks),
    },
    items: clipItemsHtml(snapshot.items.slice(-PR_LIMITS.items), PR_LIMITS.itemBytes, PR_LIMITS.itemsTotalBytes),
  };
}

/** Always fetch (after our own actions): `notBefore` later than any timestamp. */
const FORCE = Number.MAX_SAFE_INTEGER;

/**
 * Claims the fetch (`claim`, see ops/githubPr.ts claimRefresh), then fetches. Returns null if there
 * was nothing to do (already fresh, or another call is fetching).
 */
async function refreshPr(ctx: ActionCtx, prId: Id<'pullRequests'>, notBefore = FORCE): Promise<{ ok: boolean; error?: string } | null> {
  if (!token()) return { ok: false, error: NOT_CONFIGURED };
  const claimed = await ctx.runMutation(internal.githubPr.claim, { prIds: [prId], notBefore });
  if (claimed.length === 0) return null;
  return await fetchAndStore(ctx, prId);
}

/** Fetches a PR's state and stores it (or the error). Without claiming. */
async function fetchAndStore(ctx: ActionCtx, prId: Id<'pullRequests'>): Promise<{ ok: boolean; error?: string }> {
  const secret = token();
  if (!secret) return { ok: false, error: NOT_CONFIGURED };
  const pr = await ctx.runQuery(internal.githubPr.target, { prId });
  if (!pr) return { ok: false, error: 'Unknown pull request.' };
  const mediaKey = pr.mediaKey ?? randomId(32);
  const fetchedAt = Date.now();
  try {
    const snapshot = preclip(await fetchPullRequest(githubClient(secret), pr.repo, pr.number));
    await ctx.runMutation(internal.githubPr.store, { prId, fetchedAt, mediaKey, snapshot });
    return { ok: true };
  } catch (error) {
    const message = messageOf(error);
    // Never log the token: GithubApiError messages don't contain it; other errors only by name.
    console.error(`GitHub fetch ${pr.repo}#${pr.number} failed: ${error instanceof GithubApiError ? message : String((error as Error)?.name ?? error)}`);
    await ctx.runMutation(internal.githubPr.store, { prId, fetchedAt, mediaKey, error: message });
    return { ok: false, error: message };
  }
}

/**
 * For the scheduler (webhook, mergeability retry). `since`: time of the trigger; if a fetch has
 * finished or is running since then, there is nothing to do.
 */
export const refreshOne = internalAction({
  args: { prId: v.id('pullRequests'), since: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    await refreshPr(ctx, args.prId, args.since ?? FORCE);
  },
});

const REFRESH_MAX = 10;
const DEFAULT_MAX_AGE_MS = 60_000;

/** On open: refetch PRs whose last fetch is older than `maxAgeMs` (default 60 s). At most 10. */
export const refresh = ownerAction({
  args: { prIds: v.array(v.id('pullRequests')), maxAgeMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ refreshed: number; error?: string }> => {
    if (!token()) return { refreshed: 0, error: NOT_CONFIGURED };
    const ids = [...new Set(args.prIds)].slice(0, REFRESH_MAX);
    const notBefore = Date.now() - Math.max(0, args.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    // claims only PRs that aren't fresh and aren't being fetched by another call
    const due = await ctx.runMutation(internal.githubPr.claim, { prIds: ids, notBefore, viewed: true });
    const results = await Promise.all(due.map((prId) => fetchAndStore(ctx, prId)));
    const error = results.find((r) => r.error)?.error;
    return { refreshed: results.filter((r) => r.ok).length, ...(error ? { error } : {}) };
  },
});

// ---------------------------------------------------------------- Actions

const CODES: Record<GithubApiError['code'], ErrorCode> = {
  unauthorized: 'rejected',
  forbidden: 'rejected',
  not_found: 'not_found',
  conflict: 'conflict',
  invalid: 'invalid',
  rate_limited: 'rate_limited',
  unavailable: 'rejected',
};

/** GitHub error → ConvexError with code and message. */
function rethrow(error: unknown): never {
  if (error instanceof GithubApiError) fail(CODES[error.code], error.message, { status: error.status });
  throw error;
}

async function actionTarget(ctx: ActionCtx, prId: Id<'pullRequests'>) {
  const secret = token();
  if (!secret) fail('rejected', NOT_CONFIGURED);
  const pr = await ctx.runQuery(internal.githubPr.target, { prId });
  if (!pr) notFound('The pull request');
  return { pr, client: githubClient(secret) };
}

export const merge = ownerAction({
  args: { prId: v.id('pullRequests'), method: mergeMethodValidator, deleteBranch: v.boolean() },
  handler: async (ctx, args): Promise<{ merged: true; branchDeleted: boolean; message?: string }> => {
    const { pr, client } = await actionTarget(ctx, args.prId);
    if (pr.state === 'merged') fail('conflict', 'The pull request is already merged.');
    if (pr.state === 'closed') fail('conflict', 'The pull request is closed.');
    let result: Awaited<ReturnType<typeof mergePullRequest>>;
    try {
      result = await mergePullRequest(client, pr.repo, pr.number, args.method, pr.headSha);
    } catch (error) {
      rethrow(error);
    }
    if (!result.merged) fail('conflict', `Merge: GitHub says "${result.message ?? 'not merged'}".`);
    let branchDeleted = false;
    let message: string | undefined;
    if (args.deleteBranch) {
      if (pr.detail?.deleteBranchOnMerge) {
        branchDeleted = true; // the repo deletes the branch itself
      } else if (pr.detail?.headBranchDeletable && pr.detail.headRef) {
        try {
          await deleteBranch(client, pr.repo, pr.detail.headRef);
          branchDeleted = true;
        } catch (error) {
          message = `Merged, but the branch could not be deleted. ${messageOf(error)}`;
        }
      } else {
        message = 'Merged. XLR8 cannot delete the branch (fork or already deleted).';
      }
    }
    // Refetch right away so the PR is already "merged" when the action returns. The fetch handles
    // the merge transition (closing issues); the webhook afterwards sees "already merged".
    const refreshed = await refreshPr(ctx, args.prId);
    if (refreshed && !refreshed.ok && !message) message = `Merged. The new state could not be fetched: ${refreshed.error}`;
    return { merged: true, branchDeleted, ...(message ? { message } : {}) };
  },
});

export const setState = ownerAction({
  args: { prId: v.id('pullRequests'), state: v.union(v.literal('open'), v.literal('closed')) },
  handler: async (ctx, args): Promise<{ state: 'open' | 'closed' }> => {
    const { pr, client } = await actionTarget(ctx, args.prId);
    if (pr.state === 'merged') fail('conflict', 'A merged pull request can no longer be changed.');
    try {
      await setPullRequestState(client, pr.repo, pr.number, args.state);
    } catch (error) {
      rethrow(error);
    }
    // refetch right away so the new state is visible when the action returns
    await refreshPr(ctx, args.prId);
    return { state: args.state };
  },
});

export const COMMENT_MAX = 65536;

export const comment = ownerAction({
  args: { prId: v.id('pullRequests'), body: v.string() },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const body = args.body.trim();
    if (body.length === 0) invalid('The comment is empty.');
    if (body.length > COMMENT_MAX) invalid(`The comment is too long (at most ${COMMENT_MAX} characters).`);
    const { pr, client } = await actionTarget(ctx, args.prId);
    let url = '';
    try {
      url = (await createComment(client, pr.repo, pr.number, body))?.url ?? '';
    } catch (error) {
      rethrow(error);
    }
    await refreshPr(ctx, args.prId);
    return { url };
  },
});

// ---------------------------------------------------------------- Media proxy (http.ts)

export const mediaTarget = internalQuery({
  args: { key: v.string(), index: v.number() },
  handler: async (ctx, args) => await findMedia(ctx, args.key, args.index),
});

export const updateSigned = internalMutation({
  args: { key: v.string(), updates: v.array(v.object({ index: v.number(), url: v.string() })), signedAt: v.number() },
  handler: async (ctx, args) => await saveSigned(ctx, args.key, args.updates, args.signedAt),
});

export const cacheResolved = internalMutation({
  args: { key: v.string(), index: v.number(), url: v.string(), at: v.number() },
  handler: async (ctx, args) => await saveResolved(ctx, args.key, args.index, args.url, args.at),
});

export const claimResign = internalMutation({
  args: { key: v.string(), index: v.number() },
  handler: async (ctx, args) => await claimResignOp(ctx, args.key, args.index, Date.now(), SIGNED_FRESH_MS),
});

/** signed URLs from GitHub are valid for 5 minutes */
const SIGNED_VALID_MS = 5 * 60_000;
/** keep redirects in the browser (private) for this long, if the target stays valid at least that long */
export const MEDIA_CACHE_S = 60;
/** remember download_url in the detail for this long (assumption: GitHub's token parameter is valid much longer) */
const RESOLVED_MS = MEDIA_CACHE_S * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Redirect target and how long the browser may keep it (0 = not at all). */
export interface MediaLocation {
  url: string;
  maxAge: number;
}

/** Remaining validity of a signed URL → max-age (only if it is valid for at least MEDIA_CACHE_S more). */
const signedMaxAge = (signedAt: number, now: number) => (signedAt + SIGNED_VALID_MS - now >= MEDIA_CACHE_S * 1000 ? MEDIA_CACHE_S : 0);

/**
 * Redirect target for GET /ghmedia/<key>/<index> (http.ts), null = 404.
 * Repo file: download_url via the Contents API, remembered in the detail for 60 s. Attachment: the
 * signed URL from the last fetch if younger than 4 min; otherwise refetch the post and store the
 * fresh URLs of all its attachments. Concurrent calls for the same post wait for the first one
 * (claimResign) instead of fetching themselves.
 */
export async function resolveMediaLocation(ctx: ActionCtx, key: string, index: number): Promise<MediaLocation | null> {
  const found = await ctx.runQuery(internal.githubPr.mediaTarget, { key, index });
  if (!found) return null;
  const { entry, repo, number, siblings } = found;
  const now = Date.now();
  const secret = token();
  if (entry.kind === 'repo') {
    if (entry.resolved && entry.resolvedAt !== undefined && now - entry.resolvedAt < RESOLVED_MS) {
      return { url: entry.resolved, maxAge: Math.max(0, MEDIA_CACHE_S - Math.ceil((now - entry.resolvedAt) / 1000)) };
    }
    const rest = repoFileTarget(entry.url, repo);
    if (!rest || !secret) return null;
    const url = await fileDownloadUrl(githubClient(secret), repo, rest);
    if (!url) return null;
    await ctx.runMutation(internal.githubPr.cacheResolved, { key, index, url, at: now });
    return { url, maxAge: MEDIA_CACHE_S };
  }
  const signedAt = entry.signedAt ?? 0;
  if (now - signedAt < SIGNED_FRESH_MS) return { url: entry.url, maxAge: signedMaxAge(signedAt, now) };
  const stillValid = now - signedAt < SIGNED_VALID_MS ? { url: entry.url, maxAge: 0 } : null;
  if (!secret || !entry.source) return stillValid;

  // Another call is fetching the same post: briefly wait for its result.
  for (let attempt = 0; attempt < 8; attempt++) {
    const claim = await ctx.runMutation(internal.githubPr.claimResign, { key, index });
    if (!claim) return null;
    if (claim.kind === 'fresh') return { url: claim.url, maxAge: signedMaxAge(claim.signedAt, Date.now()) };
    if (claim.kind === 'go') break;
    await sleep(500);
  }
  const html = await sourceHtml(githubClient(secret), repo, number, entry.source);
  if (!html) return stillValid;
  const updates: { index: number; url: string }[] = [];
  for (const sibling of siblings) {
    const uuid = attachmentUuid(sibling.url);
    const fresh = uuid ? findSignedUrl(html, uuid) : null;
    if (fresh) updates.push({ index: sibling.index, url: fresh });
  }
  const at = Date.now();
  if (updates.length > 0) await ctx.runMutation(internal.githubPr.updateSigned, { key, updates, signedAt: at });
  const url = updates.find((u) => u.index === index)?.url;
  return url ? { url, maxAge: MEDIA_CACHE_S } : stillValid;
}

// ---------------------------------------------------------------- Webhooks in all repos

const CONNECTION_KEY = 'githubConnection';

/** Manage webhooks only when explicitly enabled (GITHUB_MANAGE_WEBHOOKS=1); otherwise only check and show. */
const manage = () => process.env.GITHUB_MANAGE_WEBHOOKS === '1';
/** May this instance create webhooks? Only with `manage`, never locally (real repos would point to 127.0.0.1), never without a secret. */
const canWrite = () => manage() && !isLocalDeployment() && !!process.env.GITHUB_WEBHOOK_SECRET;
/** Optional filter GITHUB_REPOS: "owner/name" or "owner/*", comma-separated. */
const repoFilter = () => (process.env.GITHUB_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean);

/** URLs the webhook arrives at (the first is used when creating it). */
function hookUrls() {
  const bases = [process.env.CONVEX_SITE_URL, process.env.XLR8_PUBLIC_SITE_URL]
    .map((b) => b?.trim().replace(/\/+$/, ''))
    .filter((b): b is string => !!b);
  return [...new Set(bases)].map((b) => `${b}/github`);
}

export const saveConnection = internalMutation({
  args: { value: v.any() },
  handler: async (ctx, args) => await writeOpsStatus(ctx, CONNECTION_KEY, args.value),
});

function connectionOf(stored: { value: unknown; at: number } | null): GithubConnection {
  const report = (stored?.value ?? null) as (WebhookReport & { checkedAt?: number }) | null;
  return {
    configured: !!token(),
    ...(report?.login ? { login: report.login } : {}),
    ...(report?.checkedAt !== undefined ? { checkedAt: report.checkedAt } : {}),
    repos: report?.repos ?? [],
    ...(report?.error ? { error: report.error } : {}),
    local: isLocalDeployment(),
    manage: manage(),
    canWrite: canWrite(),
  };
}

async function runEnsureWebhooks(ctx: ActionCtx): Promise<GithubConnection> {
  const secret = token();
  if (!secret) return connectionOf(null);
  let report: WebhookReport;
  try {
    report = await ensureRepoWebhooks(githubClient(secret), {
      urls: hookUrls(),
      secret: process.env.GITHUB_WEBHOOK_SECRET || undefined,
      write: canWrite(),
      repos: repoFilter(),
    });
  } catch (error) {
    report = { repos: [], error: messageOf(error) };
  }
  const value = { checkedAt: Date.now(), ...report };
  await ctx.runMutation(internal.githubPr.saveConnection, { value });
  return connectionOf({ value, at: value.checkedAt });
}

/** Connection state for the settings (last webhook check). */
export const connection = ownerQuery({
  args: {},
  handler: async (ctx): Promise<GithubConnection> => connectionOf(await readOpsStatus(ctx, CONNECTION_KEY)),
});

/** Settings button: check webhooks now and create missing ones. */
export const ensureWebhooks = ownerAction({
  args: {},
  handler: async (ctx): Promise<GithubConnection> => await runEnsureWebhooks(ctx),
});

/** Daily cron (crons.ts). */
export const ensureWebhooksDaily = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    if (!token()) return;
    await runEnsureWebhooks(ctx);
  },
});
