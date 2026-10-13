import { describe, expect, test } from 'vitest';
import { refreshTargets } from '../../convex/lib/github';
import {
  checkRunState,
  describeGithubError,
  ensureRepoWebhooks,
  fetchPullRequest,
  githubClient,
  GithubApiError,
  mapCheckRuns,
  mapItems,
  mapPullRequest,
  mapStatuses,
  mergeChecks,
  mergeStateOf,
  nextLink,
  capChecks,
  repoAllowed,
  personOf,
  prStateOf,
  repoPath,
  summarizeReviews,
  WEBHOOK_EVENTS,
  type FetchLike,
} from '../../convex/lib/githubApi';
import { classifyMediaUrl, clipHtml, byteLength, findSignedUrl, rewriteMedia, type MediaState } from '../../convex/lib/githubMedia';
import type { PrCheck, PrItem } from '../../convex/shared/pullRequests';

// Building blocks of the PR view: mapping GitHub responses, error texts, media, fetching with
// a mocked fetch. Fixtures modelled on real REST API responses (trimmed).

import { fakeGithub, prJson, prRoutes, repoJson, REPO, SHA, TOKEN, user } from './githubFake';

describe('mapping', () => {
  test('PR → PrDetail', () => {
    const d = mapPullRequest(prJson(), repoJson, [], true);
    expect(d).toMatchObject({
      bodyHtml: '<p>Description</p>',
      author: { login: 'octocat', bot: false },
      baseRef: 'main',
      headRef: 'feature/x',
      headRepo: REPO,
      headSha: SHA,
      mergeState: 'clean',
      additions: 10,
      labels: [{ name: 'bug', color: 'd73a4a' }],
      mergeMethods: ['squash', 'rebase'],
      deleteBranchOnMerge: false,
      headBranchDeletable: true,
    });
    expect(d.requestedReviewers.map((r) => [r.login, r.bot])).toEqual([
      ['renovate[bot]', true],
      ['Core', false],
    ]);
    expect('closedAt' in d).toBe(false);
    // without write access the allow_* fields are missing: offer all methods then
    expect(mapPullRequest(prJson(), {}, [], false).mergeMethods).toEqual(['merge', 'squash', 'rebase']);
  });

  test('state and mergeability', () => {
    expect(prStateOf(prJson())).toBe('open');
    expect(prStateOf(prJson({ draft: true }))).toBe('draft');
    expect(prStateOf(prJson({ state: 'closed' }))).toBe('closed');
    expect(prStateOf(prJson({ state: 'closed', merged: true, merged_at: '2026-10-08T12:00:00Z' }))).toBe('merged');
    expect(mergeStateOf(prJson({ mergeable: null, mergeable_state: 'unknown' }))).toBe('unknown');
    expect(mergeStateOf(prJson({ mergeable: null, mergeable_state: 'clean' }))).toBe('unknown');
    for (const s of ['clean', 'dirty', 'blocked', 'behind', 'unstable', 'draft'])
      expect(mergeStateOf(prJson({ mergeable: s !== 'dirty', mergeable_state: s }))).toBe(s);
    expect(mergeStateOf(prJson({ mergeable_state: 'has_hooks' }))).toBe('unknown');
  });

  test('bots: type Bot or login ending in [bot]', () => {
    expect(personOf(user('github-actions[bot]')).bot).toBe(true);
    expect(personOf(user('vercel', 'Bot')).bot).toBe(true);
    expect(personOf(user('octocat')).bot).toBe(false);
    expect(personOf(null)).toEqual({ login: 'ghost', bot: false });
  });

  test('comments, reviews, review comments: chronological, PENDING dropped, empty reviews kept', () => {
    const items = mapItems(
      [{ id: 1, user: user('octocat'), body_html: '<p>Hello</p>', created_at: '2026-10-08T10:05:00Z', updated_at: '2026-10-08T10:06:00Z', html_url: 'u1' }],
      [
        { id: 10, user: user('anna'), body_html: '', state: 'COMMENTED', submitted_at: '2026-10-08T10:10:00Z', html_url: 'u10' },
        { id: 11, user: user('anna'), body_html: '<p>ok</p>', state: 'APPROVED', submitted_at: '2026-10-08T10:20:00Z', html_url: 'u11' },
        { id: 12, user: user('anna'), state: 'PENDING', html_url: 'u12' },
      ],
      [
        {
          id: 20,
          user: user('anna'),
          body_html: '<p>here</p>',
          path: 'src/a.ts',
          line: null,
          original_line: 12,
          diff_hunk: '@@ -1 +1 @@',
          created_at: '2026-10-08T10:09:00Z',
          updated_at: '2026-10-08T10:09:00Z',
          html_url: 'u20',
        },
        { id: 21, user: user('octocat'), body_html: '<p>yes</p>', path: 'src/a.ts', line: 12, in_reply_to_id: 20, created_at: '2026-10-08T10:11:00Z', html_url: 'u21' },
      ],
    );
    expect(items.map((i) => i.key)).toEqual(['comment:1', 'review_comment:20', 'review:10', 'review_comment:21', 'review:11']);
    expect(items[0]).toMatchObject({ kind: 'comment', html: '<p>Hello</p>', updatedAt: Date.parse('2026-10-08T10:06:00Z') });
    expect(items[1]).toMatchObject({ path: 'src/a.ts', line: 12 });
    expect(items[1]).not.toHaveProperty('updatedAt');
    expect(JSON.stringify(items)).not.toContain('diff_hunk');
    expect(items[2]).toMatchObject({ kind: 'review', reviewState: 'commented', html: '' });
    expect(items[3]).toMatchObject({ replyTo: 'review_comment:20' });
  });

  test('review summary: latest decision per reviewer', () => {
    const review = (login: string, state: PrItem['reviewState'], at: number): PrItem => ({
      key: `review:${at}`,
      kind: 'review',
      author: { login, bot: false },
      html: '',
      createdAt: at,
      url: '',
      reviewState: state,
    });
    expect(summarizeReviews([])).toBeUndefined();
    expect(summarizeReviews([review('a', 'commented', 1)])).toBeUndefined();
    expect(summarizeReviews([review('a', 'approved', 1), review('b', 'commented', 2)])).toBe('approved');
    expect(summarizeReviews([review('a', 'approved', 1), review('b', 'changes_requested', 2)])).toBe('changes_requested');
    expect(summarizeReviews([review('b', 'changes_requested', 1), review('b', 'approved', 2)])).toBe('approved');
    expect(summarizeReviews([review('b', 'changes_requested', 1), review('b', 'commented', 2)])).toBe('changes_requested');
    expect(summarizeReviews([review('b', 'changes_requested', 1), review('b', 'dismissed', 2)])).toBeUndefined();
  });
});

