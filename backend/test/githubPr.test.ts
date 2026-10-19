import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { signBody } from '../convex/lib/github';
import { mapPullRequest, PR_LIMITS, type PrSnapshot } from '../convex/lib/githubApi';
import { writeStatus } from '../convex/ops/githubPr';
import { readOpsStatus } from '../convex/ops/maintenance';
import { prStatusOf, type PrCheckState, type PrDetail, type PrItem, type PrMergeState } from '../convex/shared/pullRequests';
import { createOne, expectCode, fixture, getIssue, setup, type T } from './helpers';
import { fakeGithub, prJson, prRoutes, repoJson, REPO, SHA, TOKEN, user } from './lib/githubFake';

// PRs in Selfbound: webhook schedules fetches, fetch stores state and items, merge transition,
// actions, media proxy, webhooks in all repos. fetch is always mocked (fakeGithub).

const SECRET = 'synthetic-test-secret';
const BASE = `/repos/${REPO}`;
/** PR title in the fake GitHub responses */
const TITLE = prJson().title as string;

function init(env: Parameters<typeof setup>[0] = {}) {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.GITHUB_TOKEN = TOKEN;
  return setup(env);
}

beforeEach(() => {
  // Scheduled functions only run when a test advances the clock.
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_MANAGE_WEBHOOKS;
  delete process.env.GITHUB_REPOS;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubGithub(routes: Record<string, unknown>) {
  const fake = fakeGithub(routes);
  vi.stubGlobal('fetch', fake.fetchImpl);
  return fake;
}

async function deliver(t: T, event: string, payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  const response = await t.fetch('/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': deliveryId,
      'X-Hub-Signature-256': await signBody(SECRET, body),
    },
    body,
  });
  return (await response.json()) as Record<string, any>;
}

async function insertPr(t: T, extra: { number?: number; headSha?: string; state?: 'open' | 'merged' | 'closed' | 'draft' } = {}) {
  return await t.run(async (ctx) =>
    await ctx.db.insert('pullRequests', {
      repo: REPO,
      number: extra.number ?? 7,
      title: TITLE,
      url: `https://github.com/${REPO}/pull/${extra.number ?? 7}`,
      state: extra.state ?? 'open',
      branch: 'feature/x',
      updatedAt: Date.parse('2026-10-08T10:00:00Z'),
      ...(extra.headSha ? { headSha: extra.headSha } : {}),
    }),
  );
}

async function pendingRefreshes(t: T) {
  const jobs = await t.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect());
  return jobs.filter((j) => j.name.includes('refreshOne') && j.state.kind === 'pending');
}

const detailRow = (t: T, prId: Id<'pullRequests'>) =>
  t.run(async (ctx) => await ctx.db.query('pullRequestDetails').withIndex('by_pr', (q) => q.eq('prId', prId)).unique());

function snapshot(extra: Partial<PrSnapshot> = {}, pr: Record<string, unknown> = {}): PrSnapshot {
  return {
    detail: mapPullRequest(prJson(pr), repoJson, [], true),
    items: [],
    summary: { comments: 0 },
    state: 'open',
    title: TITLE,
    branch: 'feature/x',
    updatedAt: Date.parse('2026-10-08T11:00:00Z'),
    warnings: [],
    ...extra,
  };
}

describe('webhook schedules fetches', () => {
  test('only known, linked or viewed PRs, debounced; check runs and head commit are recorded; nothing without a token', async () => {
    const { t } = init();
    const prId = await insertPr(t, { headSha: SHA });
    const repository = { full_name: REPO };

    // neither linked nor viewed: no fetch (save rate limit)
    expect(await deliver(t, 'issue_comment', { action: 'created', repository, issue: { number: 7, pull_request: { url: 'x' } } }, 'd-0')).toMatchObject({
      kind: 'ignored',
    });
    expect(await pendingRefreshes(t)).toHaveLength(0);
    // viewed 10 minutes ago: counts
    await t.run(async (ctx) => await ctx.db.insert('pullRequestDetails', { prId, media: [], viewedAt: Date.now() - 10 * 60_000 }));

    const comment = await deliver(t, 'issue_comment', { action: 'created', repository, issue: { number: 7, pull_request: { url: 'x' } } }, 'd-1');
    expect(comment).toMatchObject({ kind: 'refresh', refresh: [`${REPO}#7`] });
    expect(await pendingRefreshes(t)).toHaveLength(1);

    // burst: further events whose time isn't earlier (checks: 20 s) schedule nothing new
    const run = {
      id: 9001,
      name: 'CodeRabbit',
      status: 'completed',
      conclusion: 'neutral',
      head_sha: SHA,
      details_url: 'https://coderabbit.ai/x',
      app: { name: 'CodeRabbit', owner: { login: 'x' } },
      output: { title: 'Review done', text: 'long' },
      pull_requests: [],
      _links: {},
    };
    expect(await deliver(t, 'check_run', { action: 'completed', repository, check_run: run }, 'd-2')).toMatchObject({ kind: 'refresh' });
    expect(await deliver(t, 'pull_request_review', { action: 'submitted', repository, pull_request: { number: 7 } }, 'd-3')).toMatchObject({
      kind: 'refresh',
    });
    expect(await pendingRefreshes(t)).toHaveLength(1);
    const runs = await t.run(async (ctx) => await ctx.db.query('githubCheckRuns').collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ repo: REPO, headSha: SHA, checkId: 9001, check: { key: 'check:9001', name: 'CodeRabbit', state: 'neutral', summary: 'Review done' } });
    // a late "still running" delivery doesn't overwrite the result
    await deliver(t, 'check_run', { action: 'created', repository, check_run: { ...run, status: 'queued', conclusion: null } }, 'd-2b');
    expect((await t.run(async (ctx) => await ctx.db.query('githubCheckRuns').first()))!.check.state).toBe('neutral');

    // unknown PRs, issue comments, unrelated commits: ignored
    expect(await deliver(t, 'pull_request_review', { action: 'submitted', repository, pull_request: { number: 99 } }, 'd-4')).toMatchObject({ kind: 'ignored' });
    expect(await deliver(t, 'issue_comment', { action: 'created', repository, issue: { number: 7 } }, 'd-5')).toMatchObject({ kind: 'ignored' });
    expect(await deliver(t, 'status', { repository, sha: 'f'.repeat(40), state: 'success' }, 'd-6')).toMatchObject({ kind: 'ignored' });
    expect(await deliver(t, 'check_suite', { repository: { full_name: 'other/repo' }, check_suite: { head_sha: SHA, pull_requests: [] } }, 'd-7')).toMatchObject({
      kind: 'ignored',
    });

    // after the delay the next event schedules again, status with 20 s
    vi.setSystemTime(Date.now() + 3000);
    expect(await deliver(t, 'status', { repository, sha: SHA, state: 'pending' }, 'd-8')).toMatchObject({ kind: 'refresh' });
    const jobs = await pendingRefreshes(t);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.scheduledTime - Date.now()).toBe(20_000);
    expect((await detailRow(t, prId))!.refreshAt).toBe(Date.now() + 20_000);

    // synchronize (2.5 s, earlier than the pending status fetch): adds the earlier one
    vi.setSystemTime(Date.now() + 3000);
    const sync = await deliver(t, 'pull_request', { action: 'synchronize', number: 7, repository, pull_request: { number: 7, head: { ref: 'feature/x', sha: 'b'.repeat(40) } } }, 'd-9');
    expect(sync).toMatchObject({ kind: 'refresh', linked: [], closed: [] });
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', prId)))!.headSha).toBe('b'.repeat(40));
    expect(await pendingRefreshes(t)).toHaveLength(3);

    // without a token: schedule nothing
    delete process.env.GITHUB_TOKEN;
    vi.setSystemTime(Date.now() + 3000);
    expect(await deliver(t, 'issue_comment', { action: 'created', repository, issue: { number: 7, pull_request: {} } }, 'd-10')).toMatchObject({ kind: 'ignored' });
    expect(await pendingRefreshes(t)).toHaveLength(3);
  });

  test('pull_request with link evaluation also schedules a fetch and records the head commit', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    await createOne(owner, f.orb);
    const result = await deliver(
      t,
      'pull_request',
      {
        action: 'opened',
        number: 7,
        repository: { full_name: REPO },
        pull_request: { ...prJson({ body: 'Fixes ORB-1' }), head: { ref: 'feature/x', sha: SHA, repo: { full_name: REPO } } },
      },
      'd-open',
    );
    expect(result).toMatchObject({ kind: 'pull_request', linked: ['ORB-1'], refresh: [`${REPO}#7`] });
    expect((await t.run(async (ctx) => await ctx.db.query('pullRequests').first()))!.headSha).toBe(SHA);
    expect(await pendingRefreshes(t)).toHaveLength(1);
  });
});

