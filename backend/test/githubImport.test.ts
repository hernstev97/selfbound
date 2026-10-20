import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { purgeIssue } from '../convex/ops/issues';
import { createOne, setup, type T } from './helpers';
import { fakeGithub, TOKEN, user } from './lib/githubFake';

// Import from GitHub Issues (githubImport.ts): fetch per page, write, repeat without duplicates,
// three-way merge, rate limits. fetch is always mocked; the data is made up.

const REPO = 'acme/app';
const LIB = 'acme/lib';
const API = 'https://api.github.com';
const ISSUES = `/repos/${REPO}/issues?state=all&sort=created&direction=asc&per_page=50`;
const PULLS = `/repos/${REPO}/pulls?state=all&sort=created&direction=asc&per_page=100`;
const COMMENTS = `/repos/${REPO}/issues/comments?sort=created&direction=asc&per_page=100`;

type Summary = {
  status: string;
  counts: Record<string, { seen: number; created: number; updated: number; unchanged: number; skipped: number }>;
  deviations: string[];
  conflicts: string[];
  error: string | null;
  waitingUntil: string | null;
};

function issueJson(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    state_reason: null,
    labels: [],
    user: user('octocat'),
    html_url: `https://github.com/${REPO}/issues/${number}`,
    created_at: `2026-09-0${number}T10:00:00Z`,
    closed_at: null,
    ...extra,
  };
}

function commentJson(id: number, number: number, body: string, login = 'anna') {
  return {
    id,
    issue_url: `${API}/repos/${REPO}/issues/${number}`,
    body,
    user: user(login),
    created_at: '2026-09-09T10:00:00Z',
    updated_at: '2026-09-09T10:00:00Z',
  };
}

/** A small repo: issues 1–4 over two pages, PR 5 in between, comments, PR 5 fixes #1. */
function repoData() {
  return {
    page1: [
      issueJson(1, { labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'Feature' }] }),
      issueJson(2, { state: 'closed', state_reason: 'completed', closed_at: '2026-09-05T10:00:00Z' }),
      { ...issueJson(5), title: 'A PR', pull_request: { url: 'x' } },
    ],
    page2: [
      issueJson(3, { state: 'closed', state_reason: 'not_planned', closed_at: '2026-09-06T10:00:00Z' }),
      issueJson(4, { labels: [{ name: 'BUG' }] }),
    ],
    pulls: [
      {
        number: 5,
        title: 'Fix the crash',
        body: 'Fixes #1\n\nSee #2',
        state: 'closed',
        merged_at: '2026-09-07T10:00:00Z',
        html_url: `https://github.com/${REPO}/pull/5`,
        head: { ref: 'fix-crash' },
        user: user('octocat'),
        created_at: '2026-09-05T10:00:00Z',
        updated_at: '2026-09-07T10:00:00Z',
      },
    ],
    comments: [commentJson(101, 1, 'First comment'), commentJson(102, 5, 'Comment on the PR'), commentJson(103, 2, 'Done', 'dependabot[bot]')],
  };
}

function routes(data = repoData(), extra: Record<string, unknown> = {}) {
  const page2 = `/repos/${REPO}/issues?state=all&sort=created&direction=asc&per_page=50&page=2`;
  return {
    [`GET /repos/${REPO}`]: { full_name: REPO },
    [`GET ${ISSUES}`]: { status: 200, body: data.page1, headers: { link: `<${API}${page2}>; rel="next", <${API}${page2}>; rel="last"` } },
    [`GET ${page2}`]: data.page2,
    [`GET ${PULLS}`]: data.pulls,
    [`GET ${COMMENTS}`]: data.comments,
    ...extra,
  };
}

function stubGithub(r: Record<string, unknown>) {
  const fake = fakeGithub(r);
  vi.stubGlobal('fetch', fake.fetchImpl);
  return fake;
}

async function runImport(t: T, args: { team?: string; repos?: string[] } = {}) {
  const runId = await t.mutation(internal.githubImport.start, { team: args.team ?? 'ACME', repos: args.repos ?? [REPO] });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return (await t.query(internal.githubImport.status, { runId })) as Summary;
}