describe('checks', () => {
  test('check run states', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending']) expect(checkRunState({ status, conclusion: null })).toBe('pending');
    const done = (conclusion: string) => checkRunState({ status: 'completed', conclusion });
    expect(done('success')).toBe('success');
    for (const c of ['failure', 'timed_out', 'action_required', 'startup_failure']) expect(done(c)).toBe('failure');
    expect(done('cancelled')).toBe('cancelled');
    expect(done('skipped')).toBe('skipped');
    expect(done('neutral')).toBe('neutral');
    expect(done('stale')).toBe('neutral');
  });

  test('same name → only the newest run; statuses per context', () => {
    const checks = mapCheckRuns([
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-10-08T10:00:00Z', app: { name: 'GitHub Actions' } },
      {
        id: 2,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-08T10:05:00Z',
        completed_at: '2026-10-08T10:06:00Z',
        html_url: 'https://github.com/x/runs/2',
        output: { title: 'All green' },
        app: { name: 'GitHub Actions' },
      },
      { id: 3, name: 'lint', status: 'in_progress', conclusion: null, details_url: 'https://ci.example/3' },
    ]);
    expect(checks).toEqual([
      { key: 'check:3', name: 'lint', source: 'check', state: 'pending', url: 'https://ci.example/3' },
      {
        key: 'check:2',
        name: 'test',
        source: 'check',
        app: 'GitHub Actions',
        state: 'success',
        url: 'https://github.com/x/runs/2',
        summary: 'All green',
        startedAt: Date.parse('2026-10-08T10:05:00Z'),
        completedAt: Date.parse('2026-10-08T10:06:00Z'),
      },
    ]);
    const statuses = mapStatuses([
      { id: 1, context: 'Vercel', state: 'pending', created_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-08T10:00:00Z' },
      { id: 2, context: 'Vercel', state: 'error', target_url: 'https://vercel.com/x', description: 'Build failed', created_at: '2026-10-08T10:01:00Z', updated_at: '2026-10-08T10:02:00Z' },
      { id: 3, context: 'CodeRabbit', state: 'success', created_at: '2026-10-08T10:01:00Z', updated_at: '2026-10-08T10:01:00Z' },
    ]);
    expect(statuses.map((s) => [s.key, s.state, s.summary])).toEqual([
      ['status:CodeRabbit', 'success', undefined],
      ['status:Vercel', 'failure', 'Build failed'],
    ]);
  });

  test('merging API and webhook: completed beats running, name from the API', () => {
    const api: PrCheck[] = [{ key: 'check:5', name: 'CI / test', source: 'check', app: 'GitHub Actions', state: 'pending', startedAt: 1 }];
    const hook: PrCheck[] = [
      { key: 'check:5', name: 'test', source: 'check', app: 'GitHub Actions', state: 'success', startedAt: 1, completedAt: 9 },
      { key: 'check:6', name: 'CodeRabbit', source: 'check', app: 'CodeRabbit', state: 'neutral' },
    ];
    expect(mergeChecks(api, hook)).toEqual([
      { key: 'check:5', name: 'CI / test', source: 'check', app: 'GitHub Actions', state: 'success', startedAt: 1, completedAt: 9 },
      { key: 'check:6', name: 'CodeRabbit', source: 'check', app: 'CodeRabbit', state: 'neutral' },
    ]);
    // an older webhook state (pending) does not overwrite a result from the API
    expect(mergeChecks([{ ...api[0]!, state: 'failure', completedAt: 5 }], [{ ...hook[0]!, state: 'pending', completedAt: undefined }])[0]!.state).toBe('failure');
  });
});

