import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, type ActionCtx } from './_generated/server';
import { assertWritable } from './lib/testSwitches';
import { GithubApiError, githubClient, NOT_CONFIGURED, nextLink, type CallInfo } from './lib/githubApi';
import { mapComment, mapIssue, mapPull, pathOf, type GithubPhase } from './lib/githubIssues';
import {
  applyGithubPage,
  githubPlan,
  latestGithubRun,
  pauseGithubImport,
  startGithubImport,
  type GithubRows,
} from './ops/githubImport';
import { importSummary } from './ops/import';

// Import from GitHub Issues into a team (docs/architecture/import.md, "Importing from GitHub").
//
// Invocation (no UI; the self-hoster already runs `cloud.mjs run` during setup):
//   node tooling/cloud.mjs run githubImport:run '{"team": "ACME", "repos": ["owner/name"]}'
// and locally the same with tooling/convex.mjs. Uses the instance's GITHUB_TOKEN (Issues: read).
//
// A run is a chain of scheduled steps like the Linear import: each step fetches ONE page from the
// GitHub REST API and writes it in one mutation, which stores the position (next page from the
// Link header) and schedules the next step. A rate limit postpones the next step until GitHub
// accepts calls again; the run stays `running` meanwhile. Repeating a run creates no duplicates.

const token = () => process.env.GITHUB_TOKEN || undefined;

/** Below this many remaining calls the run waits for the reset, so the PR view keeps working. */
export const RESERVE = 200;
/** Longest wait for a rate limit (GitHub's hourly window plus a margin); longer → the run fails. */
export const MAX_WAIT_MS = 65 * 60_000;
/** Retries per page when GitHub is unavailable (5xx, network), with these pauses. */
export const RETRY_MS = [5_000, 30_000, 120_000];
/** A mutation gets at most this much page data (GitHub texts can be 65,536 characters each). */
const CHUNK_BYTES = 2_000_000;

const CALLS: Record<GithubPhase, (repo: string) => CallInfo> = {
  issues: (repo) => ({ what: `Read issues of ${repo}`, permission: 'Issues', notFound: 'the repo does not exist or is not granted to the token.' }),
  pulls: (repo) => ({ what: `Read pull requests of ${repo}`, permission: 'Pull requests', notFound: 'the repo does not exist or is not granted to the token.' }),
  comments: (repo) => ({ what: `Read issue comments of ${repo}`, permission: 'Issues', notFound: 'the repo does not exist or is not granted to the token.' }),
};

/** Creates the run and schedules the first step. */
export const start = internalMutation({
  args: { team: v.string(), repos: v.array(v.string()) },
  handler: async (ctx, args): Promise<Id<'importRuns'>> => {
    await assertWritable(ctx);
    const runId = await startGithubImport(ctx, args);
    await ctx.scheduler.runAfter(0, internal.githubImport.step, { runId });
    return runId;
  },
});

type Plan = Awaited<ReturnType<typeof githubPlan>>;

export const plan = internalQuery({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args) => await githubPlan(ctx, args.runId),
});

/** Writes a page (or part of it) and schedules the next step when the page is complete. */
export const apply = internalMutation({
  args: {
    runId: v.id('importRuns'),
    cursor: v.string(),
    page: v.any(),
    done: v.boolean(),
    next: v.union(v.string(), v.null()),
    notes: v.array(v.string()),
    heartbeatAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { runId, page, ...rest } = args;
    const result = await applyGithubPage(ctx, runId, { ...rest, page: page as GithubRows });
    if (result && !result.finished && args.done) {
      const at = Math.max(Date.now(), args.heartbeatAt ?? 0);
      await ctx.scheduler.runAt(at, internal.githubImport.step, { runId });
    }
    return result;
  },
});

/** Waits (rate limit, GitHub unavailable) and schedules the same page again. */
export const pause = internalMutation({
  args: { runId: v.id('importRuns'), cursor: v.string(), until: v.number(), attempt: v.number() },
  handler: async (ctx, args) => {
    if (await pauseGithubImport(ctx, args.runId, args.cursor, args.until, args.attempt)) {
      await ctx.scheduler.runAt(args.until, internal.githubImport.step, { runId: args.runId });
    }
  },
});

/** Splits a page so that no mutation gets more than CHUNK_BYTES. */
function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [[]];
  let size = 0;
  for (const row of rows) {
    const bytes = JSON.stringify(row).length * 2;
    if (size + bytes > CHUNK_BYTES && out[out.length - 1]!.length) {
      out.push([]);
      size = 0;
    }
    out[out.length - 1]!.push(row);
    size += bytes;
  }
  return out;
}

async function failRun(ctx: ActionCtx, runId: Id<'importRuns'>, error: string) {
  await ctx.runMutation(internal.importer.fail, { runId, error });
}