async function teamIssues(t: T, teamId: Id<'teams'>) {
  return await t.run(async (ctx) => {
    const issues = await ctx.db.query('issues').collect();
    return issues.filter((i) => i.teamId === teamId).sort((a, b) => a.number - b.number);
  });
}

async function labelNames(t: T, issue: Doc<'issues'>) {
  return await t.run(async (ctx) => {
    const names = [];
    for (const id of issue.labelIds) names.push((await ctx.db.get('labels', id))!.name);
    return names.sort();
  });
}

async function body(t: T, issueId: Id<'issues'>) {
  return await t.run(
    async (ctx) =>
      (await ctx.db
        .query('issueBodies')
        .withIndex('by_issue', (q) => q.eq('issueId', issueId))
        .unique())!.markdown,
  );
}

async function setupTeam() {
  const { t, owner } = setup();
  const { teamId } = await owner.mutation(api.teams.create, { key: 'ACME', name: 'Acme' });
  // A workspace label with the same name as a GitHub label is reused.
  const feature = (await owner.mutation(api.labels.create, { name: 'feature', hue: 260 })).labelId;
  return { t, owner, teamId, feature };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-20T12:00:00Z'));
  process.env.GITHUB_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GitHub import', () => {
  test('imports issues, labels, comments and PR links into the team', async () => {
    const { t, owner, teamId, feature } = await setupTeam();
    // An issue made in Selfbound keeps its number; imported ones follow.
    await createOne(owner, teamId, { title: 'Local issue' });
    const fake = stubGithub(routes());
    const summary = await runImport(t);
    expect(summary.status).toBe('done');
    expect(summary.counts.issue).toEqual({ seen: 4, created: 4, updated: 0, unchanged: 0, skipped: 0 });
    expect(summary.counts.label).toMatchObject({ created: 1 });
    // Comment on PR 5 is not counted.
    expect(summary.counts.comment).toEqual({ seen: 2, created: 2, updated: 0, unchanged: 0, skipped: 0 });
    expect(summary.counts.pullRequest).toMatchObject({ created: 1 });
    expect(fake.calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`)).toBe(true);

    const issues = await teamIssues(t, teamId);
    expect(issues.map((i) => [i.number, i.title, i.status])).toEqual([
      [1, 'Local issue', 'backlog'],
      [2, 'Issue 1', 'backlog'],
      [3, 'Issue 2', 'done'],
      [4, 'Issue 3', 'canceled'],
      [5, 'Issue 4', 'backlog'],
    ]);
    const [, one, two, three, four] = issues as [Doc<'issues'>, Doc<'issues'>, Doc<'issues'>, Doc<'issues'>, Doc<'issues'>];
    expect(one.createdAt).toBe(Date.parse('2026-09-01T10:00:00Z'));
    expect(one.createdBy).toEqual({ kind: 'import' });
    expect(two.completedAt).toBe(Date.parse('2026-09-05T10:00:00Z'));
    expect(three.canceledAt).toBe(Date.parse('2026-09-06T10:00:00Z'));
    expect(await labelNames(t, one)).toEqual(['bug', 'feature']);
    expect(one.labelIds).toContain(feature);
    // Same label name in another case: same label.
    expect(four.labelIds).toEqual(one.labelIds.filter((id) => id !== feature));
    expect(await body(t, one._id)).toBe(
      `Body 1\n\n---\n\nImported from [acme/app#1](https://github.com/${REPO}/issues/1) on GitHub, opened by octocat.`,
    );

    const comments = await t.run(async (ctx) => await ctx.db.query('comments').collect());
    expect(comments.map((c) => [c.issueId, c.authorName, c.body]).sort()).toEqual(
      [
        [one._id, 'anna (GitHub)', 'First comment'],
        [two._id, 'dependabot[bot] (GitHub)', 'Done'],
      ].sort(),
    );

    const links = await t.run(async (ctx) => await ctx.db.query('issuePullRequests').collect());
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ issueId: one._id, via: 'import', closes: false });
    const pr = await t.run(async (ctx) => await ctx.db.query('pullRequests').first());
    expect(pr).toMatchObject({ repo: REPO, number: 5, state: 'merged', branch: 'fix-crash' });
    // Imported issues do not land in the inbox.
    expect(await t.run(async (ctx) => (await ctx.db.query('inboxEntries').collect()).length)).toBe(0);
  });

  test('a second run creates nothing new', async () => {
    const { t, teamId } = await setupTeam();
    stubGithub(routes());
    await runImport(t);
    const before = await t.run(async (ctx) => ({
      issues: (await ctx.db.query('issues').collect()).length,
      comments: (await ctx.db.query('comments').collect()).length,
      labels: (await ctx.db.query('labels').collect()).length,
      prs: (await ctx.db.query('issuePullRequests').collect()).length,
      history: (await ctx.db.query('history').collect()).length,
    }));
    const again = await runImport(t);
    expect(again.status).toBe('done');
    expect(again.counts.issue).toEqual({ seen: 4, created: 0, updated: 0, unchanged: 4, skipped: 0 });
    expect(again.counts.comment).toEqual({ seen: 2, created: 0, updated: 0, unchanged: 2, skipped: 0 });
    expect(again.counts.pullRequest).toEqual({ seen: 1, created: 0, updated: 0, unchanged: 1, skipped: 0 });
    expect(again.counts.label).toBeUndefined();
    const after = await t.run(async (ctx) => ({
      issues: (await ctx.db.query('issues').collect()).length,
      comments: (await ctx.db.query('comments').collect()).length,
      labels: (await ctx.db.query('labels').collect()).length,
      prs: (await ctx.db.query('issuePullRequests').collect()).length,
      history: (await ctx.db.query('history').collect()).length,
    }));
    expect(after).toEqual(before);
    expect((await teamIssues(t, teamId)).length).toBe(4);
  });

  test('takes GitHub changes, keeps Selfbound changes, reports conflicts', async () => {
    const { t, owner, teamId } = await setupTeam();
    stubGithub(routes());
    await runImport(t);
    const [one, two, , four] = await teamIssues(t, teamId);
    // In Selfbound: rename #1 and #2.
    await owner.mutation(api.issues.update, { ids: [one!._id], patch: { title: 'Renamed here' } });
    await owner.mutation(api.issues.update, { ids: [two!._id], patch: { title: 'Renamed here too' } });
    await owner.mutation(api.issues.update, { ids: [four!._id], patch: { snoozedUntil: '2026-11-01', priority: 2 } });
    // On GitHub: #1 gets a new title (conflict), #2 a new body (taken, title stays),
    // #4 is closed (taken), a comment is edited.
    const data = repoData();
    data.page1[0] = { ...data.page1[0]!, title: 'Renamed on GitHub' };
    data.page1[1] = { ...data.page1[1]!, body: 'New body' };
    data.page2[1] = { ...data.page2[1]!, state: 'closed', state_reason: 'completed', closed_at: '2026-10-10T10:00:00Z' };
    data.comments[0] = { ...data.comments[0]!, body: 'Edited comment', updated_at: '2026-10-10T10:00:00Z' };
    stubGithub(routes(data));
    const summary = await runImport(t);
    expect(summary.status).toBe('done');
    expect(summary.counts.issue).toMatchObject({ updated: 2, unchanged: 2 });
    expect(summary.conflicts).toEqual(['ACME-1 (acme/app#1): changed in Selfbound and on GitHub (title); the Selfbound value stays.']);

    const [one2, two2, , four2] = await teamIssues(t, teamId);
    expect(one2!.title).toBe('Renamed here');
    expect(two2!.title).toBe('Renamed here too');
    expect(await body(t, two2!._id)).toMatch(/^New body\n/);
    expect(four2).toMatchObject({ status: 'done', completedAt: Date.parse('2026-10-10T10:00:00Z'), priority: 0 });
    // Closed work keeps no snooze, as when closing in the app.
    expect(four2!.snoozedUntil).toBeUndefined();
    const comment = await t.run(async (ctx) => await ctx.db.query('comments').filter((q) => q.eq(q.field('issueId'), one2!._id)).first());
    expect(comment?.body).toBe('Edited comment');

    // Reopened on GitHub: back to the team's state for new issues.
    data.page2[1] = { ...data.page2[1]!, state: 'open', state_reason: 'reopened', closed_at: null };
    stubGithub(routes(data));
    await runImport(t);
    const four3 = (await teamIssues(t, teamId))[3]!;
    expect(four3.status).toBe('backlog');
    expect(four3.completedAt).toBeUndefined();
  });

  test('permanently deleted issues do not come back', async () => {
    const { t, owner, teamId } = await setupTeam();
    stubGithub(routes());
    await runImport(t);
    const [one] = await teamIssues(t, teamId);
    await owner.mutation(api.issues.remove, { ids: [one!._id] });
    await t.run(async (ctx) => await purgeIssue(ctx, (await ctx.db.get('issues', one!._id))!, Date.now()));
    const summary = await runImport(t);
    expect(summary.counts.issue).toMatchObject({ skipped: 1, unchanged: 3 });
    expect(summary.deviations).toContain('acme/app#1: permanently deleted in Selfbound, not recreated');
    expect((await teamIssues(t, teamId)).length).toBe(3);
  });

  test('waits for the rate limit and goes on', async () => {
    const { t, teamId } = await setupTeam();
    const reset = Math.floor(Date.now() / 1000) + 600;
    let limited = true;
    stubGithub(
      routes(repoData(), {
        [`GET ${PULLS}`]: () =>
          limited
            ? ((limited = false), { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } })
            : { body: repoData().pulls },
      }),
    );
    const runId = await t.mutation(internal.githubImport.start, { team: 'ACME', repos: [REPO] });
    // Run until the pause: the issues are in, the PR step waits.
    for (let i = 0; i < 20; i++) {
      await t.finishInProgressScheduledFunctions();
      await vi.advanceTimersByTimeAsync(10);
    }
    const waiting = (await t.query(internal.githubImport.status, { runId })) as Summary;
    expect(waiting.status).toBe('running');
    expect(waiting.waitingUntil).toBe(new Date(reset * 1000).toISOString());
    expect((await teamIssues(t, teamId)).length).toBe(4);
    // The hourly stale check leaves a waiting run alone.
    await t.mutation(internal.importer.failStale, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = (await t.query(internal.githubImport.status, { runId })) as Summary;
    expect(done.status).toBe('done');
    expect(done.counts.pullRequest).toMatchObject({ created: 1 });
  });

  test('few remaining calls: the next page waits for the reset', async () => {
    const { t } = await setupTeam();
    const reset = Math.floor(Date.now() / 1000) + 900;
    const r = routes();
    stubGithub({ ...r, [`GET ${ISSUES}`]: { ...(r[`GET ${ISSUES}`] as object), headers: { ...(r[`GET ${ISSUES}`] as { headers: object }).headers, 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(reset) } } });
    const runId = await t.mutation(internal.githubImport.start, { team: 'ACME', repos: [REPO] });
    for (let i = 0; i < 5; i++) {
      await t.finishInProgressScheduledFunctions();
      await vi.advanceTimersByTimeAsync(10);
    }
    const waiting = (await t.query(internal.githubImport.status, { runId })) as Summary;
    expect(waiting.status).toBe('running');
    expect(waiting.waitingUntil).toBe(new Date(reset * 1000 + 1000).toISOString());
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(((await t.query(internal.githubImport.status, { runId })) as Summary).status).toBe('done');
  });

  test('errors: no token, unknown repo, PRs not readable, issues disabled', async () => {
    const { t } = await setupTeam();
    delete process.env.GITHUB_TOKEN;
    stubGithub(routes());
    expect(await runImport(t)).toMatchObject({ status: 'failed', error: 'GitHub access is not set up (GITHUB_TOKEN).' });

    process.env.GITHUB_TOKEN = TOKEN;
    stubGithub({});
    const missing = await runImport(t, { repos: ['acme/missing'] });
    expect(missing.status).toBe('failed');
    expect(missing.error).toBe('Read issues of acme/missing: the repo does not exist or is not granted to the token.');

    stubGithub(routes(repoData(), { [`GET ${PULLS}`]: { status: 403, body: { message: 'Resource not accessible by personal access token' } } }));
    const noPulls = await runImport(t);
    expect(noPulls.status).toBe('done');
    expect(noPulls.counts.issue).toMatchObject({ created: 4 });
    expect(noPulls.deviations.some((d) => d.startsWith('acme/app: pull requests not readable'))).toBe(true);

    stubGithub({
      [`GET /repos/${LIB}`]: { full_name: LIB },
      [`GET /repos/${LIB}/issues?state=all&sort=created&direction=asc&per_page=50`]: { status: 410, body: { message: 'Issues are disabled for this repo' } },
      [`GET /repos/${LIB}/pulls?state=all&sort=created&direction=asc&per_page=100`]: [],
      [`GET /repos/${LIB}/issues/comments?sort=created&direction=asc&per_page=100`]: { status: 410, body: { message: 'Issues are disabled for this repo' } },
    });
    const disabled = await runImport(t, { repos: [LIB] });
    expect(disabled.status).toBe('done');
    expect(disabled.deviations).toContain('acme/lib: issues are disabled on GitHub');
  });

  test('checks team and repos before starting, one import at a time', async () => {
    const { t } = await setupTeam();
    await expect(t.mutation(internal.githubImport.start, { team: 'NOPE', repos: [REPO] })).rejects.toThrow(/Team NOPE does not exist/);
    await expect(t.mutation(internal.githubImport.start, { team: 'ACME', repos: ['not a repo'] })).rejects.toThrow(/is not a repo name/);
    await expect(t.mutation(internal.githubImport.start, { team: 'ACME', repos: [] })).rejects.toThrow(/Between 1 and/);
    stubGithub(routes());
    await t.mutation(internal.githubImport.start, { team: 'acme', repos: [`https://github.com/${REPO}`] });
    await expect(t.mutation(internal.githubImport.start, { team: 'ACME', repos: [REPO] })).rejects.toThrow(/already running/);
  });

  test('several repos in one team; PRs link across repos', async () => {
    const { t, teamId } = await setupTeam();
    const lib = {
      [`GET /repos/${LIB}`]: { full_name: LIB },
      [`GET /repos/${LIB}/issues?state=all&sort=created&direction=asc&per_page=50`]: [
        { ...issueJson(1), html_url: `https://github.com/${LIB}/issues/1`, title: 'Lib issue' },
      ],
      [`GET /repos/${LIB}/pulls?state=all&sort=created&direction=asc&per_page=100`]: [],
      [`GET /repos/${LIB}/issues/comments?sort=created&direction=asc&per_page=100`]: [],
    };
    const data = repoData();
    data.pulls[0] = { ...data.pulls[0]!, body: 'Fixes #1, closes acme/lib#1' };
    stubGithub({ ...routes(data), ...lib });
    const summary = await runImport(t, { repos: [REPO, LIB] });
    expect(summary.status).toBe('done');
    const issues = await teamIssues(t, teamId);
    expect(issues.map((i) => i.title)).toEqual(['Issue 1', 'Issue 2', 'Issue 3', 'Issue 4', 'Lib issue']);
    const links = await t.run(async (ctx) => await ctx.db.query('issuePullRequests').collect());
    expect(links.map((l) => l.issueId).sort()).toEqual([issues[0]!._id, issues[4]!._id].sort());
  });
  test('uses the repo spelling from GitHub and the PR row the webhook made', async () => {
    const { t, teamId } = await setupTeam();
    const prId = await t.run(
      async (ctx) =>
        await ctx.db.insert('pullRequests', {
          repo: 'Acme/App',
          number: 5,
          title: 'Fix the crash',
          url: 'https://github.com/Acme/App/pull/5',
          state: 'open',
          branch: 'fix-crash',
          updatedAt: Date.parse('2026-09-05T10:00:00Z'),
        }),
    );
    const data = repoData();
    stubGithub({
      [`GET /repos/${REPO}`]: { full_name: 'Acme/App' },
      [`GET ${ISSUES}`]: [...data.page1, ...data.page2],
      [`GET /repos/Acme/App/pulls?state=all&sort=created&direction=asc&per_page=100`]: data.pulls,
      [`GET /repos/Acme/App/issues/comments?sort=created&direction=asc&per_page=100`]: data.comments,
    });
    const summary = await runImport(t, { repos: [REPO] });
    expect(summary.status).toBe('done');
    const [one] = await teamIssues(t, teamId);
    expect(await body(t, one!._id)).toContain('Imported from [Acme/App#1]');
    const prs = await t.run(async (ctx) => await ctx.db.query('pullRequests').collect());
    expect(prs.map((p) => p._id)).toEqual([prId]);
    expect(summary.counts.comment).toMatchObject({ created: 2 });
    // A second run with another spelling finds the same issues.
    stubGithub({
      [`GET /repos/ACME/APP`]: { full_name: 'Acme/App' },
      [`GET /repos/ACME/APP/issues?state=all&sort=created&direction=asc&per_page=50`]: [...data.page1, ...data.page2],
      [`GET /repos/Acme/App/pulls?state=all&sort=created&direction=asc&per_page=100`]: data.pulls,
      [`GET /repos/Acme/App/issues/comments?sort=created&direction=asc&per_page=100`]: data.comments,
    });
    const again = await runImport(t, { repos: ['ACME/APP'] });
    expect(again.counts.issue).toMatchObject({ created: 0, unchanged: 4 });
  });

  test('secondary limit with only retry-after, GitHub errors, too long a wait', async () => {
    const { t } = await setupTeam();
    let pulls = 0;
    let comments = 0;
    stubGithub(
      routes(repoData(), {
        [`GET ${PULLS}`]: () =>
          pulls++ === 0
            ? { status: 403, body: { message: 'You have triggered an abuse detection mechanism.' }, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4000' } }
            : { body: repoData().pulls },
        [`GET ${COMMENTS}`]: () => (comments++ === 0 ? { status: 502, body: { message: 'Bad Gateway' } } : { body: repoData().comments }),
      }),
    );
    const summary = await runImport(t);
    expect(summary.status).toBe('done');
    expect(summary.counts.pullRequest).toMatchObject({ created: 1 });
    expect(summary.counts.comment).toMatchObject({ created: 2 });
    expect([pulls, comments]).toEqual([2, 2]);

    const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
    stubGithub(routes(repoData(), { [`GET ${PULLS}`]: { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } }));
    const long = await runImport(t);
    expect(long.status).toBe('failed');
    expect(long.error).toMatch(/^GitHub rate limit reached\. Try again in \d+ minutes\.$/);
  });

  test('a page with long texts is written in parts', async () => {
    const { t, teamId } = await setupTeam();
    const long = 'x'.repeat(60_000);
    const page = Array.from({ length: 50 }, (_, i) => ({ ...issueJson(1), number: i + 1, title: `Long ${i + 1}`, body: long }));
    stubGithub({ ...routes(), [`GET ${ISSUES}`]: page, [`GET ${COMMENTS}`]: [] });
    const summary = await runImport(t);
    expect(summary.status).toBe('done');
    expect(summary.counts.issue).toMatchObject({ seen: 50, created: 50 });
    const issues = await teamIssues(t, teamId);
    expect(issues.map((i) => i.number)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect((await body(t, issues[49]!._id)).startsWith(long)).toBe(true);
  });

  test('an issue moved to another team stays there with its labels', async () => {
    const { t, owner, teamId } = await setupTeam();
    const { teamId: other } = await owner.mutation(api.teams.create, { key: 'OTH', name: 'Other' });
    stubGithub(routes());
    await runImport(t);
    const [one] = await teamIssues(t, teamId);
    await owner.mutation(api.issues.moveTeam, { ids: [one!._id], teamId: other });
    // Moving drops ACME's team labels; GitHub's new labels do not follow either.
    const afterMove = await labelNames(t, (await teamIssues(t, other))[0]!);
    const data = repoData();
    data.page1[0] = { ...data.page1[0]!, title: 'New title', labels: [{ name: 'docs' }], state: 'closed', state_reason: 'completed', closed_at: '2026-10-10T10:00:00Z' };
    stubGithub(routes(data));
    const summary = await runImport(t);
    expect(summary.status).toBe('done');
    const moved = (await teamIssues(t, other))[0]!;
    expect(moved).toMatchObject({ _id: one!._id, title: 'New title', status: 'done' });
    expect(await labelNames(t, moved)).toEqual(afterMove);
  });
});