describe('errors', () => {
  const call = { what: 'Read checks', permission: 'Checks' };
  test('texts per status', () => {
    expect(describeGithubError(401, call, 'Bad credentials').message).toMatch(/invalid or expired/);
    expect(describeGithubError(403, call, 'Resource not accessible by personal access token').message).toBe(
      'Read checks: the token lacks the "Checks" (read) permission for this repo.',
    );
    expect(describeGithubError(403, { ...call, write: true }, undefined).message).toContain('(read and write)');
    expect(describeGithubError(404, call, 'Not Found').message).toMatch(/not granted to the token/);
    expect(describeGithubError(405, { what: 'Merge', permission: 'Contents' }, 'Pull Request is not mergeable')).toEqual({
      code: 'conflict',
      message: 'Merge: GitHub says "Pull Request is not mergeable".',
    });
    const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
    expect(describeGithubError(403, call, 'API rate limit exceeded', headers)).toMatchObject({ code: 'rate_limited' });
    expect(describeGithubError(403, call, 'API rate limit exceeded', headers).message).toMatch(/in 10 minutes/);
    expect(describeGithubError(502, call, undefined).code).toBe('unavailable');
  });

  test('the token never appears in a message, even if GitHub echoes it back', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ message: `Token ${TOKEN} broken, also ghp_${'x'.repeat(36)}` }), { status: 422 });
    const client = githubClient(TOKEN, fetchImpl);
    let error: unknown;
    try {
      await client.request('GET', '/repos/acme/app', { what: 'Read repo', permission: 'Metadata' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GithubApiError);
    const text = (error as Error).message;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('ghp_x');
    expect(text).toContain('***');
    for (const status of [401, 403, 404, 409, 500]) {
      const c = githubClient(TOKEN, async () => new Response(JSON.stringify({ message: TOKEN }), { status }));
      await expect(c.request('GET', '/x', call)).rejects.toSatisfy((e: Error) => !e.message.includes(TOKEN));
    }
    await expect(githubClient(TOKEN, async () => Promise.reject(new Error(TOKEN))).request('GET', '/x', call)).rejects.toSatisfy(
      (e: Error) => !e.message.includes(TOKEN),
    );
  });

  test('repo names are validated', () => {
    expect(repoPath('acme/app')).toBe('/repos/acme/app');
    for (const bad of ['../x', 'a/b/c', 'a', 'a/..', 'a b/c']) expect(() => repoPath(bad)).toThrow(GithubApiError);
  });
});

