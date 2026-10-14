import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { analyzePullRequestEvent, refreshTargets, type KnownKeys } from '../lib/github';
import { capChecks, checkOfRun, mergeChecks } from '../lib/githubApi';
import type { PrCheck } from '../shared/pullRequests';
import { resolveIssue } from '../lib/identifiers';
import { CLOSED_STATUSES, identifierOf } from '../shared/constants';
import { record } from './history';
import { applyPatch } from './issues';
import { notifyPullRequest } from './notify';

// GitHub webhook: the effect of one delivery in ONE transaction.
//
// - Delivery id already seen → no effect (GitHub redelivers).
// - Create or update the PR (repo + number), add links to issues, never remove them
//   automatically. `closes` is only raised from false to true, never lowered.
// - On merge (transition of the stored PR state to "merged"): all linked issues with
//   `closes` → status done, actor github. Canceled, duplicate and already done issues stay
//   as they are. Further deliveries for an already merged PR close nothing.
// - Every delivery for a known PR (pull_request with any action, comments, reviews, checks,
//   statuses, workflow runs) schedules a fetch through the GitHub API, debounced via
//   `pullRequestDetails.refreshAt`. Without GITHUB_TOKEN nothing is scheduled.

export const GITHUB: Actor = { kind: 'github' };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const pick = (source: unknown, keys: string[]) => {
  const out: Json = {};
  if (!isObj(source)) return out;
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  return out;
};

/** `pull_requests[]` from check and workflow events: only number and base repo. */
const prRefs = (list: unknown) =>
  (Array.isArray(list) ? list : [])
    .filter(isObj)
    .slice(0, 20)
    .map((p) => ({ ...pick(p, ['number']), base: { repo: pick(isObj(p.base) ? p.base.repo : undefined, ['url']) } }));

/**
 * Reduces the payload to what `analyzePullRequestEvent` and `refreshTargets` read.
 * GitHub payloads are large and contain field names like `_links` that Convex values don't allow.
 */
export function reduceGithubPayload(event: string, payload: unknown): Json {
  if (!isObj(payload)) return {};
  if (event === 'ping') return pick(payload, ['zen', 'hook_id']);
  const pr = isObj(payload.pull_request) ? payload.pull_request : {};
  const out: Json = {
    ...pick(payload, ['action', 'number']),
    repository: pick(payload.repository, ['full_name']),
    pull_request: {
      ...pick(pr, ['number', 'title', 'body', 'state', 'draft', 'merged', 'merged_at', 'updated_at', 'html_url']),
      head: pick(pr.head, ['ref', 'sha']),
      user: pick(pr.user, ['login']),
    },
  };
  if (event === 'status') Object.assign(out, pick(payload, ['sha']));
  if (event === 'issue_comment' && isObj(payload.issue)) {
    const issue = payload.issue;
    out.issue = { ...pick(issue, ['number']), ...(isObj(issue.pull_request) ? { pull_request: pick(issue.pull_request, ['url']) } : {}) };
  }
  if ((event === 'check_suite' || event === 'workflow_run') && isObj(payload[event])) {
    const x = payload[event] as Json;
    out[event] = { ...pick(x, ['head_sha']), pull_requests: prRefs(x.pull_requests) };
  }
  if (event === 'check_run' && isObj(payload.check_run)) {
    const run = payload.check_run;
    out.check_run = {
      ...pick(run, ['id', 'name', 'status', 'conclusion', 'html_url', 'details_url', 'started_at', 'completed_at', 'head_sha']),
      app: pick(run.app, ['name']),
      output: pick(run.output, ['title']),
      pull_requests: prRefs(run.pull_requests),
    };
  }
  return out;
}

const CANDIDATE_RE = /([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,6})/g;

/** Team keys and the old identifiers that actually occur in the PR (instead of all aliases). */
async function knownKeys(ctx: QueryCtx, payload: Json): Promise<KnownKeys> {
  const teams = (await ctx.db.query('teams').take(500)).map((t) => t.key);
  const pr = isObj(payload.pull_request) ? payload.pull_request : {};
  const head = isObj(pr.head) ? pr.head : {};
  const text = [head.ref, pr.title, pr.body].filter((s): s is string => typeof s === 'string').join('\n');
  const candidates = new Set<string>();
  for (const m of text.matchAll(CANDIDATE_RE)) {
    candidates.add(identifierOf(m[1]!.toUpperCase(), Number(m[2])));
    if (candidates.size >= 100) break;
  }
  const aliases: string[] = [];
  for (const key of candidates) {
    const alias = await ctx.db
      .query('identifierAliases')
      .withIndex('by_key', (q) => q.eq('key', key))
      .first();
    if (alias) aliases.push(key);
  }
  return { teams, aliases };
}