describe('webhook: immediate checks, linked PRs, late link', () => {
  test('check_run lands in data.checks right away (same head commit); linked PRs are fetched', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb);
    const prId = await insertPr(t, { headSha: SHA });
    await t.run(async (ctx) => await ctx.db.insert('issuePullRequests', { issueId: issue.id, prId, via: 'title', closes: false }));
    await t.mutation(internal.githubPr.store, { prId, fetchedAt: Date.now(), mediaKey: 'k'.repeat(43), snapshot: snapshot() });
    const run = { id: 77, name: 'Security', status: 'completed', conclusion: 'failure', head_sha: SHA, app: { name: 'Snyk' }, pull_requests: [] };
    expect(await deliver(t, 'check_run', { action: 'completed', repository: { full_name: REPO }, check_run: run }, 'd-c')).toMatchObject({ kind: 'refresh' });
    expect((await detailRow(t, prId))!.data!.checks).toEqual([{ key: 'check:77', name: 'Security', source: 'check', app: 'Snyk', state: 'failure' }]);
    // different commit: only stored, not merged into the state
    await deliver(t, 'check_run', { action: 'completed', repository: { full_name: REPO }, check_run: { ...run, id: 78, head_sha: 'c'.repeat(40) } }, 'd-c2');
    expect((await detailRow(t, prId))!.data!.checks).toHaveLength(1);
  });

  test('merge through Selfbound before the edited delivery: a new closes link still closes (< 10 min), later not', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { status: 'in_progress' });
    const b = await createOne(owner, f.orb, { status: 'in_progress' });
    const repository = { full_name: REPO };
    for (const number of [7, 8]) {
      await deliver(t, 'pull_request', { action: 'opened', number, repository, pull_request: prJson({ number, body: '' }) }, `d-open-${number}`);
    }
    const prOf = (number: number) =>
      t.run(async (ctx) => (await ctx.db.query('pullRequests').withIndex('by_repo_number', (q) => q.eq('repo', REPO).eq('number', number)).unique())!);
    const now = Date.now();
    const mergedSnap = (mergedAt: number, number: number) =>
      snapshot({ state: 'merged', mergedAt, updatedAt: mergedAt }, { number, state: 'closed', merged: true, merged_at: new Date(mergedAt).toISOString(), mergeable: null });
    await t.mutation(internal.githubPr.store, { prId: (await prOf(7))._id, fetchedAt: now, mediaKey: 'k'.repeat(43), snapshot: mergedSnap(now - 2 * 60_000, 7) });
    await t.mutation(internal.githubPr.store, { prId: (await prOf(8))._id, fetchedAt: now, mediaKey: 'j'.repeat(43), snapshot: mergedSnap(now - 20 * 60_000, 8) });
    const edited = (number: number, body: string) =>
      deliver(
        t,
        'pull_request',
        { action: 'edited', number, repository, pull_request: prJson({ number, body, state: 'closed', merged: true, merged_at: new Date(now).toISOString(), updated_at: new Date(now + 1000).toISOString() }) },
        `d-edit-${number}`,
      );
    expect((await edited(7, `Fixes ${a.identifier}`)).closed).toEqual([a.identifier]);
    expect((await getIssue(t, a.id)).status).toBe('done');
    expect((await edited(8, `Fixes ${b.identifier}`)).closed).toEqual([]);
    expect((await getIssue(t, b.id)).status).toBe('in_progress');
  });
});