/** One step: fetch one page, write it, schedule the next step. */
export const step = internalAction({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args): Promise<void> => {
    const { runId } = args;
    try {
      const next: Plan | null = await ctx.runQuery(internal.githubImport.plan, { runId });
      if (!next) return;
      const key = token();
      if (!key) return await failRun(ctx, runId, NOT_CONFIGURED);
      const notes: string[] = [];
      let response;
      try {
        response = await githubClient(key).request<unknown>('GET', next.path, CALLS[next.phase](next.repo), { okStatuses: [410] });
      } catch (error) {
        if (!(error instanceof GithubApiError)) throw error;
        const now = Date.now();
        if (error.code === 'rate_limited') {
          const until = error.retryAt ?? now + 60_000;
          if (until - now > MAX_WAIT_MS) return await failRun(ctx, runId, error.message);
          await ctx.runMutation(internal.githubImport.pause, { runId, cursor: next.cursor, until, attempt: next.attempt });
          return;
        }
        if (error.code === 'unavailable' && next.attempt < RETRY_MS.length) {
          await ctx.runMutation(internal.githubImport.pause, { runId, cursor: next.cursor, until: now + RETRY_MS[next.attempt]!, attempt: next.attempt + 1 });
          return;
        }
        // PR links are a bonus: a token without "Pull requests" access skips them instead of failing.
        if (next.phase === 'pulls' && (error.code === 'forbidden' || error.code === 'not_found')) {
          await ctx.runMutation(internal.githubImport.apply, {
            runId,
            cursor: next.cursor,
            page: { phase: 'pulls', rows: [] },
            done: true,
            next: null,
            notes: [`${next.repo}: pull requests not readable, PR links skipped (${error.message})`],
          });
          return;
        }
        return await failRun(ctx, runId, error.message);
      }

      const raw = response.status === 410 ? [] : Array.isArray(response.data) ? response.data : [];
      if (response.status === 410) notes.push(`${next.repo}: issues are disabled on GitHub`);
      const following = response.status === 410 ? undefined : nextLink(response.headers.get('link'));
      const nextPath = following ? pathOf(following) : null;
      // Leave room for the PR view: when few calls remain, wait for the reset.
      const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? '');
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? '');
      const waitUntil = Number.isFinite(remaining) && remaining < RESERVE && reset * 1000 > Date.now() ? Math.min(reset * 1000 + 1000, Date.now() + MAX_WAIT_MS) : undefined;

      const rows =
        next.phase === 'issues'
          ? raw.map((r) => mapIssue(next.repo, r))
          : next.phase === 'pulls'
            ? raw.map((r) => mapPull(next.repo, r)).filter((p) => p && p.closes.length > 0)
            : raw.map((r) => mapComment(next.repo, r));
      const parts = chunks(rows.filter((r) => r !== null));
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        await ctx.runMutation(internal.githubImport.apply, {
          runId,
          cursor: next.cursor,
          page: { phase: next.phase, rows: parts[i] },
          done: last,
          next: nextPath,
          notes: last ? notes : [],
          ...(last && waitUntil ? { heartbeatAt: waitUntil } : {}),
        });
      }
    } catch (error) {
      await failRun(ctx, runId, error instanceof Error ? error.message : String(error));
    }
  },
});

/** State of a run; without `runId` the latest GitHub run. */
export const status = internalQuery({
  args: { runId: v.optional(v.id('importRuns')) },
  handler: async (ctx, args) => {
    const runId = args.runId ?? (await latestGithubRun(ctx))?._id;
    if (!runId) return null;
    const summary = await importSummary(ctx, runId);
    const run = await ctx.db.get('importRuns', runId);
    const waitingUntil = run?.status === 'running' && run.heartbeatAt && run.heartbeatAt > Date.now() ? new Date(run.heartbeatAt).toISOString() : null;
    return summary && { ...summary, waitingUntil };
  },
});

const POLL_LIMIT_MS = 8 * 60_000;

/**
 * Starts a run and waits for it (for `convex run`; actions may run at most 10 minutes). If it
 * takes longer (large repos, a rate limit), it returns `status: 'running'`; follow it with
 * `githubImport:status`. A failed run throws with GitHub's explanation.
 */
export const run = internalAction({
  args: { team: v.string(), repos: v.array(v.string()) },
  handler: async (ctx, args): Promise<unknown> => {
    const runId: Id<'importRuns'> = await ctx.runMutation(internal.githubImport.start, args);
    const started = Date.now();
    for (let wait = 50; ; wait = Math.min(1000, wait * 2)) {
      const result = await ctx.runQuery(internal.githubImport.status, { runId });
      if (!result) throw new Error('The import run has disappeared.');
      if (result.status === 'failed') throw new Error(`Import failed: ${result.error ?? 'unknown'}`);
      if (result.status === 'done' || Date.now() - started > POLL_LIMIT_MS) return result;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  },
});