export interface DeliveryResult {
  duplicate: boolean;
  /** refresh: not a link event, but a fetch for known PRs is scheduled */
  kind: 'pull_request' | 'ping' | 'ignored' | 'refresh';
  reason?: string;
  pr?: string;
  linked: string[];
  closed: string[];
  /** PRs ("owner/name#7") with a fetch scheduled or already pending */
  refresh?: string[];
}

// ---------------------------------------------------------------- Scheduling fetches

/** Delay before the fetch: events often arrive in bursts (push → several checks). */
export const REFRESH_DELAY_MS = 2500;
/** Check and status events come in large bursts: wait longer to save GitHub rate limit. */
export const CHECK_REFRESH_DELAY_MS = 20_000;
const SLOW_EVENTS = new Set(['check_run', 'check_suite', 'workflow_run', 'status']);
/** A webhook fetches unlinked PRs only if they were open in the UI within this window. */
export const VIEWED_WINDOW_MS = 30 * 60_000;
/** Merge through Selfbound before the "edited" delivery: a new `closes` link still closes for this long afterwards. */
export const LATE_LINK_MS = 10 * 60_000;

export const githubConfigured = () => !!process.env.GITHUB_TOKEN;

export async function detailOf(ctx: QueryCtx, prId: Id<'pullRequests'>) {
  return await ctx.db
    .query('pullRequestDetails')
    .withIndex('by_pr', (q) => q.eq('prId', prId))
    .unique();
}

/**
 * After a webhook delivery, schedules `githubPr.refreshOne` in `delay` ms. Only for PRs linked to an
 * issue or viewed in the last 30 minutes (`viewedAt`), so webhooks from all repos don't use up the
 * rate limit. If a fetch is already pending that runs no later than the new time, schedules nothing;
 * otherwise adds the earlier one (the later one sees via `since` that it has nothing left to do).
 * Creates the detail document without data if needed. Without GITHUB_TOKEN: nothing.
 */
export async function scheduleRefresh(ctx: MutationCtx, prId: Id<'pullRequests'>, now: number, delay = REFRESH_DELAY_MS) {
  if (!githubConfigured()) return false;
  const row = await detailOf(ctx, prId);
  const viewed = row?.viewedAt !== undefined && now - row.viewedAt < VIEWED_WINDOW_MS;
  if (!viewed) {
    const link = await ctx.db
      .query('issuePullRequests')
      .withIndex('by_pr', (q) => q.eq('prId', prId))
      .first();
    if (!link) return false;
  }
  const refreshAt = now + delay;
  if (row?.refreshAt !== undefined && row.refreshAt > now && row.refreshAt <= refreshAt) return true;
  if (row) await ctx.db.patch('pullRequestDetails', row._id, { refreshAt });
  else await ctx.db.insert('pullRequestDetails', { prId, media: [], refreshAt });
  await ctx.scheduler.runAfter(delay, internal.githubPr.refreshOne, { prId, since: now });
  return true;
}

/** Stores a check run from a webhook delivery (newer states win, see mergeChecks). */
async function storeCheckRun(ctx: MutationCtx, repo: string, run: Json, now: number): Promise<{ headSha: string; check: PrCheck } | null> {
  const checkId = typeof run.id === 'number' ? run.id : undefined;
  const headSha = typeof run.head_sha === 'string' ? run.head_sha : undefined;
  if (checkId === undefined || !headSha) return null;
  const check = checkOfRun(run);
  const row = await ctx.db
    .query('githubCheckRuns')
    .withIndex('by_check', (q) => q.eq('checkId', checkId))
    .first();
  if (!row) {
    await ctx.db.insert('githubCheckRuns', { repo, headSha, checkId, check, receivedAt: now });
    return { headSha, check };
  }
  // A late "still running" delivery doesn't overwrite a result.
  if (row.check.state !== 'pending' && check.state === 'pending') return null;
  await ctx.db.patch('githubCheckRuns', row._id, { check, receivedAt: now });
  return { headSha, check };
}

/** Merges the check into the stored state right away (same head commit), before the full fetch arrives. */
async function mergeCheckIntoDetail(ctx: MutationCtx, prId: Id<'pullRequests'>, headSha: string, check: PrCheck) {
  const row = await detailOf(ctx, prId);
  if (!row?.data || row.data.headSha !== headSha) return;
  const checks = capChecks(mergeChecks(row.data.checks, [check]));
  await ctx.db.patch('pullRequestDetails', row._id, { data: { ...row.data, checks } });
}