describe('fetch and view', () => {
  test('refresh fetches state, items, summary; view and summaries; items are reconciled', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    let routes = prRoutes({
      [`GET ${BASE}/pulls/7`]: prJson({ body_html: `<p><img src="https://raw.githubusercontent.com/${REPO}/main/docs/a.png"></p>` }),
    });
    const fake = stubGithub(routes);
    expect(await owner.action(api.githubPr.refresh, { prIds: [prId] })).toEqual({ refreshed: 1 });

    const view = (await owner.query(api.githubPr.view, { repo: REPO, number: 7 }))!;
    expect(view.configured).toBe(true);
    expect(view.pr).toMatchObject({ id: prId, state: 'open', title: TITLE });
    expect(view.detail).toMatchObject({ mergeState: 'clean', headSha: SHA, fetchedAt: Date.now(), mergeMethods: ['squash', 'rebase'] });
    expect(view.detail!.bodyHtml).toMatch(/^<p><img src="http:\/\/127\.0\.0\.1:3211\/ghmedia\/[A-Za-z0-9_-]{43}\/0"><\/p>$/);
    expect(view.detail!.checks.map((c) => c.key)).toEqual(['check:555', 'status:Vercel']);
    expect(view.items.map((i) => i.key)).toEqual(['comment:1', 'review:11']);
    expect(await owner.query(api.githubPr.view, { repo: REPO, number: 8 })).toBeNull();

    const [summary] = await owner.query(api.githubPr.summaries, { prIds: [prId] });
    expect(summary).toMatchObject({ id: prId, mergeState: 'clean', checks: { total: 2, failed: 0, pending: 0 }, review: 'approved', comments: 1 });
    // The fetch also stores the small status the pull requests page reads.
    const status = () => t.run(async (ctx) => await ctx.db.query('pullRequestStatus').withIndex('by_pr', (q) => q.eq('prId', prId)).unique());
    expect(await status()).toMatchObject({ draft: false, mergeState: 'clean', checks: { total: 2, failed: 0, pending: 0 }, review: 'approved' });

    // no new fetch within 60 s
    const before = fake.calls.length;
    expect(await owner.action(api.githubPr.refresh, { prIds: [prId] })).toEqual({ refreshed: 0 });
    expect(fake.calls.length).toBe(before);

    // reconcile: comment 1 stays (same _id), review changed, new comment added
    const idsBefore = await t.run(async (ctx) => await ctx.db.query('pullRequestItems').collect());
    routes = {
      ...routes,
      [`GET ${BASE}/issues/7/comments`]: [
        { id: 1, user: user('octocat'), body_html: '<p>Hello</p>', created_at: '2026-10-08T10:05:00Z', html_url: 'u1' },
        { id: 2, user: user('vercel[bot]'), body_html: '<p>Preview</p>', created_at: '2026-10-08T10:30:00Z', html_url: 'u2' },
      ],
      [`GET ${BASE}/pulls/7/reviews`]: [{ id: 11, user: user('anna'), body_html: '', state: 'DISMISSED', submitted_at: '2026-10-08T10:20:00Z', html_url: 'u11' }],
    };
    stubGithub(routes);
    vi.setSystemTime(Date.now() + 1000);
    expect(await owner.action(api.githubPr.refresh, { prIds: [prId], maxAgeMs: 0 })).toEqual({ refreshed: 1 });
    const items = await t.run(async (ctx) => await ctx.db.query('pullRequestItems').collect());
    expect(items.map((i) => [i.key, i.reviewState])).toEqual([
      ['comment:1', undefined],
      ['review:11', 'dismissed'],
      ['comment:2', undefined],
    ]);
    expect(items.find((i) => i.key === 'comment:1')!._id).toBe(idsBefore.find((i) => i.key === 'comment:1')!._id);
    const [after] = await owner.query(api.githubPr.summaries, { prIds: [prId] });
    expect(after).toMatchObject({ comments: 2 });
    expect(after).not.toHaveProperty('review');

    // vanished items are deleted
    stubGithub({ ...routes, [`GET ${BASE}/issues/7/comments`]: [], [`GET ${BASE}/pulls/7/reviews`]: [] });
    vi.setSystemTime(Date.now() + 1000);
    await owner.action(api.githubPr.refresh, { prIds: [prId], maxAgeMs: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.query('pullRequestItems').collect()).length)).toBe(0);
  });

  test('fetch error: only error and fetchedAt, previous state stays; a clear message without a token', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    stubGithub(prRoutes());
    await owner.action(api.githubPr.refresh, { prIds: [prId] });
    stubGithub({ [`GET ${BASE}/pulls/7`]: { status: 401, body: { message: 'Bad credentials' } } });
    vi.setSystemTime(Date.now() + 1000);
    const result = await owner.action(api.githubPr.refresh, { prIds: [prId], maxAgeMs: 0 });
    expect(result.refreshed).toBe(0);
    expect(result.error).toMatch(/rejects the token: invalid or expired/);
    const view = (await owner.query(api.githubPr.view, { repo: REPO, number: 7 }))!;
    expect(view.error).toBe(result.error);
    expect(view.detail).toMatchObject({ error: result.error, fetchedAt: Date.now(), mergeState: 'clean' });
    expect(view.items).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain(TOKEN);

    // first fetch fails: no state, but the error is visible
    const other = await insertPr(t, { number: 8 });
    await owner.action(api.githubPr.refresh, { prIds: [other] });
    const empty = (await owner.query(api.githubPr.view, { repo: REPO, number: 8 }))!;
    expect(empty.detail).toBeNull();
    expect(empty.error).toMatch(/not granted to the token/);

    delete process.env.GITHUB_TOKEN;
    expect(await owner.action(api.githubPr.refresh, { prIds: [prId] })).toEqual({
      refreshed: 0,
      error: 'GitHub access is not set up (GITHUB_TOKEN).',
    });
    expect(await owner.query(api.githubPr.status, {})).toEqual({ configured: false });
  });

  test('clipping: description and items stay under the limits, at most 300 items (the newest)', async () => {
    const { t } = init();
    const prId = await insertPr(t);
    const items: PrItem[] = Array.from({ length: 320 }, (_, i) => ({
      key: `comment:${i}`,
      kind: 'comment' as const,
      author: { login: 'x', bot: false },
      html: i === 319 ? `<p>${'b'.repeat(200_000)}</p>` : '<p>short</p>',
      createdAt: i,
      url: `u${i}`,
    }));
    const snap = snapshot({ items });
    snap.detail.bodyHtml = `<p>${'ü'.repeat(200_000)}</p>`; // 400 kB UTF-8
    await t.mutation(internal.githubPr.store, { prId, fetchedAt: Date.now(), mediaKey: 'k'.repeat(43), snapshot: snap });
    const row = (await detailRow(t, prId))!;
    expect(new TextEncoder().encode(row.data!.bodyHtml).length).toBeLessThanOrEqual(PR_LIMITS.bodyBytes);
    expect(row.data!.bodyHtml).toContain(`… truncated, <a href="https://github.com/${REPO}/pull/7">view on GitHub</a>`);
    const stored = await t.run(async (ctx) => await ctx.db.query('pullRequestItems').collect());
    expect(stored).toHaveLength(300);
    expect(Math.min(...stored.map((s) => s.createdAt))).toBe(20);
    const big = stored.find((s) => s.key === 'comment:319')!;
    expect(big.html.length).toBeLessThanOrEqual(PR_LIMITS.itemBytes);
    expect(big.html).toContain('truncated');
  });

  test('mergeability unknown: two more times, 3 s apart', async () => {
    const { t } = init();
    const prId = await insertPr(t);
    const unknown = snapshot({}, { mergeable: null, mergeable_state: 'unknown' });
    for (const expected of [true, true, false]) {
      const result = await t.mutation(internal.githubPr.store, { prId, fetchedAt: Date.now(), mediaKey: 'k'.repeat(43), snapshot: unknown });
      expect(result.retry).toBe(expected);
      vi.setSystemTime(Date.now() + 3500);
    }
    expect(await pendingRefreshes(t)).toHaveLength(2);
    await t.mutation(internal.githubPr.store, { prId, fetchedAt: Date.now(), mediaKey: 'k'.repeat(43), snapshot: snapshot() });
    expect((await detailRow(t, prId))!.mergeRetries).toBeUndefined();
  });
});

