import type { FetchLike } from '../../convex/lib/githubApi';

// Fake GitHub REST API for tests: fixtures modelled on real responses (trimmed) and a fetch
// that answers by route and records every call. Never touches the real network.

export const TOKEN = 'github_pat_11SYNTHETIC00000000000_abcdefghijklmnopqrstuvwxyz0123456789';
export const REPO = 'acme/app';
export const SHA = 'a'.repeat(40);

export const user = (login: string, type = 'User') => ({
  login,
  type,
  avatar_url: `https://avatars.githubusercontent.com/u/1?v=4`,
  html_url: `https://github.com/${login}`,
});

export function prJson(extra: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Search field',
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    mergeable: true,
    mergeable_state: 'clean',
    html_url: `https://github.com/${REPO}/pull/7`,
    body_html: '<p>Description</p>',
    user: user('octocat'),
    created_at: '2026-10-08T10:00:00Z',
    updated_at: '2026-10-08T11:00:00Z',
    closed_at: null,
    merged_by: null,
    head: { ref: 'feature/x', sha: SHA, repo: { full_name: REPO } },
    base: { ref: 'main', repo: { full_name: REPO } },
    additions: 10,
    deletions: 2,
    changed_files: 3,
    commits: 1,
    labels: [{ name: 'bug', color: 'd73a4a' }],
    requested_reviewers: [user('renovate[bot]', 'User')],
    requested_teams: [{ name: 'Core', slug: 'core', html_url: 'https://github.com/orgs/acme/teams/core' }],
    _links: { self: { href: 'x' } },
    ...extra,
  };
}

export const repoJson = { default_branch: 'main', allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true, delete_branch_on_merge: false };

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** Answers according to `routes` ('GET /path?query' → response); records every call. */
export function fakeGithub(routes: Record<string, unknown | Route>) {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname + url.search;
    const headers = new Headers(init.headers);
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('authorization') ?? undefined });
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname}`];
    const isResult = (r: unknown): r is { status: number; body?: unknown; headers?: Record<string, string> } => typeof r === 'object' && r !== null && 'status' in r && !Array.isArray(r);
    const result =
      typeof route === 'function' ? (route as Route)(url, init) : route === undefined ? undefined : isResult(route) ? route : { body: route };
    if (!result) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status ?? 200, headers: result.headers });
  };
  return { fetchImpl, calls };
}

export function prRoutes(extra: Record<string, unknown | Route> = {}) {
  const base = `/repos/${REPO}`;
  return {
    [`GET ${base}/pulls/7`]: prJson(),
    [`GET ${base}`]: repoJson,
    [`GET ${base}/issues/7/comments`]: [{ id: 1, user: user('octocat'), body_html: '<p>Hello</p>', created_at: '2026-10-08T10:05:00Z', html_url: 'u1' }],
    [`GET ${base}/pulls/7/reviews`]: [{ id: 11, user: user('anna'), body_html: '', state: 'APPROVED', submitted_at: '2026-10-08T10:20:00Z', html_url: 'u11' }],
    [`GET ${base}/pulls/7/comments`]: [],
    [`GET ${base}/actions/runs`]: { workflow_runs: [{ id: 100, name: 'CI' }] },
    [`GET ${base}/actions/runs/100/jobs`]: {
      jobs: [{ id: 555, name: 'check', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/job/555', started_at: '2026-10-08T10:00:00Z' }],
    },
    [`GET ${base}/commits/${SHA}/check-runs`]: { status: 403, body: { message: 'Resource not accessible by personal access token' } },
    [`GET ${base}/commits/${SHA}/status`]: { statuses: [{ id: 1, context: 'Vercel', state: 'success', target_url: 'https://vercel.com/x' }] },
    ...extra,
  };
}