/**
 * Deliveries without link evaluation: find the affected known PRs (by number, else head commit),
 * update the head commit, store check runs, schedule a fetch. Returns the PRs with a fetch
 * scheduled or already pending.
 */
async function refreshFromEvent(ctx: MutationCtx, event: string, payload: Json, now: number): Promise<string[]> {
  const targets = refreshTargets(event, payload);
  if (!targets) return [];
  const prs = new Map<Id<'pullRequests'>, Doc<'pullRequests'>>();
  for (const number of targets.numbers) {
    const pr = await ctx.db
      .query('pullRequests')
      .withIndex('by_repo_number', (q) => q.eq('repo', targets.repo).eq('number', number))
      .unique();
    if (pr) prs.set(pr._id, pr);
  }
  for (const sha of targets.shas) {
    const found = await ctx.db
      .query('pullRequests')
      .withIndex('by_repo_head', (q) => q.eq('repo', targets.repo).eq('headSha', sha))
      .take(10);
    for (const pr of found) prs.set(pr._id, pr);
  }
  if (prs.size === 0) return [];
  if (targets.headSha) {
    for (const pr of prs.values()) {
      if (pr.headSha !== targets.headSha) await ctx.db.patch('pullRequests', pr._id, { headSha: targets.headSha });
    }
  }
  const run = event === 'check_run' && isObj(payload.check_run) ? await storeCheckRun(ctx, targets.repo, payload.check_run, now) : null;
  const delay = SLOW_EVENTS.has(event) ? CHECK_REFRESH_DELAY_MS : REFRESH_DELAY_MS;
  const refresh: string[] = [];
  for (const pr of prs.values()) {
    if (run) await mergeCheckIntoDetail(ctx, pr._id, run.headSha, run.check);
    if (await scheduleRefresh(ctx, pr._id, now, delay)) refresh.push(`${pr.repo}#${pr.number}`);
  }
  return refresh;
}

/**
 * Effect of the merge (transition of the stored state to "merged"): issues with `closes` → done
 * (actor github), notification `pr_merged`. Callers: the webhook and the API fetch
 * (ops/githubPr.ts), each only on the transition; the stored state ensures it happens exactly once.
 */
export async function closeIssuesOnMerge(
  ctx: MutationCtx,
  prId: Id<'pullRequests'>,
  prInfo: { ref: string; number: number; title: string },
  now: number,
  links?: Doc<'issuePullRequests'>[],
): Promise<string[]> {
  const existing =
    links ??
    (await ctx.db
      .query('issuePullRequests')
      .withIndex('by_pr', (q) => q.eq('prId', prId))
      .take(500));
  const closed: string[] = [];
  for (const row of existing) {
    if (!row.closes) continue;
    const issue: Doc<'issues'> | null = await ctx.db.get('issues', row.issueId as Id<'issues'>);
    if (!issue || issue.deletedAt !== undefined || CLOSED_STATUSES.includes(issue.status)) continue;
    await applyPatch(ctx, GITHUB, issue._id, { status: 'done' }, undefined, now);
    const team = await ctx.db.get('teams', issue.teamId);
    closed.push(identifierOf(team?.key ?? '?', issue.number));
  }
  const issues: Doc<'issues'>[] = [];
  for (const row of existing) {
    const issue = await ctx.db.get('issues', row.issueId as Id<'issues'>);
    if (issue && issue.deletedAt === undefined) issues.push(issue);
  }
  await notifyPullRequest(ctx, 'pr_merged', prInfo, issues, closed, now);
  return closed;
}