describe('rate limit: no duplicate fetches', () => {
  test('concurrent refresh calls (list and view) fetch only once; viewedAt set', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    const fake = stubGithub(prRoutes());
    const results = await Promise.all([
      owner.action(api.githubPr.refresh, { prIds: [prId] }),
      owner.action(api.githubPr.refresh, { prIds: [prId] }),
    ]);
    expect(results.map((r) => r.refreshed).sort()).toEqual([0, 1]);
    expect(fake.calls.filter((c) => c.path === `${BASE}/pulls/7`)).toHaveLength(1);
    const row = (await detailRow(t, prId))!;
    expect(row.viewedAt).toBe(Date.now());
    expect(row.fetchingSince).toBeUndefined();
  });

  test('a scheduled fetch is skipped if already fetched since the trigger; an older fetch does not overwrite a newer one', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    const fake = stubGithub(prRoutes());
    const since = Date.now();
    vi.setSystemTime(since + 1000);
    await owner.action(api.githubPr.refresh, { prIds: [prId] });
    const calls = fake.calls.length;
    await t.action(internal.githubPr.refreshOne, { prId, since });
    expect(fake.calls.length).toBe(calls);
    await t.action(internal.githubPr.refreshOne, { prId, since: Date.now() + 1 });
    expect(fake.calls.length).toBeGreaterThan(calls);

    const newest = (await detailRow(t, prId))!.fetchedAt!;
    const old = await t.mutation(internal.githubPr.store, {
      prId,
      fetchedAt: newest - 5000,
      mediaKey: 'k'.repeat(43),
      snapshot: snapshot({ title: 'Outdated' }),
    });
    expect(old.stored).toBe(false);
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', prId)))!.title).toBe(TITLE);
    expect((await t.mutation(internal.githubPr.store, { prId, fetchedAt: newest - 1, mediaKey: 'k'.repeat(43), error: 'old' })).stored).toBe(false);
    expect((await detailRow(t, prId))!.error).toBeUndefined();
  });

  test('merge through Selfbound: state fetched right away, issue closed exactly once, webhook afterwards has no effect', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { status: 'in_progress' });
    await deliver(
      t,
      'pull_request',
      { action: 'opened', number: 7, repository: { full_name: REPO }, pull_request: prJson({ body: `Fixes ${issue.identifier}` }) },
      'd-open',
    );
    const prId = (await t.run(async (ctx) => await ctx.db.query('pullRequests').first()))!._id;
    let merged = false;
    const mergedAt = new Date(Date.now()).toISOString();
    stubGithub(
      prRoutes({
        [`GET ${BASE}/pulls/7`]: () => ({
          body: merged ? prJson({ state: 'closed', merged: true, merged_at: mergedAt, mergeable: null, updated_at: mergedAt }) : prJson(),
        }),
        [`PUT ${BASE}/pulls/7/merge`]: () => {
          merged = true;
          return { body: { merged: true, sha: 'c'.repeat(40) } };
        },
      }),
    );
    await owner.action(api.githubPr.refresh, { prIds: [prId] });
    expect(await owner.action(api.githubPr.merge, { prId, method: 'merge', deleteBranch: false })).toEqual({ merged: true, branchDeleted: false });
    expect((await owner.query(api.githubPr.view, { repo: REPO, number: 7 }))!.pr.state).toBe('merged');
    expect((await getIssue(t, issue.id)).status).toBe('done');
    const hook = await deliver(
      t,
      'pull_request',
      { action: 'closed', number: 7, repository: { full_name: REPO }, pull_request: prJson({ state: 'closed', merged: true, merged_at: mergedAt, updated_at: mergedAt, body: `Fixes ${issue.identifier}` }) },
      'd-merge',
    );
    expect(hook.closed).toEqual([]);
    const events = await t.run(async (ctx) => await ctx.db.query('pushEvents').collect());
    expect(events.filter((e) => e.kind === 'pr_merged')).toHaveLength(1);
  });
});