describe('fetching', () => {
  test('everything together; check runs without permission skipped silently, Actions jobs as checks', async () => {
    const { fetchImpl, calls } = fakeGithub(prRoutes());
    const snap = await fetchPullRequest(githubClient(TOKEN, fetchImpl), REPO, 7);
    expect(snap.warnings).toEqual([]);
    expect(snap.state).toBe('open');
    expect(snap.detail.checks.map((c) => [c.key, c.name, c.app, c.state])).toEqual([
      ['check:555', 'CI / check', 'GitHub Actions', 'success'],
      ['status:Vercel', 'Vercel', undefined, 'success'],
    ]);
    expect(snap.items.map((i) => i.key)).toEqual(['comment:1', 'review:11']);
    expect(snap.summary).toEqual({ comments: 1, review: 'approved' });
    expect(snap.detail.headBranchDeletable).toBe(true);
    // headers: token, API version, user agent; body_html via full+json
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.map((c) => c.path)).toContain(`/repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`);
  });

  test('missing permission for Actions or statuses: warning, rest current; 404 on the PR aborts', async () => {
    const base = `/repos/${REPO}`;
    const forbidden = { status: 403, body: { message: 'Resource not accessible by personal access token' } };
    const { fetchImpl } = fakeGithub(prRoutes({ [`GET ${base}/actions/runs`]: forbidden, [`GET ${base}/commits/${SHA}/status`]: forbidden }));
    const snap = await fetchPullRequest(githubClient(TOKEN, fetchImpl), REPO, 7);
    expect(snap.detail.checks).toEqual([]);
    expect(snap.warnings).toEqual([
      'Read GitHub Actions: the token lacks the "Actions" (read) permission for this repo.',
      'Read commit statuses: the token lacks the "Commit statuses" (read) permission for this repo.',
    ]);
    const missing = fakeGithub({});
    await expect(fetchPullRequest(githubClient(TOKEN, missing.fetchImpl), REPO, 7)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('merged: branch deletable only while it still points at the head commit', async () => {
    const base = `/repos/${REPO}`;
    const merged = prJson({ state: 'closed', merged: true, merged_at: '2026-10-08T12:00:00Z', mergeable: null });
    const run = async (branch: unknown) => {
      const { fetchImpl } = fakeGithub(prRoutes({ [`GET ${base}/pulls/7`]: merged, [`GET ${base}/branches/feature/x`]: branch }));
      return (await fetchPullRequest(githubClient(TOKEN, fetchImpl), REPO, 7)).detail.headBranchDeletable;
    };
    expect(await run({ commit: { sha: SHA } })).toBe(true);
    expect(await run({ commit: { sha: 'b'.repeat(40) } })).toBe(false);
    expect(await run(undefined)).toBe(false); // 404
  });

  test('pagination via Link, at most three pages, only api.github.com', async () => {
    let pages = 0;
    const fetchImpl: FetchLike = async (input) => {
      pages++;
      const page = Number(new URL(input).searchParams.get('page') ?? '1');
      return new Response(JSON.stringify([{ id: page }]), {
        headers: { link: `<https://api.github.com/x?page=${page + 1}&per_page=100>; rel="next", <https://api.github.com/x?page=9>; rel="last"` },
      });
    };
    const rows = await githubClient(TOKEN, fetchImpl).list('/x', { what: 'x', permission: 'x' });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(pages).toBe(3);
    expect(nextLink('<https://evil.example/x?page=2>; rel="next"')).toBeUndefined();
  });
});

describe('limits and newest pages', () => {
  test('more than three pages: fetch the last three (newest)', async () => {
    const pages: number[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const page = Number(new URL(input).searchParams.get('page') ?? '1');
      pages.push(page);
      return new Response(JSON.stringify([{ id: page }]), {
        headers: { link: `<https://api.github.com/x?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/x?per_page=100&page=7>; rel="last"` },
      });
    };
    const rows = await githubClient(TOKEN, fetchImpl).list('/x', { what: 'x', permission: 'x' }, { newest: true });
    expect(rows.map((r) => r.id)).toEqual([5, 6, 7]);
    expect(pages.sort()).toEqual([1, 5, 6, 7]);
  });

  test('at most 150 checks, failed and running ones kept', () => {
    const checks: PrCheck[] = Array.from({ length: 200 }, (_, i) => ({
      key: `check:${i}`,
      name: `c${String(i).padStart(3, '0')}`,
      source: 'check' as const,
      state: i === 199 ? 'failure' : i === 198 ? 'pending' : 'success',
    }));
    const capped = capChecks(checks);
    expect(capped).toHaveLength(150);
    expect(capped.map((c) => c.key)).toContain('check:199');
    expect(capped.map((c) => c.key)).toContain('check:198');
    expect(capped[0]!.key).toBe('check:0'); // order preserved
  });

  test('GITHUB_REPOS filter (case-insensitive)', () => {
    expect(repoAllowed('Acme/App', [])).toBe(true);
    expect(repoAllowed('Acme/App', ['acme/app'])).toBe(true);
    expect(repoAllowed('acme/app', ['Acme/*'])).toBe(true);
    expect(repoAllowed('octocat/app', ['acme/*', 'acme/app'])).toBe(false);
  });
});

// ---------------------------------------------------------------- Media

const state = (media: MediaState['media'] = []): MediaState => ({
  siteUrl: 'https://site.example',
  mediaKey: 'KEY',
  repo: REPO,
  media,
  now: 1000,
  source: 'body',
});

describe('media', () => {
  test('raw, blob?raw=true and /raw/ in the PR repo → proxy; other repos and hosts stay', () => {
    const s = state();
    const html = [
      `<img src="https://raw.githubusercontent.com/${REPO}/main/docs/a.png">`,
      `<a href="https://github.com/${REPO}/blob/abc/docs/b.png?raw=true"><img src="https://github.com/${REPO}/blob/abc/docs/b.png?raw=true" alt="b"></a>`,
      `<img src="https://github.com/${REPO.toUpperCase()}/raw/main/docs/a.png">`, // owner/name case-insensitive
      `<img src="https://raw.githubusercontent.com/other/repo/main/x.png">`,
      `<img src="https://camo.githubusercontent.com/abc">`,
      `<a href="https://github.com/${REPO}/blob/main/README.md">File</a>`,
      `<a href="https://github.com/${REPO}/blob/main/docs/c.png">Page</a>`,
      `<a href="https://raw.githubusercontent.com/${REPO}/main/notes.txt">txt</a>`,
    ].join('\n');
    const out = rewriteMedia(html, s);
    expect(out).toBe(
      [
        `<img src="https://site.example/ghmedia/KEY/0">`,
        `<a href="https://site.example/ghmedia/KEY/1"><img src="https://site.example/ghmedia/KEY/1" alt="b"></a>`,
        `<img src="https://site.example/ghmedia/KEY/0">`,
        `<img src="https://raw.githubusercontent.com/other/repo/main/x.png">`,
        `<img src="https://camo.githubusercontent.com/abc">`,
        `<a href="https://github.com/${REPO}/blob/main/README.md">File</a>`,
        `<a href="https://github.com/${REPO}/blob/main/docs/c.png">Page</a>`,
        `<a href="https://raw.githubusercontent.com/${REPO}/main/notes.txt">txt</a>`,
      ].join('\n'),
    );
    expect(s.media).toEqual([
      { kind: 'repo', url: `https://raw.githubusercontent.com/${REPO}/main/docs/a.png` },
      { kind: 'repo', url: `https://raw.githubusercontent.com/${REPO}/abc/docs/b.png` },
    ]);
  });

  test('private-user-images: through the proxy, signed URL and source remembered, same UUID = same index', () => {
    const uuid = '71d87879-3e6f-4561-abd8-4416f2837ddb';
    const signed = (jwt: string) => `https://private-user-images.githubusercontent.com/49064878/670463668-${uuid}.webp?jwt=${jwt}`;
    const s = state([{ kind: 'repo', url: `https://raw.githubusercontent.com/${REPO}/main/x.png` }]);
    const out = rewriteMedia(`<a href="${signed('A').replace('?', '?x=1&amp;')}"><img src="${signed('A')}" data-canonical-src="${signed('A')}"></a>`, s);
    expect(out).toBe(
      '<a href="https://site.example/ghmedia/KEY/1"><img src="https://site.example/ghmedia/KEY/1" data-canonical-src="https://site.example/ghmedia/KEY/1"></a>',
    );
    expect(s.media[1]).toEqual({ kind: 'attachment', url: signed('A'), signedAt: 1000, source: 'body' });
    // next fetch: new signature, same index, new source
    const next = { ...state(s.media), now: 2000, source: 'comment:5' };
    rewriteMedia(`<img src="${signed('B')}">`, next);
    expect(next.media).toHaveLength(2);
    expect(next.media[1]).toEqual({ kind: 'attachment', url: signed('B'), signedAt: 2000, source: 'comment:5' });
    expect(findSignedUrl(`<p><img src="${signed('C').replace('?', '?a=1&amp;')}"></p>`, uuid)).toBe(signed('C').replace('?', '?a=1&'));
    expect(classifyMediaUrl('https://private-user-images.githubusercontent.com/1/broken.png?jwt=x', REPO)).toBeNull();
  });

  test('video link alone in a paragraph gets a <video>; the link stays below it', () => {
    const s = state();
    const out = rewriteMedia(`<p dir="auto"><a href="https://github.com/${REPO}/blob/abc/v/tour.mp4?raw=true">Tour</a></p>`, s);
    expect(out).toBe(
      '<video controls preload="metadata" src="https://site.example/ghmedia/KEY/0"></video><p dir="auto"><a href="https://site.example/ghmedia/KEY/0">Tour</a></p>',
    );
    // link inside running text: no <video>, but rewritten
    expect(rewriteMedia(`<p>See <a href="https://raw.githubusercontent.com/${REPO}/main/v.webm">here</a>.</p>`, state())).toBe(
      '<p>See <a href="https://site.example/ghmedia/KEY/0">here</a>.</p>',
    );
  });

  test('srcset in <picture>', () => {
    const out = rewriteMedia(`<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/${REPO}/main/d.png"></picture>`, state());
    expect(out).toContain('srcset="https://site.example/ghmedia/KEY/0"');
  });

  test('truncating to bytes with a note', () => {
    const html = `<p>${'ä'.repeat(1000)}</p><img src="x">`;
    const out = clipHtml(html, 600, 'https://github.com/acme/app/pull/7');
    expect(byteLength(out)).toBeLessThanOrEqual(600);
    expect(out).toContain('… truncated, <a href="https://github.com/acme/app/pull/7">view on GitHub</a>');
    expect(clipHtml('<p>short</p>', 600)).toBe('<p>short</p>');
    expect(clipHtml('<p>abc</p><img src="https://long"', 30)).not.toMatch(/<img[^>]*$/);
  });
});

describe('webhook targets (refreshTargets)', () => {
  const repository = { full_name: REPO };
  test('per event', () => {
    expect(refreshTargets('pull_request', { action: 'synchronize', repository, pull_request: { number: 7, head: { sha: SHA } } })).toEqual({
      repo: REPO,
      numbers: [7],
      shas: [],
      headSha: SHA,
    });
    expect(refreshTargets('issue_comment', { repository, issue: { number: 7, pull_request: { url: 'x' } } })?.numbers).toEqual([7]);
    expect(refreshTargets('issue_comment', { repository, issue: { number: 7 } })).toBeNull();
    for (const e of ['pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread'])
      expect(refreshTargets(e, { repository, pull_request: { number: 8 } })?.numbers).toEqual([8]);
    expect(
      refreshTargets('check_run', {
        repository,
        check_run: {
          head_sha: SHA,
          pull_requests: [
            { number: 7, base: { repo: { url: `https://api.github.com/repos/${REPO}` } } },
            { number: 9, base: { repo: { url: 'https://api.github.com/repos/other/repo' } } },
          ],
        },
      }),
    ).toEqual({ repo: REPO, numbers: [7], shas: [SHA] });
    expect(refreshTargets('workflow_run', { repository, workflow_run: { head_sha: SHA, pull_requests: [] } })).toEqual({ repo: REPO, numbers: [], shas: [SHA] });
    expect(refreshTargets('status', { repository, sha: SHA })).toEqual({ repo: REPO, numbers: [], shas: [SHA] });
    expect(refreshTargets('push', { repository })).toBeNull();
    expect(refreshTargets('status', { repository })).toBeNull();
  });
});

describe('webhooks in all repos', () => {
  const URL_ = 'https://deploy.convex.site/github';
  const hook = (events: readonly string[], url = URL_) => ({ id: 3, active: true, events, config: { url, content_type: 'json' } });
  const base = {
    'GET /user': { login: 'octocat' },
    'GET /user/repos': [
      { full_name: 'octocat/a' },
      { full_name: 'octocat/b' },
      { full_name: 'octocat/c' },
      { full_name: 'octocat/archived', archived: true },
    ],
  };

  test('present → ok, different events → updated, missing → created (with secret)', async () => {
    const { fetchImpl, calls } = fakeGithub({
      ...base,
      'GET /repos/octocat/a/hooks': [hook(WEBHOOK_EVENTS, `${URL_}/`)],
      'GET /repos/octocat/b/hooks': [hook(['pull_request'])],
      'PATCH /repos/octocat/b/hooks/3': {},
      'GET /repos/octocat/c/hooks': [hook(['push'], 'https://other.example/hook')],
      'POST /repos/octocat/c/hooks': { status: 201, body: { id: 4 } },
    });
    const report = await ensureRepoWebhooks(githubClient(TOKEN, fetchImpl), { urls: [URL_], secret: 's3cret', write: true });
    expect(report).toEqual({
      login: 'octocat',
      repos: [
        { repo: 'octocat/a', hook: 'ok' },
        { repo: 'octocat/b', hook: 'updated' },
        { repo: 'octocat/c', hook: 'created' },
      ],
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: 'web', active: true, events: [...WEBHOOK_EVENTS], config: { url: URL_, content_type: 'json', secret: 's3cret', insecure_ssl: '0' } });
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ events: [...WEBHOOK_EVENTS], active: true });
  });

  test('without write (local, no secret): only report, never create', async () => {
    const { fetchImpl, calls } = fakeGithub({
      ...base,
      'GET /repos/octocat/a/hooks': [],
      'GET /repos/octocat/b/hooks': [hook(['pull_request'])],
      'GET /repos/octocat/c/hooks': [hook(WEBHOOK_EVENTS)],
    });
    for (const opts of [{ secret: 's3cret', write: false }, { write: true }]) {
      const report = await ensureRepoWebhooks(githubClient(TOKEN, fetchImpl), { urls: [URL_], ...opts });
      expect(report.repos.map((r) => r.hook)).toEqual(['missing', 'outdated', 'ok']);
    }
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  test('missing "Webhooks" permission: clear message, only one attempt', async () => {
    const { fetchImpl, calls } = fakeGithub({
      ...base,
      'GET /repos/octocat/a/hooks': { status: 403, body: { message: 'Resource not accessible by personal access token' } },
    });
    const report = await ensureRepoWebhooks(githubClient(TOKEN, fetchImpl), { urls: [URL_], secret: 's3cret', write: true });
    expect(report.error).toBe('The token lacks the "Webhooks" permission (read and write).');
    expect(report.repos.map((r) => r.hook)).toEqual(['error', 'error', 'error']);
    expect(calls.filter((c) => c.path.includes('/hooks'))).toHaveLength(1);
  });
});