export async function applyGithubDelivery(
  ctx: MutationCtx,
  args: { deliveryId: string; event: string; payload: Json },
  now = Date.now(),
): Promise<DeliveryResult> {
  const seen = await ctx.db
    .query('githubDeliveries')
    .withIndex('by_delivery', (q) => q.eq('deliveryId', args.deliveryId))
    .first();
  if (seen) return { duplicate: true, kind: 'ignored', reason: 'delivery already processed', linked: [], closed: [] };
  await ctx.db.insert('githubDeliveries', { deliveryId: args.deliveryId, event: args.event, receivedAt: now });

  // Read team keys only for pull_request (check events come in bursts).
  const keys = args.event === 'pull_request' ? await knownKeys(ctx, args.payload) : { teams: [] };
  const analysis = analyzePullRequestEvent(args.event, args.payload, keys);
  if (analysis.kind === 'ping') return { duplicate: false, kind: 'ping', linked: [], closed: [] };
  if (analysis.kind === 'ignored') {
    const refresh = await refreshFromEvent(ctx, args.event, args.payload, now);
    if (refresh.length > 0) return { duplicate: false, kind: 'refresh', linked: [], closed: [], refresh };
    return { duplicate: false, kind: 'ignored', reason: analysis.reason, linked: [], closed: [] };
  }

  // ---- Create or update the PR
  const eventTime = analysis.updatedAt ?? now;
  let pr = await ctx.db
    .query('pullRequests')
    .withIndex('by_repo_number', (q) => q.eq('repo', analysis.repo).eq('number', analysis.number))
    .unique();
  const wasMerged = pr?.state === 'merged';
  const payloadPr = isObj(args.payload.pull_request) ? args.payload.pull_request : {};
  const headSha = isObj(payloadPr.head) && typeof payloadPr.head.sha === 'string' ? payloadPr.head.sha : undefined;
  const fields = {
    title: analysis.title,
    url: analysis.url,
    state: analysis.state,
    branch: analysis.branch,
    ...(analysis.author ? { author: analysis.author } : {}),
    updatedAt: eventTime,
    ...(analysis.mergedAt ? { mergedAt: analysis.mergedAt } : {}),
    ...(headSha ? { headSha } : {}),
  };
  if (!pr) {
    const prId = await ctx.db.insert('pullRequests', { repo: analysis.repo, number: analysis.number, ...fields });
    pr = (await ctx.db.get('pullRequests', prId))!;
  } else if (eventTime >= pr.updatedAt) {
    // A merged PR stays merged, even if an "edited" arrives afterwards.
    await ctx.db.patch('pullRequests', pr._id, { ...fields, state: pr.state === 'merged' ? 'merged' : fields.state });
  } else if (analysis.merged && pr.state !== 'merged') {
    // An older delivery arrives late: only take over the merge, roll nothing else back.
    await ctx.db.patch('pullRequests', pr._id, { state: 'merged', ...(analysis.mergedAt ? { mergedAt: analysis.mergedAt } : {}) });
  }
  const prRef = `${analysis.repo}#${analysis.number}`;
  // Close only on the transition to "merged": another delivery for an already merged PR
  // (e.g. redelivered after the 30-day delivery list expired) doesn't close an issue that
  // has been reopened since.
  const newlyMerged = analysis.merged && wasMerged === false;

  // ---- Links: add, never remove
  const existing = await ctx.db
    .query('issuePullRequests')
    .withIndex('by_pr', (q) => q.eq('prId', pr._id))
    .take(500);
  const linked: string[] = [];
  const linkedIssues: Doc<'issues'>[] = [];
  const newClosing: Doc<'issuePullRequests'>[] = [];
  for (const link of analysis.links) {
    const issue = await resolveIssue(ctx, link.identifier);
    if (!issue) continue;
    const row = existing.find((r) => r.issueId === issue._id);
    if (!row) {
      const id = await ctx.db.insert('issuePullRequests', { issueId: issue._id, prId: pr._id, via: link.via, closes: link.closes });
      const added = { _id: id, _creationTime: now, issueId: issue._id, prId: pr._id, via: link.via, closes: link.closes };
      existing.push(added);
      if (link.closes) newClosing.push(added);
    } else if (link.closes && !row.closes) {
      await ctx.db.patch('issuePullRequests', row._id, { closes: true });
      row.closes = true;
      newClosing.push(row);
    } else {
      continue;
    }
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, GITHUB, now, undefined, {
      issueId: issue._id,
      field: 'pull_request',
      to: { pr: prRef, url: analysis.url, via: link.via, closes: link.closes },
    });
    linked.push(link.identifier);
    linkedIssues.push(issue);
  }

  // ---- Notifications; a merge closes issues with `closes`
  const prInfo = { ref: prRef, number: analysis.number, title: analysis.title };
  await notifyPullRequest(ctx, 'pr_linked', prInfo, linkedIssues, [], now);
  // Rare case: merged through Selfbound (the fetch already set "merged"), and only then the delivery
  // with the closing identifier arrives. If the merge was recent, it still counts.
  const lateMerge = wasMerged && newClosing.length > 0 && pr.mergedAt !== undefined && now - pr.mergedAt < LATE_LINK_MS;
  const closed = newlyMerged
    ? await closeIssuesOnMerge(ctx, pr._id, prInfo, now, existing)
    : lateMerge
      ? await closeIssuesOnMerge(ctx, pr._id, prInfo, now, newClosing)
      : [];

  // ---- Fetch through the API
  const refresh = (await scheduleRefresh(ctx, pr._id, now)) ? [prRef] : [];
  return { duplicate: false, kind: 'pull_request', pr: prRef, linked, closed, ...(refresh.length ? { refresh } : {}) };
}