describe('merge transition (fetch and webhook)', () => {
  async function linkedPr(t: T, owner: ReturnType<typeof setup>['owner'], number: number) {
    const f = await fixture(owner).catch(() => null);
    const teams = await t.run(async (ctx) => await ctx.db.query('teams').collect());
    const orb = f?.orb ?? teams.find((x) => x.key === 'ORB')!._id;
    const issue = await createOne(owner, orb, { status: 'in_progress' });
    const id = issue.identifier.toLowerCase();
    await deliver(
      t,
      'pull_request',
      {
        action: 'opened',
        number,
        repository: { full_name: REPO },
        pull_request: { ...prJson({ number, html_url: `https://github.com/${REPO}/pull/${number}` }), head: { ref: `octocat/${id}-x`, sha: SHA } },
      },
      `d-open-${number}`,
    );
    const pr = await t.run(async (ctx) =>
      await ctx.db.query('pullRequests').withIndex('by_repo_number', (q) => q.eq('repo', REPO).eq('number', number)).unique(),
    );
    return { issue, prId: pr!._id };
  }

  const merged = (mergedAt: number) =>
    snapshot({ state: 'merged', mergedAt, updatedAt: mergedAt }, { state: 'closed', merged: true, merged_at: new Date(mergedAt).toISOString(), mergeable: null });

  test('fetch before the webhook: the fetch closes, the webhook afterwards does not close again', async () => {
    const { t, owner } = init();
    const { issue, prId } = await linkedPr(t, owner, 7);
    const now = Date.now();
    const result = await t.mutation(internal.githubPr.store, { prId, fetchedAt: now, mediaKey: 'k'.repeat(43), snapshot: merged(now - 60_000) });
    expect(result.closed).toEqual([issue.identifier]);
    expect((await getIssue(t, issue.id)).status).toBe('done');
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', prId)))).toMatchObject({ state: 'merged', mergedAt: now - 60_000 });
    const hook = await deliver(
      t,
      'pull_request',
      {
        action: 'closed',
        number: 7,
        repository: { full_name: REPO },
        pull_request: { ...prJson({ state: 'closed', merged: true, merged_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now).toISOString() }) },
      },
      'd-merge',
    );
    expect(hook.closed).toEqual([]);
    // notification pr_merged exactly once
    const events = await t.run(async (ctx) => await ctx.db.query('pushEvents').collect());
    expect(events.filter((e) => e.kind === 'pr_merged')).toHaveLength(1);
  });

  test('webhook before the fetch: the fetch closes nothing more; an old merge (> 1 day) never closes', async () => {
    const { t, owner } = init();
    const { issue, prId } = await linkedPr(t, owner, 7);
    const now = Date.now();
    const hook = await deliver(
      t,
      'pull_request',
      {
        action: 'closed',
        number: 7,
        repository: { full_name: REPO },
        pull_request: { ...prJson({ state: 'closed', merged: true, merged_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }) },
      },
      'd-merge',
    );
    expect(hook.closed).toEqual([issue.identifier]);
    const result = await t.mutation(internal.githubPr.store, { prId, fetchedAt: now, mediaKey: 'k'.repeat(43), snapshot: merged(now) });
    expect(result.closed).toEqual([]);

    const old = await linkedPr(t, owner, 8);
    const late = await t.mutation(internal.githubPr.store, { prId: old.prId, fetchedAt: now, mediaKey: 'k'.repeat(43), snapshot: merged(now - 2 * 86_400_000) });
    expect(late.closed).toEqual([]);
    expect((await getIssue(t, old.issue.id)).status).toBe('in_progress');
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', old.prId)))!.state).toBe('merged');
  });

  test('closed and reopened: state follows GitHub, merged stays merged', async () => {
    const { t } = init();
    const prId = await insertPr(t);
    const store = (snap: PrSnapshot) => t.mutation(internal.githubPr.store, { prId, fetchedAt: Date.now(), mediaKey: 'k'.repeat(43), snapshot: snap });
    await store(snapshot({ state: 'closed', updatedAt: Date.parse('2026-10-08T11:00:00Z') }));
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', prId)))!.state).toBe('closed');
    await store(snapshot({ state: 'draft', updatedAt: Date.parse('2026-10-08T11:30:00Z') }));
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', prId)))!.state).toBe('draft');
    await t.run(async (ctx) => await ctx.db.patch('pullRequests', prId, { state: 'merged' }));
    await store(snapshot({ state: 'open', updatedAt: Date.parse('2026-10-08T11:50:00Z') }));
    expect((await t.run(async (ctx) => await ctx.db.get('pullRequests', prId)))!.state).toBe('merged');
  });
});

describe('pull requests page (githubPr.list, githubPr.attention)', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-10-08T12:00:00Z');

  function data(checks: PrCheckState[], mergeState: PrMergeState = 'clean', draft = false): Omit<PrDetail, 'fetchedAt' | 'error'> {
    return {
      bodyHtml: '',
      author: { login: 'alex-example', bot: false },
      createdAt: NOW - 48 * HOUR,
      baseRef: 'main',
      headRef: 'feature/x',
      headSha: SHA,
      draft,
      mergeState,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      commits: 1,
      labels: [],
      requestedReviewers: [],
      checks: checks.map((state, n) => ({ key: `check:${n}`, name: `CI ${n}`, source: 'check' as const, state })),
      mergeMethods: ['merge'],
      deleteBranchOnMerge: false,
      headBranchDeletable: false,
    };
  }

  async function addPr(
    t: T,
    pr: { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; hoursAgo: number; issues: Id<'issues'>[]; mergedHoursAgo?: number },
    detail?: { data: Omit<PrDetail, 'fetchedAt' | 'error'>; review?: 'approved' | 'changes_requested'; statusRow?: false },
  ) {
    return await t.run(async (ctx) => {
      const prId = await ctx.db.insert('pullRequests', {
        repo: REPO,
        number: pr.number,
        title: `PR ${pr.number}`,
        url: `https://github.com/${REPO}/pull/${pr.number}`,
        state: pr.state,
        branch: `orb-${pr.number}`,
        updatedAt: NOW - pr.hoursAgo * HOUR,
        ...(pr.mergedHoursAgo !== undefined ? { mergedAt: NOW - pr.mergedHoursAgo * HOUR } : {}),
      });
      for (const issueId of pr.issues) await ctx.db.insert('issuePullRequests', { issueId, prId, via: 'branch', closes: true });
      if (detail) {
        await ctx.db.insert('pullRequestDetails', {
          prId,
          media: [],
          fetchedAt: NOW - HOUR,
          data: detail.data,
          summary: { comments: 0, ...(detail.review ? { review: detail.review } : {}) },
        });
        // As a fetch stores it; without it (fetched before the table existed) the page reads the details.
        if (detail.statusRow !== false) await writeStatus(ctx, prId, prStatusOf(detail.data, detail.review));
      }
      return prId;
    });
  }

  test('linked PRs only, once each with all issues, grouped by what comes next, newest first; done for 14 days', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.orb);
    const c = await createOne(owner, f.nova);
    const gone = await createOne(owner, f.orb);

    await addPr(t, { number: 1, state: 'open', hoursAgo: 5, issues: [a.id, b.id] }, { data: data(['success', 'skipped']), review: 'approved' });
    await addPr(t, { number: 12, state: 'open', hoursAgo: 1, issues: [c.id] }, { data: data([], 'behind') });
    await addPr(t, { number: 2, state: 'open', hoursAgo: 2, issues: [c.id] }, { data: data(['failure', 'pending'], 'dirty') });
    await addPr(t, { number: 13, state: 'open', hoursAgo: 3, issues: [b.id] }, { data: data(['cancelled']), statusRow: false });
    await addPr(t, { number: 3, state: 'open', hoursAgo: 4, issues: [a.id] }, { data: data(['success', 'pending']) });
    await addPr(t, { number: 4, state: 'open', hoursAgo: 6, issues: [c.id] }, { data: data(['success'], 'dirty'), review: 'changes_requested', statusRow: false });
    await addPr(t, { number: 10, state: 'open', hoursAgo: 7, issues: [a.id] });
    await addPr(t, { number: 5, state: 'draft', hoursAgo: 1, issues: [b.id] }, { data: data(['failure'], 'draft', true) });
    await addPr(t, { number: 14, state: 'open', hoursAgo: 2, issues: [b.id] }, { data: data(['success'], 'clean', true) });
    await addPr(t, { number: 7, state: 'merged', hoursAgo: 72, mergedHoursAgo: 72, issues: [a.id] });
    // Merged a month ago, commented on yesterday: not in the 14 days.
    await addPr(t, { number: 15, state: 'merged', hoursAgo: 20, mergedHoursAgo: 30 * 24, issues: [a.id] });
    await addPr(t, { number: 9, state: 'closed', hoursAgo: 24, issues: [b.id] });
    // Not on the page: unlinked, done longer than 14 days ago, linked only to an issue in the trash.
    await addPr(t, { number: 6, state: 'open', hoursAgo: 1, issues: [] }, { data: data(['success']) });
    await addPr(t, { number: 8, state: 'merged', hoursAgo: 15 * 24, issues: [a.id] });
    await addPr(t, { number: 11, state: 'open', hoursAgo: 1, issues: [gone.id] }, { data: data(['success']) });
    await owner.mutation(api.issues.remove, { ids: [gone.id] });

    const list = await owner.query(api.githubPr.list, {});
    expect(list.configured).toBe(true);
    expect(list.items.map((i) => [i.number, i.group])).toEqual([
      [12, 'ready'],
      [1, 'ready'],
      [2, 'failing'],
      [13, 'failing'],
      [3, 'running'],
      [4, 'blocked'],
      [10, 'blocked'],
      [5, 'draft'],
      [14, 'draft'],
      [9, 'done'],
      [7, 'done'],
    ]);
    const byNumber = new Map(list.items.map((i) => [i.number, i]));
    expect(byNumber.get(1)!.issueIds).toEqual([a.id, b.id]);
    expect(byNumber.get(1)!.review).toBe('approved');
    expect(byNumber.get(1)!.checks).toEqual({ total: 2, failed: 0, pending: 0 });
    expect(byNumber.get(13)!.checks).toEqual({ total: 1, failed: 1, pending: 0 });
    // Failing with conflicts: the conflicts still show on the row.
    expect(byNumber.get(2)!.blockers).toEqual(['conflicts']);
    expect(byNumber.get(4)!.blockers).toEqual(['conflicts', 'changes_requested']);
    expect(byNumber.get(10)!.blockers).toEqual(['unknown']);
    expect(byNumber.get(10)!.checks).toBeUndefined();
    expect(byNumber.get(5)!.blockers).toBeUndefined();
    expect(byNumber.get(7)!.checks).toBeUndefined();

    expect(await owner.query(api.githubPr.attention, {})).toEqual({ ready: 2, failing: 2 });

    // The count reads the small status rows, not the details: details alone (no row) only for #13 and #4.
    const rows = await t.run(async (ctx) => (await ctx.db.query('pullRequestStatus').collect()).length);
    expect(rows).toBe(8);

    // Restoring the issue brings its PR back; merging a ready one moves it to done and out of the count.
    await owner.mutation(api.issues.restore, { ids: [gone.id] });
    await t.run(async (ctx) => {
      const pr = (await ctx.db.query('pullRequests').withIndex('by_repo_number', (q) => q.eq('repo', REPO).eq('number', 12)).unique())!;
      await ctx.db.patch('pullRequests', pr._id, { state: 'merged', updatedAt: NOW });
    });
    const after = await owner.query(api.githubPr.list, {});
    expect(after.items.filter((i) => i.group === 'ready').map((i) => i.number)).toEqual([11, 1]);
    expect(after.items.find((i) => i.number === 12)!.group).toBe('done');
    expect(await owner.query(api.githubPr.attention, {})).toEqual({ ready: 2, failing: 2 });
  });

  test('a failed fetch keeps the state but brings a newer check result into the status; the backfill writes missing rows', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const prId = await addPr(t, { number: 1, state: 'open', hoursAgo: 1, issues: [a.id] }, { data: data(['success']) });
    expect(await owner.query(api.githubPr.attention, {})).toEqual({ ready: 1, failing: 0 });
    // A check_run delivery puts a failed check into the details right away (webhook path, unchanged).
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('pullRequestDetails').withIndex('by_pr', (q) => q.eq('prId', prId)).unique())!;
      await ctx.db.patch('pullRequestDetails', row._id, { data: { ...row.data!, checks: [...row.data!.checks, { key: 'check:9', name: 'CI 9', source: 'check', state: 'failure' }] } });
    });
    expect(await owner.query(api.githubPr.attention, {})).toEqual({ ready: 1, failing: 0 });
    // The fetch that follows fails: the status still follows the stored state.
    await t.mutation(internal.githubPr.store, { prId, fetchedAt: NOW, mediaKey: 'k'.repeat(43), error: 'GitHub is unreachable.' });
    expect(await owner.query(api.githubPr.attention, {})).toEqual({ ready: 0, failing: 1 });

    // Fetched before the status table existed: the backfill writes the row, and again changes nothing.
    await addPr(t, { number: 2, state: 'open', hoursAgo: 2, issues: [a.id] }, { data: data(['pending']), statusRow: false });
    const rows = () => t.run(async (ctx) => (await ctx.db.query('pullRequestStatus').collect()).map((r) => r.checks));
    expect(await rows()).toHaveLength(1);
    expect(await t.mutation(internal.migrations.prStatusBackfill, {})).toEqual({ scanned: 2, written: 2, done: true });
    expect(await rows()).toEqual([
      { total: 2, failed: 1, pending: 0 },
      { total: 1, failed: 0, pending: 1 },
    ]);
    await t.mutation(internal.migrations.prStatusBackfill, {});
    expect(await rows()).toHaveLength(2);
  });

  test('without a token: list says so, grouping uses what is stored', async () => {
    const { t, owner } = init();
    delete process.env.GITHUB_TOKEN;
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    await addPr(t, { number: 1, state: 'open', hoursAgo: 1, issues: [a.id] });
    const list = await owner.query(api.githubPr.list, {});
    expect(list).toEqual({ configured: false, items: [expect.objectContaining({ number: 1, group: 'blocked', blockers: ['unknown'], issueIds: [a.id] })] });
    expect(await owner.query(api.githubPr.attention, {})).toEqual({ ready: 0, failing: 0 });
  });
});

describe('actions', () => {
  test('merge: PUT with head commit, delete branch, fetch; errors with a readable message', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    const fake = stubGithub(
      prRoutes({
        [`PUT ${BASE}/pulls/7/merge`]: { merged: true, message: 'Pull Request successfully merged', sha: 'c'.repeat(40) },
        [`DELETE ${BASE}/git/refs/heads/feature/x`]: { status: 204 },
      }),
    );
    await owner.action(api.githubPr.refresh, { prIds: [prId] });
    const result = await owner.action(api.githubPr.merge, { prId, method: 'squash', deleteBranch: true });
    expect(result).toEqual({ merged: true, branchDeleted: true });
    expect(fake.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `${BASE}/pulls/7/merge`, body: { merge_method: 'squash', sha: SHA } });
    expect(fake.calls.find((c) => c.method === 'DELETE')!.path).toBe(`${BASE}/git/refs/heads/feature/x`);
    // state refetched right away (after the merge), nothing scheduled
    const put = fake.calls.findIndex((c) => c.method === 'PUT');
    expect(fake.calls.slice(put).some((c) => c.path === `${BASE}/pulls/7`)).toBe(true);
    expect(await pendingRefreshes(t)).toHaveLength(0);

    stubGithub({ [`PUT ${BASE}/pulls/7/merge`]: { status: 405, body: { message: 'Pull Request is not mergeable' } } });
    const error = await expectCode(owner.action(api.githubPr.merge, { prId, method: 'merge', deleteBranch: false }), 'conflict');
    expect(error.message).toBe('Merge: GitHub says "Pull Request is not mergeable".');
    stubGithub({ [`PUT ${BASE}/pulls/7/merge`]: { status: 403, body: { message: 'Resource not accessible by personal access token' } } });
    const forbidden = await expectCode(owner.action(api.githubPr.merge, { prId, method: 'merge', deleteBranch: false }), 'rejected');
    expect(forbidden.message).toBe('Merge: the token lacks the "Contents" (read and write) permission for this repo.');

    delete process.env.GITHUB_TOKEN;
    await expectCode(owner.action(api.githubPr.merge, { prId, method: 'merge', deleteBranch: false }), 'rejected');
  });

  test('merge: repo deletes the branch itself → no DELETE; fork → notice', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    const fake = stubGithub(
      prRoutes({ [`GET ${BASE}`]: { ...repoJson, delete_branch_on_merge: true }, [`PUT ${BASE}/pulls/7/merge`]: { merged: true } }),
    );
    await owner.action(api.githubPr.refresh, { prIds: [prId] });
    expect(await owner.action(api.githubPr.merge, { prId, method: 'rebase', deleteBranch: true })).toEqual({ merged: true, branchDeleted: true });
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);

    const fork = await insertPr(t, { number: 9 });
    stubGithub(
      prRoutes({
        [`GET ${BASE}/pulls/9`]: prJson({ number: 9, head: { ref: 'main', sha: SHA, repo: { full_name: 'fork-owner/app' } } }),
        [`GET ${BASE}/issues/9/comments`]: [],
        [`GET ${BASE}/pulls/9/reviews`]: [],
        [`GET ${BASE}/pulls/9/comments`]: [],
        [`PUT ${BASE}/pulls/9/merge`]: { merged: true },
      }),
    );
    await owner.action(api.githubPr.refresh, { prIds: [fork] });
    const result = await owner.action(api.githubPr.merge, { prId: fork, method: 'merge', deleteBranch: true });
    expect(result).toMatchObject({ merged: true, branchDeleted: false });
    expect(result.message).toMatch(/fork/);
  });

  test('setState and comment', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    const fake = stubGithub(
      prRoutes({
        [`PATCH ${BASE}/pulls/7`]: {},
        [`POST ${BASE}/issues/7/comments`]: { status: 201, body: { id: 3, user: user('octocat'), body_html: '<p>Thanks</p>', html_url: 'https://github.com/x#c3', created_at: '2026-10-08T12:00:00Z' } },
      }),
    );
    expect(await owner.action(api.githubPr.setState, { prId, state: 'closed' })).toEqual({ state: 'closed' });
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ state: 'closed' });
    expect(await owner.action(api.githubPr.comment, { prId, body: '  Thanks  ' })).toEqual({ url: 'https://github.com/x#c3' });
    expect(fake.calls.find((c) => c.method === 'POST')!.body).toEqual({ body: 'Thanks' });
    await expectCode(owner.action(api.githubPr.comment, { prId, body: '   ' }), 'invalid');
    await expectCode(owner.action(api.githubPr.comment, { prId, body: 'x'.repeat(65537) }), 'invalid');
  });

  test('sign-in required for all public functions', async () => {
    const { t, stranger } = init();
    const prId = await insertPr(t);
    for (const client of [t, stranger]) {
      await expectCode(client.query(api.githubPr.view, { repo: REPO, number: 7 }), 'access_denied');
      await expectCode(client.query(api.githubPr.summaries, { prIds: [prId] }), 'access_denied');
      await expectCode(client.query(api.githubPr.list, {}), 'access_denied');
      await expectCode(client.query(api.githubPr.attention, {}), 'access_denied');
      await expectCode(client.query(api.githubPr.status, {}), 'access_denied');
      await expectCode(client.query(api.githubPr.connection, {}), 'access_denied');
      await expectCode(client.action(api.githubPr.refresh, { prIds: [prId] }), 'access_denied');
      await expectCode(client.action(api.githubPr.merge, { prId, method: 'merge', deleteBranch: false }), 'access_denied');
      await expectCode(client.action(api.githubPr.setState, { prId, state: 'closed' }), 'access_denied');
      await expectCode(client.action(api.githubPr.comment, { prId, body: 'x' }), 'access_denied');
      await expectCode(client.action(api.githubPr.ensureWebhooks, {}), 'access_denied');
    }
  });
});

describe('media proxy GET /ghmedia', () => {
  const uuid = '71d87879-3e6f-4561-abd8-4416f2837ddb';
  const signed = (jwt: string) => `https://private-user-images.githubusercontent.com/1/670463668-${uuid}.webp?jwt=${jwt}`;
  const body = (jwt: string) =>
    `<p><img src="https://github.com/${REPO}/blob/main/docs/a.png?raw=true"></p><p><a href="${signed(jwt)}"><img src="${signed(jwt)}"></a></p>`;

  test('repo file → fresh download_url; attachment → signed URL, refetched after 4 min; otherwise 404', async () => {
    const { t, owner } = init();
    const prId = await insertPr(t);
    let jwt = 'ONE';
    const fake = stubGithub(
      prRoutes({
        [`GET ${BASE}/pulls/7`]: () => ({ body: prJson({ body_html: body(jwt) }) }),
        [`GET ${BASE}/contents/docs/a.png?ref=main`]: { download_url: `https://raw.githubusercontent.com/${REPO}/main/docs/a.png?token=SHORT` },
      }),
    );
    await owner.action(api.githubPr.refresh, { prIds: [prId] });
    const view = (await owner.query(api.githubPr.view, { repo: REPO, number: 7 }))!;
    const key = /\/ghmedia\/([^/]+)\/0/.exec(view.detail!.bodyHtml)![1]!;
    expect(view.detail!.bodyHtml).not.toContain('private-user-images');

    const get = (path: string) => t.fetch(path, { method: 'GET', redirect: 'manual' } as RequestInit);
    const contents = () => fake.calls.filter((c) => c.path.includes('/contents/')).length;
    const file = await get(`/ghmedia/${key}/0`);
    expect(file.status).toBe(302);
    expect(file.headers.get('location')).toBe(`https://raw.githubusercontent.com/${REPO}/main/docs/a.png?token=SHORT`);
    expect(file.headers.get('cache-control')).toBe('private, max-age=60');
    expect(file.headers.get('referrer-policy')).toBe('no-referrer');
    // within 60 s from the cache, without the Contents API
    vi.setSystemTime(Date.now() + 20_000);
    const cached = await get(`/ghmedia/${key}/0`);
    expect(cached.headers.get('location')).toBe(`https://raw.githubusercontent.com/${REPO}/main/docs/a.png?token=SHORT`);
    expect(cached.headers.get('cache-control')).toBe('private, max-age=40');
    expect(contents()).toBe(1);
    vi.setSystemTime(Date.now() + 41_000);
    await get(`/ghmedia/${key}/0`);
    expect(contents()).toBe(2);

    // attachment 61 s after the fetch: still fresh, valid for > 60 s more → cache 60 s
    const fresh = await get(`/ghmedia/${key}/1`);
    expect(fresh.headers.get('location')).toBe(signed('ONE'));
    expect(fresh.headers.get('cache-control')).toBe('private, max-age=60');

    // after 5 minutes: refetch the description, fresh signature
    jwt = 'TWO';
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const pulls = fake.calls.filter((c) => c.path === `${BASE}/pulls/7`).length;
    const renewed = await get(`/ghmedia/${key}/1`);
    expect(renewed.headers.get('location')).toBe(signed('TWO'));
    expect(fake.calls.filter((c) => c.path === `${BASE}/pulls/7`).length).toBe(pulls + 1);
    expect(renewed.headers.get('cache-control')).toBe('private, max-age=60');
    expect((await detailRow(t, prId))!.media[1]).toMatchObject({ kind: 'attachment', url: signed('TWO'), signedAt: Date.now(), source: 'body' });
    expect((await detailRow(t, prId))!.media[1]).not.toHaveProperty('resigningAt');
    // right after: no second refetch
    expect((await get(`/ghmedia/${key}/1`)).headers.get('location')).toBe(signed('TWO'));
    expect(fake.calls.filter((c) => c.path === `${BASE}/pulls/7`).length).toBe(pulls + 1);

    // a refetch is running (another call) and the old signature is still valid: no own fetch
    vi.setSystemTime(Date.now() + 4 * 60_000 + 10_000);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('pullRequestDetails').withIndex('by_pr', (q) => q.eq('prId', prId)).unique())!;
      await ctx.db.patch('pullRequestDetails', row._id, { media: row.media.map((m) => (m.kind === 'attachment' ? { ...m, resigningAt: Date.now() } : m)) });
    });
    const waiting = get(`/ghmedia/${key}/1`);
    await vi.advanceTimersByTimeAsync(500);
    await t.mutation(internal.githubPr.updateSigned, { key, updates: [{ index: 1, url: signed('THREE') }], signedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await waiting).headers.get('location')).toBe(signed('THREE'));
    expect(fake.calls.filter((c) => c.path === `${BASE}/pulls/7`).length).toBe(pulls + 1);

    for (const bad of [`/ghmedia/${key}/9`, `/ghmedia/${'x'.repeat(43)}/0`, `/ghmedia/${key}/0/x`, '/ghmedia/short/0']) {
      expect((await get(bad)).status, bad).toBe(404);
    }
    // without a token: repo files 404
    delete process.env.GITHUB_TOKEN;
    expect((await get(`/ghmedia/${key}/0`)).status).toBe(404);
  });
});

describe('webhooks in all repos', () => {
  const routes = {
    'GET /user': { login: 'octocat' },
    'GET /user/repos': [{ full_name: 'acme/app' }, { full_name: 'acme/old', archived: true }, { full_name: 'acme/new' }],
    'GET /repos/acme/app/hooks': [],
    'POST /repos/acme/app/hooks': { status: 201, body: { id: 1 } },
  };

  test('local: only check and show, never create (even with GITHUB_MANAGE_WEBHOOKS)', async () => {
    const { owner } = init();
    process.env.GITHUB_MANAGE_WEBHOOKS = '1';
    const fake = stubGithub({ ...routes, 'GET /repos/acme/new/hooks': [] });
    const connection = await owner.action(api.githubPr.ensureWebhooks, {});
    expect(connection).toEqual({
      configured: true,
      login: 'octocat',
      checkedAt: Date.now(),
      repos: [
        { repo: 'acme/app', hook: 'missing' },
        { repo: 'acme/new', hook: 'missing' },
      ],
      local: true,
      manage: true,
      canWrite: false,
    });
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(await owner.query(api.githubPr.connection, {})).toEqual(connection);
  });

  test('production: create only with GITHUB_MANAGE_WEBHOOKS=1 and a secret (daily cron); GITHUB_REPOS filter; nothing without a token', async () => {
    const { t } = init({ cloudUrl: 'https://happy-otter-123.convex.cloud' });
    const fake = stubGithub({ ...routes, 'GET /repos/acme/new/hooks': [] });
    // without explicit management: only check
    await t.action(internal.githubPr.ensureWebhooksDaily, {});
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(fake.calls.find((c) => c.path.startsWith('/user/repos'))!.path).toContain('affiliation=owner');

    process.env.GITHUB_MANAGE_WEBHOOKS = '1';
    process.env.GITHUB_REPOS = 'acme/app, anders/*';
    const newRepo = () => fake.calls.filter((c) => c.path.startsWith('/repos/acme/new')).length;
    const newBefore = newRepo();
    await t.action(internal.githubPr.ensureWebhooksDaily, {});
    const post = fake.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ config: { url: 'http://127.0.0.1:3211/github', secret: SECRET, content_type: 'json' } });
    const stored = await t.run(async (ctx) => await readOpsStatus(ctx, 'githubConnection'));
    expect(stored!.value).toMatchObject({ login: 'octocat', repos: [{ repo: 'acme/app', hook: 'created' }] });
    expect(newRepo()).toBe(newBefore); // excluded by the filter

    delete process.env.GITHUB_TOKEN;
    const calls = fake.calls.length;
    await t.action(internal.githubPr.ensureWebhooksDaily, {});
    expect(fake.calls.length).toBe(calls);
  });
});
