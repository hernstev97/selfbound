import type {
  MergeMethod,
  PrCheck,
  PrCheckState,
  PrDetail,
  PrItem,
  PrLabel,
  PrMergeState,
  PrPerson,
  PrReviewState,
  PrState,
} from '../shared/pullRequests';

// GitHub REST API for the PR view: a small client, error texts, fetching a PR snapshot and
// mapping it onto the types from shared/pullRequests.ts.
//
// Pure except for `fetch` (replaceable in the client, mocked in tests). Runs in the default
// Convex runtime. The token only comes in as an argument; it never appears in a message, not
// even in texts GitHub sends back (those are scrubbed).

export const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** also returns `body_html` */
export const ACCEPT_FULL = 'application/vnd.github.full+json';
const ACCEPT_JSON = 'application/vnd.github+json';
/** at most this many pages (of 100 each) per list */
export const MAX_PAGES = 3;

export const NOT_CONFIGURED = 'GitHub access is not set up (GITHUB_TOKEN).';

// ---------------------------------------------------------------- Errors

export type GithubErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'rate_limited' | 'unavailable';

/** Error of a GitHub call with status and a text for the UI (never contains the token). */
export class GithubApiError extends Error {
  readonly status: number;
  readonly code: GithubErrorCode;
  /** rate_limited: when GitHub accepts calls again (ms), if it said so */
  readonly retryAt?: number;
  constructor(status: number, code: GithubErrorCode, message: string, retryAt?: number) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
    this.code = code;
    if (retryAt !== undefined) this.retryAt = retryAt;
  }
}

/** When a rate limit ends: `retry-after` (secondary limit) first, then `x-ratelimit-reset`. */
export function retryAtOf(headers: { get(name: string): string | null } | undefined, now = Date.now()): number | undefined {
  const retryAfter = Number(headers?.get('retry-after') ?? '');
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  const reset = Number(headers?.get('x-ratelimit-reset') ?? '');
  if (Number.isFinite(reset) && reset > 0) return Math.max(now, reset * 1000);
  return undefined;
}

/** What a call does and which fine-grained token permission it needs (for the error texts). */
export interface CallInfo {
  /** e.g. "Read pull request" */
  what: string;
  /** permission name as in GitHub's token settings, e.g. "Pull requests" */
  permission: string;
  write?: boolean;
  /** text for 404; default: repo not granted to the token or PR unknown */
  notFound?: string;
}

const DEFAULT_NOT_FOUND = 'The repo is not granted to the token, or the pull request does not exist.';

/** Removes the token from a text (in case GitHub ever echoes it back) and truncates. */
export function scrub(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join('***');
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***');
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/**
 * Translates a GitHub error response into a code and a readable text.
 * `githubMessage` is the `message` field of the response (already scrubbed).
 */
export function describeGithubError(
  status: number,
  call: CallInfo,
  githubMessage: string | undefined,
  headers?: { get(name: string): string | null },
  now = Date.now(),
): { code: GithubErrorCode; message: string } {
  const remaining = headers?.get('x-ratelimit-remaining');
  // Secondary limits ("abuse detection") may come with only `retry-after`.
  const rateLimited =
    status === 429 || (status === 403 && (remaining === '0' || !!headers?.get('retry-after') || /rate limit/i.test(githubMessage ?? '')));
  if (rateLimited) {
    const reset = Number(headers?.get('x-ratelimit-reset') ?? '');
    const retryAfter = Number(headers?.get('retry-after') ?? '');
    const minutes = Number.isFinite(reset) && reset > 0
      ? Math.max(1, Math.ceil((reset * 1000 - now) / 60_000))
      : Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.max(1, Math.ceil(retryAfter / 60))
        : undefined;
    return {
      code: 'rate_limited',
      message: `GitHub rate limit reached. Try again ${minutes ? `in ${minutes} minute${minutes === 1 ? '' : 's'}` : 'later'}.`,
    };
  }
  const right = `"${call.permission}" (${call.write ? 'read and write' : 'read'})`;
  switch (status) {
    case 401:
      return { code: 'unauthorized', message: 'GitHub rejects the token: invalid or expired. Renew GITHUB_TOKEN.' };
    case 403:
      return { code: 'forbidden', message: `${call.what}: the token lacks the ${right} permission for this repo.` };
    case 404:
      return { code: 'not_found', message: `${call.what}: ${call.notFound ?? DEFAULT_NOT_FOUND}` };
    case 405:
    case 409:
      return { code: 'conflict', message: `${call.what}: GitHub says "${githubMessage || `status ${status}`}".` };
    case 422:
      return { code: 'invalid', message: `${call.what}: GitHub says "${githubMessage || 'invalid request'}".` };
    default:
      if (status >= 500) return { code: 'unavailable', message: `GitHub is unavailable right now (status ${status}). Try again later.` };
      return { code: 'invalid', message: `${call.what}: GitHub responded with status ${status}${githubMessage ? ` ("${githubMessage}")` : ''}.` };
  }
}

// ---------------------------------------------------------------- Client

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface GithubClient {
  /** REST API call; `path` starts with "/". Statuses in `okStatuses` are not treated as errors. */
  request<T = unknown>(
    method: string,
    path: string,
    call: CallInfo,
    opts?: { accept?: string; body?: unknown; okStatuses?: number[] },
  ): Promise<GithubResponse<T>>;
  /**
   * List across up to `maxPages` (default MAX_PAGES) pages (Link header). `key`: field holding the array
   * (e.g. check_runs). `newest`: if there are more pages, fetch the LAST ones (GitHub sorts ascending).
   */
  list(path: string, call: CallInfo, opts?: { accept?: string; key?: string; maxPages?: number; newest?: boolean }): Promise<Json[]>;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const time = (v: unknown) => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

/** Page `rel` (next, last …) from the Link header, only on api.github.com (the token goes nowhere else). */
export function relLink(link: string | null, rel: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (m && m[2] === rel && m[1]!.startsWith(`${GITHUB_API}/`)) return m[1];
  }
  return undefined;
}

export const nextLink = (link: string | null) => relLink(link, 'next');

/** The same list URL with a different page number. */
function withPage(url: string, page: number) {
  const u = new URL(url);
  u.searchParams.set('page', String(page));
  return u.toString();
}

export function githubClient(token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): GithubClient {
  const headers = (accept = ACCEPT_JSON): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'selfbound',
  });

  async function send(method: string, url: string, call: CallInfo, accept?: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? headers(accept) : { ...headers(accept), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GithubApiError(0, 'unavailable', `${call.what}: GitHub is unreachable. Try again later.`);
    }
    return response;
  }

  async function parse(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function fail(response: Response, call: CallInfo): Promise<never> {
    const data = await parse(response);
    const message = isObj(data) && typeof data.message === 'string' ? scrub(data.message, token) : undefined;
    const { code, message: text } = describeGithubError(response.status, call, message, response.headers);
    throw new GithubApiError(response.status, code, text, code === 'rate_limited' ? retryAtOf(response.headers) : undefined);
  }

  const client: GithubClient = {
    async request<T>(method: string, path: string, call: CallInfo, opts: { accept?: string; body?: unknown; okStatuses?: number[] } = {}) {
      if (!path.startsWith('/')) throw new GithubApiError(0, 'invalid', `${call.what}: invalid path.`);
      const response = await send(method, `${GITHUB_API}${path}`, call, opts.accept, opts.body);
      if (!response.ok && !(opts.okStatuses ?? []).includes(response.status)) await fail(response, call);
      return { status: response.status, data: (await parse(response)) as T, headers: response.headers };
    },
    async list(path, call, opts = {}) {
      const sep = path.includes('?') ? '&' : '?';
      let url: string | undefined = `${GITHUB_API}${path}${/[?&]per_page=/.test(path) ? '' : `${sep}per_page=100`}`;
      const maxPages = opts.maxPages ?? MAX_PAGES;
      const page = async (pageUrl: string) => {
        const response = await send('GET', pageUrl, call, opts.accept);
        if (!response.ok) await fail(response, call);
        const data = await parse(response);
        const rows = (opts.key ? arr(obj(data)[opts.key]) : arr(data)).filter(isObj);
        return { rows, link: response.headers.get('link') };
      };
      const out: Json[] = [];
      for (let n = 0; url && n < maxPages; n++) {
        const { rows, link } = await page(url);
        if (n === 0 && opts.newest) {
          // More pages than we fetch: take the last ones so the current entries are not missing.
          const last = relLink(link, 'last');
          const lastPage = last ? Number(new URL(last).searchParams.get('page')) : 0;
          if (last && Number.isSafeInteger(lastPage) && lastPage > maxPages) {
            const tail = await Promise.all(
              Array.from({ length: maxPages }, (_, i) => page(withPage(last, lastPage - maxPages + 1 + i))),
            );
            return tail.flatMap((t) => t.rows);
          }
        }
        out.push(...rows);
        url = nextLink(link);
      }
      return out;
    },
  };
  return client;
}

// ---------------------------------------------------------------- Paths

const REPO_RE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

/** "/repos/<owner>/<name>"; throws for a repo name that is not "owner/name". */
export function repoPath(repo: string): string {
  const m = REPO_RE.exec(repo);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') {
    throw new GithubApiError(0, 'invalid', `Invalid repo "${repo.slice(0, 200)}".`);
  }
  return `/repos/${m[1]}/${m[2]}`;
}

/** Branch names for /git/refs/heads/… and /branches/…: each segment encoded separately. */
export function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function prNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0) throw new GithubApiError(0, 'invalid', 'Invalid PR number.');
  return number;
}

// ---------------------------------------------------------------- Mapping (pure)

export function isBot(user: unknown): boolean {
  const u = obj(user);
  const login = str(u.login) ?? '';
  return u.type === 'Bot' || login.endsWith('[bot]');
}

export function personOf(user: unknown): PrPerson {
  const u = obj(user);
  const login = str(u.login) ?? 'ghost';
  const avatarUrl = str(u.avatar_url);
  const url = str(u.html_url);
  return { login, ...(avatarUrl ? { avatarUrl } : {}), bot: isBot(u), ...(url ? { url } : {}) };
}

/** State as in `pullRequests`: merged beats closed, draft only for open PRs. */
export function prStateOf(pr: unknown): PrState {
  const p = obj(pr);
  if (p.merged === true || (p.state === 'closed' && str(p.merged_at))) return 'merged';
  if (p.state === 'closed') return 'closed';
  return p.draft === true ? 'draft' : 'open';
}

const MERGE_STATES = new Set<PrMergeState>(['clean', 'dirty', 'blocked', 'behind', 'unstable', 'draft']);

export function mergeStateOf(pr: unknown): PrMergeState {
  const p = obj(pr);
  if (p.mergeable === null || p.mergeable === undefined) return 'unknown';
  const state = str(p.mergeable_state) as PrMergeState | undefined;
  return state && MERGE_STATES.has(state) ? state : 'unknown';
}

export function mergeMethodsOf(repoInfo: unknown): MergeMethod[] {
  const r = obj(repoInfo);
  const flags: [MergeMethod, unknown][] = [
    ['merge', r.allow_merge_commit],
    ['squash', r.allow_squash_merge],
    ['rebase', r.allow_rebase_merge],
  ];
  // Without write access GitHub omits these fields: offer all methods then, GitHub rejects disallowed ones.
  if (flags.every(([, flag]) => typeof flag !== 'boolean')) return ['merge', 'squash', 'rebase'];
  return flags.filter(([, flag]) => flag === true).map(([m]) => m);
}

const CHECK_PENDING = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export function checkRunState(run: unknown): PrCheckState {
  const r = obj(run);
  const status = str(r.status) ?? '';
  if (status !== 'completed' && (CHECK_PENDING.has(status) || !r.conclusion)) return 'pending';
  switch (str(r.conclusion)) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'neutral':
    case 'stale':
      return 'neutral';
    default:
      return status === 'completed' ? 'neutral' : 'pending';
  }
}

export function statusState(state: unknown): PrCheckState {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      return 'pending';
  }
}

const byName = (a: PrCheck, b: PrCheck) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key);

/** Check runs → PrCheck, only the newest run per name (later start, otherwise higher ID). */
export function mapCheckRuns(runs: unknown[]): PrCheck[] {
  const latest = new Map<string, Json>();
  for (const raw of runs) {
    if (!isObj(raw)) continue;
    const name = str(raw.name) ?? '';
    const prev = latest.get(name);
    const newer =
      !prev ||
      (time(raw.started_at) ?? 0) > (time(prev.started_at) ?? 0) ||
      ((time(raw.started_at) ?? 0) === (time(prev.started_at) ?? 0) && (num(raw.id) ?? 0) > (num(prev.id) ?? 0));
    if (newer) latest.set(name, raw);
  }
  return [...latest.values()].map(checkOfRun).sort(byName);
}

/** A check run (API or `check_run` webhook) or an Actions job → PrCheck. */
export function checkOfRun(run: unknown): PrCheck {
  const r = obj(run);
  const app = str(obj(r.app).name);
  const url = str(r.html_url) ?? str(r.details_url);
  const summary = str(obj(r.output).title);
  const startedAt = time(r.started_at);
  const completedAt = time(r.completed_at);
  return {
    key: `check:${num(r.id) ?? str(r.name) ?? '?'}`,
    name: str(r.name) ?? '(unnamed)',
    source: 'check',
    ...(app ? { app } : {}),
    state: checkRunState(r),
    ...(url ? { url } : {}),
    ...(summary ? { summary } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

/** Commit statuses → PrCheck, only the newest per context. */
export function mapStatuses(statuses: unknown[]): PrCheck[] {
  const latest = new Map<string, Json>();
  for (const raw of statuses) {
    if (!isObj(raw)) continue;
    const context = str(raw.context) ?? 'default';
    const prev = latest.get(context);
    const at = (s: Json) => time(s.updated_at) ?? time(s.created_at) ?? 0;
    if (!prev || at(raw) > at(prev) || (at(raw) === at(prev) && (num(raw.id) ?? 0) > (num(prev.id) ?? 0))) latest.set(context, raw);
  }
  return [...latest.entries()]
    .map(([context, s]): PrCheck => {
      const url = str(s.target_url);
      const summary = str(s.description);
      const state = statusState(s.state);
      const startedAt = time(s.created_at);
      const updatedAt = time(s.updated_at);
      return {
        key: `status:${context}`,
        name: context,
        source: 'status',
        state,
        ...(url ? { url } : {}),
        ...(summary ? { summary } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(state !== 'pending' && updatedAt !== undefined ? { completedAt: updatedAt } : {}),
      };
    })
    .sort(byName);
}

function labelsOf(labels: unknown): PrLabel[] {
  return arr(labels)
    .filter(isObj)
    .map((l) => ({ name: str(l.name) ?? '', color: (str(l.color) ?? '').replace(/^#/, '') }))
    .filter((l) => l.name !== '');
}

function reviewersOf(pr: Json): PrPerson[] {
  const users = arr(pr.requested_reviewers).filter(isObj).map(personOf);
  const teams = arr(pr.requested_teams)
    .filter(isObj)
    .map((t): PrPerson => {
      const url = str(t.html_url);
      return { login: str(t.name) ?? str(t.slug) ?? 'Team', bot: false, ...(url ? { url } : {}) };
    });
  return [...users, ...teams];
}

/** PR, repo and checks → PrDetail without `fetchedAt`/`error`. `bodyHtml` not rewritten yet. */
export function mapPullRequest(
  pr: unknown,
  repoInfo: unknown,
  checks: PrCheck[],
  headBranchDeletable: boolean,
): Omit<PrDetail, 'fetchedAt' | 'error'> {
  const p = obj(pr);
  const head = obj(p.head);
  const base = obj(p.base);
  const headRepo = str(obj(head.repo).full_name);
  const closedAt = time(p.closed_at);
  const r = obj(repoInfo);
  return {
    bodyHtml: str(p.body_html) ?? '',
    author: personOf(p.user),
    createdAt: time(p.created_at) ?? 0,
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(isObj(p.merged_by) ? { mergedBy: personOf(p.merged_by) } : {}),
    baseRef: str(base.ref) ?? '',
    headRef: str(head.ref) ?? '',
    ...(headRepo ? { headRepo } : {}),
    headSha: str(head.sha) ?? '',
    draft: p.draft === true,
    mergeState: mergeStateOf(p),
    additions: num(p.additions) ?? 0,
    deletions: num(p.deletions) ?? 0,
    changedFiles: num(p.changed_files) ?? 0,
    commits: num(p.commits) ?? 0,
    labels: labelsOf(p.labels),
    requestedReviewers: reviewersOf(p),
    checks,
    mergeMethods: mergeMethodsOf(r),
    deleteBranchOnMerge: r.delete_branch_on_merge === true,
    headBranchDeletable,
  };
}

export function mapIssueComment(c: unknown): PrItem | null {
  const x = obj(c);
  const id = num(x.id);
  if (id === undefined) return null;
  const updatedAt = time(x.updated_at);
  const createdAt = time(x.created_at) ?? 0;
  return {
    key: `comment:${id}`,
    kind: 'comment',
    author: personOf(x.user),
    html: str(x.body_html) ?? '',
    createdAt,
    ...(updatedAt !== undefined && updatedAt !== createdAt ? { updatedAt } : {}),
    url: str(x.html_url) ?? '',
  };
}

const REVIEW_STATES: Record<string, PrReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** Reviews → PrItem. PENDING (not submitted yet) is dropped; reviews without text stay. */
export function mapReview(r: unknown): PrItem | null {
  const x = obj(r);
  const id = num(x.id);
  const state = REVIEW_STATES[str(x.state) ?? ''];
  if (id === undefined || !state) return null;
  return {
    key: `review:${id}`,
    kind: 'review',
    author: personOf(x.user),
    html: str(x.body_html) ?? '',
    createdAt: time(x.submitted_at) ?? 0,
    url: str(x.html_url) ?? '',
    reviewState: state,
  };
}

/** Review (line) comments → PrItem (without diff_hunk). */
export function mapReviewComment(c: unknown): PrItem | null {
  const x = obj(c);
  const id = num(x.id);
  if (id === undefined) return null;
  const createdAt = time(x.created_at) ?? 0;
  const updatedAt = time(x.updated_at);
  const path = str(x.path);
  const line = num(x.line) ?? num(x.original_line);
  const replyTo = num(x.in_reply_to_id);
  return {
    key: `review_comment:${id}`,
    kind: 'review_comment',
    author: personOf(x.user),
    html: str(x.body_html) ?? '',
    createdAt,
    ...(updatedAt !== undefined && updatedAt !== createdAt ? { updatedAt } : {}),
    url: str(x.html_url) ?? '',
    ...(path ? { path } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(replyTo !== undefined ? { replyTo: `review_comment:${replyTo}` } : {}),
  };
}

const chronological = (a: PrItem, b: PrItem) => a.createdAt - b.createdAt || a.key.localeCompare(b.key);

/** All entries in chronological order (oldest first). */
export function mapItems(comments: unknown[], reviews: unknown[], reviewComments: unknown[]): PrItem[] {
  const items: PrItem[] = [];
  for (const c of comments) {
    const item = mapIssueComment(c);
    if (item) items.push(item);
  }
  for (const r of reviews) {
    const item = mapReview(r);
    if (item) items.push(item);
  }
  for (const c of reviewComments) {
    const item = mapReviewComment(c);
    if (item) items.push(item);
  }
  return items.sort(chronological);
}

/**
 * Summary of each reviewer's latest decision: if anyone's latest review requested changes →
 * changes_requested; otherwise approved if anyone's latest review approved.
 * Comment-only reviews don't count; dismissed reviews cancel the decision.
 */
export function summarizeReviews(items: readonly PrItem[]): 'approved' | 'changes_requested' | undefined {
  const last = new Map<string, PrReviewState>();
  for (const item of [...items].sort(chronological)) {
    if (item.kind !== 'review' || !item.reviewState || item.reviewState === 'commented') continue;
    last.set(item.author.login, item.reviewState);
  }
  const states = [...last.values()];
  if (states.includes('changes_requested')) return 'changes_requested';
  if (states.includes('approved')) return 'approved';
  return undefined;
}

export function countComments(items: readonly PrItem[]): number {
  return items.filter((i) => i.kind === 'comment' || i.kind === 'review_comment').length;
}

// ---------------------------------------------------------------- Fetching a PR snapshot

export interface PrSnapshot {
  detail: Omit<PrDetail, 'fetchedAt' | 'error'>;
  /** chronological; at most PR_LIMITS.items (the newest) */
  items: PrItem[];
  summary: { comments: number; review?: 'approved' | 'changes_requested' };
  state: PrState;
  title: string;
  branch: string;
  url?: string;
  updatedAt?: number;
  mergedAt?: number;
  /** parts that could not be fetched (e.g. checks without permission); the rest is current */
  warnings: string[];
}

/** Limits that keep a document under 1 MB and a call under the Convex limits (UTF-8 bytes). */
export const PR_LIMITS = {
  bodyBytes: 300_000,
  itemBytes: 150_000,
  /** all entries of a PR combined */
  itemsTotalBytes: 3_000_000,
  items: 300,
  checks: 150,
};

const CHECK_RANK: Record<PrCheckState, number> = { failure: 0, pending: 1, cancelled: 2, success: 3, neutral: 3, skipped: 4 };

/** At most `max` checks; failed and running ones are kept first. Original order is preserved. */
export function capChecks(checks: PrCheck[], max = PR_LIMITS.checks): PrCheck[] {
  if (checks.length <= max) return checks;
  const keep = new Set([...checks].sort((a, b) => CHECK_RANK[a.state] - CHECK_RANK[b.state]).slice(0, max));
  return checks.filter((c) => keep.has(c));
}

const CALLS = {
  pull: { what: 'Read pull request', permission: 'Pull requests' },
  repo: { what: 'Read repo', permission: 'Metadata', notFound: 'The repo is not granted to the token.' },
  issueComments: { what: 'Read comments', permission: 'Pull requests' },
  reviews: { what: 'Read reviews', permission: 'Pull requests' },
  reviewComments: { what: 'Read review comments', permission: 'Pull requests' },
  checkRuns: { what: 'Read checks', permission: 'Checks', notFound: 'Commit not found.' },
  actions: { what: 'Read GitHub Actions', permission: 'Actions', notFound: 'Commit not found.' },
  statuses: { what: 'Read commit statuses', permission: 'Commit statuses', notFound: 'Commit not found.' },
  branch: { what: 'Check branch', permission: 'Contents' },
  merge: { what: 'Merge', permission: 'Contents', write: true },
  deleteBranch: { what: 'Delete branch', permission: 'Contents', write: true, notFound: 'The branch no longer exists.' },
  setState: { what: 'Update pull request', permission: 'Pull requests', write: true },
  comment: { what: 'Comment', permission: 'Issues or Pull requests', write: true },
  contents: { what: 'Read file', permission: 'Contents', notFound: 'File not found.' },
  source: { what: 'Reload media', permission: 'Pull requests', notFound: 'Post not found.' },
  user: { what: 'Read account', permission: 'Metadata' },
  userRepos: { what: 'List repos', permission: 'Metadata' },
  hooks: { what: 'Read webhooks', permission: 'Webhooks' },
  hooksWrite: { what: 'Set up webhook', permission: 'Webhooks', write: true },
} satisfies Record<string, CallInfo>;

/** Errors that affect an optional part (checks, statuses, branch) and do not abort the fetch. */
const partial = (e: unknown) => e instanceof GithubApiError && (e.code === 'forbidden' || e.code === 'not_found');

async function headBranchDeletable(client: GithubClient, repo: string, pr: Json, repoInfo: Json): Promise<boolean> {
  const head = obj(pr.head);
  const ref = str(head.ref);
  const sameRepo = (str(obj(head.repo).full_name) ?? '').toLowerCase() === repo.toLowerCase();
  if (!ref || !sameRepo || ref === str(repoInfo.default_branch)) return false;
  if (pr.state === 'open') return true;
  // Merged or closed: deletable only if the branch still exists and has not moved past the head commit.
  const branch = await client.request<Json>('GET', `${repoPath(repo)}/branches/${encodeRef(ref)}`, CALLS.branch, {
    okStatuses: [404],
  });
  if (branch.status === 404) return false;
  return str(obj(obj(branch.data).commit).sha) === str(head.sha);
}

/** at most this many workflow runs per commit whose jobs are fetched */
const MAX_WORKFLOW_RUNS = 20;

/**
 * Jobs of the GitHub Actions runs for a commit, shaped like check runs (job ID = check run ID),
 * named "<Workflow> / <Job>". Needs the "Actions" permission (read); a fine-grained token cannot
 * read check runs themselves.
 */
async function actionJobs(client: GithubClient, base: string, sha: string): Promise<Json[]> {
  const runs = await client.list(`${base}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`, CALLS.actions, {
    key: 'workflow_runs',
    maxPages: 1,
  });
  const lists = await Promise.all(
    runs.slice(0, MAX_WORKFLOW_RUNS).map(async (run) => {
      const id = num(run.id);
      if (id === undefined) return [];
      const jobs = await client.list(`${base}/actions/runs/${id}/jobs`, CALLS.actions, { key: 'jobs', maxPages: 1 });
      const workflow = str(run.name);
      return jobs.map((job) => ({
        ...job,
        name: workflow ? `${workflow} / ${str(job.name) ?? ''}` : str(job.name),
        app: { name: 'GitHub Actions' },
      }));
    }),
  );
  return lists.flat();
}

/** Precedence when merging: completed beats running, otherwise the later end wins. */
function newerCheck(a: PrCheck, b: PrCheck): PrCheck {
  const doneA = a.state !== 'pending';
  const doneB = b.state !== 'pending';
  if (doneA !== doneB) return doneA ? a : b;
  return (b.completedAt ?? b.startedAt ?? 0) > (a.completedAt ?? a.startedAt ?? 0) ? b : a;
}

/**
 * Merges checks from the API with check runs from webhook deliveries (same `key`).
 * Name and app preferably come from the API ("<Workflow> / <Job>"); webhook runs whose name
 * an API check already carries count as an older run of the same check.
 */
export function mergeChecks(fromApi: readonly PrCheck[], fromWebhook: readonly PrCheck[]): PrCheck[] {
  const byKey = new Map<string, PrCheck>();
  for (const c of fromApi) byKey.set(c.key, c);
  for (const w of fromWebhook) {
    const a = byKey.get(w.key);
    if (!a) {
      byKey.set(w.key, w);
      continue;
    }
    const chosen = newerCheck(a, w);
    byKey.set(w.key, { ...chosen, name: a.name, ...(a.app ? { app: a.app } : {}) });
  }
  // only one per name (the newest), as in mapCheckRuns
  const byName = new Map<string, PrCheck>();
  for (const c of byKey.values()) {
    const id = `${c.source}:${c.name}`;
    const prev = byName.get(id);
    byName.set(id, prev ? newerByStart(prev, c) : c);
  }
  return [...byName.values()].sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'check' ? -1 : 1));
}

function newerByStart(a: PrCheck, b: PrCheck) {
  return (b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a;
}

/** Fetches everything for a PR: data, repo settings, comments, reviews, checks. */
export async function fetchPullRequest(client: GithubClient, repo: string, number: number): Promise<PrSnapshot> {
  const base = repoPath(repo);
  const n = prNumber(number);
  const [pull, repoInfo, comments, reviews, reviewComments] = await Promise.all([
    client.request<Json>('GET', `${base}/pulls/${n}`, CALLS.pull, { accept: ACCEPT_FULL }),
    client.request<Json>('GET', base, CALLS.repo),
    client.list(`${base}/issues/${n}/comments`, CALLS.issueComments, { accept: ACCEPT_FULL, newest: true }),
    client.list(`${base}/pulls/${n}/reviews`, CALLS.reviews, { accept: ACCEPT_FULL, newest: true }),
    client.list(`${base}/pulls/${n}/comments`, CALLS.reviewComments, { accept: ACCEPT_FULL, newest: true }),
  ]);
  const pr = obj(pull.data);
  const info = obj(repoInfo.data);
  const sha = str(obj(pr.head).sha);
  // warnings in a fixed order (Actions, statuses, branch), even though the calls run in parallel
  const slots: (string | undefined)[] = [];
  const optional = async <T>(slot: number, run: () => Promise<T>, fallback: T, quiet = false): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (!partial(e)) throw e;
      if (!quiet) slots[slot] = (e as GithubApiError).message;
      return fallback;
    }
  };
  const none: Json[] = [];
  const [jobs, runs, statuses, deletable] = await Promise.all([
    sha ? optional(0, () => actionJobs(client, base, sha), none) : Promise.resolve(none),
    // Fine-grained tokens always get 403 here (no "Checks" permission): skip silently.
    sha
      ? optional(1, () => client.list(`${base}/commits/${sha}/check-runs`, CALLS.checkRuns, { key: 'check_runs' }), none, true)
      : Promise.resolve(none),
    sha
      ? optional(
          2,
          async () => arr(obj((await client.request<Json>('GET', `${base}/commits/${sha}/status`, CALLS.statuses)).data).statuses),
          [] as unknown[],
        )
      : Promise.resolve([] as unknown[]),
    optional(3, () => headBranchDeletable(client, repo, pr, info), false),
  ]);
  const warnings = slots.filter((w): w is string => !!w);
  const jobIds = new Set(jobs.map((j) => num(j.id)));
  const checks = [...mapCheckRuns([...jobs, ...runs.filter((r) => !jobIds.has(num(r.id)))]), ...mapStatuses(statuses)];
  const all = mapItems(comments, reviews, reviewComments);
  const mergedAt = time(pr.merged_at);
  const updatedAt = time(pr.updated_at);
  const url = str(pr.html_url);
  const review = summarizeReviews(all);
  return {
    detail: mapPullRequest(pr, info, capChecks(checks), deletable),
    items: all.slice(-PR_LIMITS.items),
    summary: { comments: countComments(all), ...(review ? { review } : {}) },
    state: prStateOf(pr),
    title: str(pr.title) ?? '',
    branch: str(obj(pr.head).ref) ?? '',
    ...(url ? { url } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(mergedAt !== undefined ? { mergedAt } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------- Actions

export async function mergePullRequest(
  client: GithubClient,
  repo: string,
  number: number,
  method: MergeMethod,
  sha?: string,
): Promise<{ merged: boolean; message?: string; sha?: string }> {
  const { data } = await client.request<Json>('PUT', `${repoPath(repo)}/pulls/${prNumber(number)}/merge`, CALLS.merge, {
    body: { merge_method: method, ...(sha ? { sha } : {}) },
  });
  const d = obj(data);
  const message = str(d.message);
  const mergedSha = str(d.sha);
  return { merged: d.merged === true, ...(message ? { message } : {}), ...(mergedSha ? { sha: mergedSha } : {}) };
}

export async function deleteBranch(client: GithubClient, repo: string, ref: string): Promise<void> {
  await client.request('DELETE', `${repoPath(repo)}/git/refs/heads/${encodeRef(ref)}`, CALLS.deleteBranch);
}

export async function setPullRequestState(client: GithubClient, repo: string, number: number, state: 'open' | 'closed') {
  await client.request('PATCH', `${repoPath(repo)}/pulls/${prNumber(number)}`, CALLS.setState, { body: { state } });
}

/** Comment on the PR (issue comment). Returns the new entry. */
export async function createComment(client: GithubClient, repo: string, number: number, body: string): Promise<PrItem | null> {
  const { data } = await client.request<Json>('POST', `${repoPath(repo)}/issues/${prNumber(number)}/comments`, CALLS.comment, {
    accept: ACCEPT_FULL,
    body: { body },
  });
  return mapIssueComment(data);
}

// ---------------------------------------------------------------- Media (for GET /ghmedia)

const DOWNLOAD_HOSTS = /^https:\/\/([a-z0-9-]+\.)*githubusercontent\.com\//i;

/**
 * Fresh, directly loadable URL of a repo file: Contents API → `download_url`
 * (with a short-lived token parameter for private repos). `rest` = segments after owner/name,
 * i.e. ref and path; refs containing "/" are ambiguous, so up to four splits are tried.
 */
export async function fileDownloadUrl(client: GithubClient, repo: string, rest: string[]): Promise<string | null> {
  const base = repoPath(repo);
  for (let split = 1; split <= Math.min(4, rest.length - 1); split++) {
    const ref = rest.slice(0, split).join('/');
    const path = rest.slice(split).join('/');
    const response = await client.request<Json>(
      'GET',
      `${base}/contents/${path}?ref=${encodeURIComponent(decodeSafe(ref))}`,
      CALLS.contents,
      { okStatuses: [404] },
    );
    if (response.status === 404) continue;
    const url = str(obj(response.data).download_url);
    return url && DOWNLOAD_HOSTS.test(url) ? url : null;
  }
  return null;
}

/**
 * Re-fetches the HTML of a post (for fresh signed URLs of uploaded attachments):
 * `source` = 'body' (description) or an item key ("comment:<id>", "review:<id>", "review_comment:<id>").
 */
export async function sourceHtml(client: GithubClient, repo: string, number: number, source: string): Promise<string | null> {
  const base = repoPath(repo);
  const n = prNumber(number);
  const m = /^(comment|review|review_comment):(\d{1,20})$/.exec(source);
  const path =
    source === 'body'
      ? `${base}/pulls/${n}`
      : m?.[1] === 'comment'
        ? `${base}/issues/comments/${m[2]}`
        : m?.[1] === 'review'
          ? `${base}/pulls/${n}/reviews/${m[2]}`
          : m?.[1] === 'review_comment'
            ? `${base}/pulls/comments/${m[2]}`
            : null;
  if (!path) return null;
  const response = await client.request<Json>('GET', path, CALLS.source, { accept: ACCEPT_FULL, okStatuses: [404] });
  if (response.status === 404) return null;
  return str(obj(response.data).body_html) ?? null;
}

function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------- Webhooks in all repos

/** Events Selfbound processes (docs/operations.md). */
export const WEBHOOK_EVENTS = [
  'pull_request',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'check_run',
  'check_suite',
  'status',
  'workflow_run',
] as const;

export type HookState = 'ok' | 'created' | 'updated' | 'missing' | 'outdated' | 'error';

export interface RepoHook {
  repo: string;
  /** ok: present and matching · created/updated: just created or events updated ·
   *  missing/outdated: absent or different events, but writing is not allowed (local, no secret) · error */
  hook: HookState;
  error?: string;
}

export interface WebhookReport {
  login?: string;
  repos: RepoHook[];
  error?: string;
}

const MAX_REPOS = 300;

/**
 * Filter for webhook management (env GITHUB_REPOS, comma-separated): "owner/name" or "owner/*",
 * case-insensitive. Empty or unset: all repos.
 */
export function repoAllowed(repo: string, patterns?: string[]): boolean {
  const list = (patterns ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const name = repo.toLowerCase();
  const owner = name.split('/')[0];
  return list.some((p) => p === name || (p.endsWith('/*') && p.slice(0, -2) === owner));
}

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Checks in every repo the token can access (not archived) whether a webhook points to one of
 * the `urls`; creates missing ones (with the first URL) or updates their events when `write`
 * (and a secret) is allowed.
 * If the token lacks the "Webhooks" permission, the check stops at the first repo with a clear message.
 */
export async function ensureRepoWebhooks(
  client: GithubClient,
  opts: { urls: string[]; secret?: string; write: boolean; repos?: string[] },
): Promise<WebhookReport> {
  const user = await client.request<Json>('GET', '/user', CALLS.user);
  const login = str(obj(user.data).login);
  const all = await client.list('/user/repos?affiliation=owner&per_page=100&sort=full_name', CALLS.userRepos, {
    maxPages: Math.ceil(MAX_REPOS / 100),
  });
  const names = all
    .filter((r) => r.archived !== true && r.disabled !== true)
    .map((r) => str(r.full_name))
    .filter((n): n is string => !!n && REPO_RE.test(n) && repoAllowed(n, opts.repos));
  const targets = new Set(opts.urls.filter(Boolean).map(normalizeUrl));
  const createUrl = opts.urls.find(Boolean);
  if (!createUrl) throw new GithubApiError(0, 'invalid', 'Webhook URL unknown (CONVEX_SITE_URL).');
  const write = opts.write && !!opts.secret;
  const wanted = [...WEBHOOK_EVENTS].sort();
  const repos: RepoHook[] = [];
  let blocked: string | undefined;
  for (const repo of names) {
    if (blocked) {
      repos.push({ repo, hook: 'error', error: blocked });
      continue;
    }
    try {
      const hooks = await client.list(`${repoPath(repo)}/hooks`, CALLS.hooks, { maxPages: 1 });
      const hook = hooks.find((h) => targets.has(normalizeUrl(str(obj(h.config).url) ?? '')));
      if (hook) {
        const events = arr(hook.events).filter((e): e is string => typeof e === 'string').sort();
        const same = hook.active === true && events.length === wanted.length && events.every((e, i) => e === wanted[i]);
        if (same) repos.push({ repo, hook: 'ok' });
        else if (!write) repos.push({ repo, hook: 'outdated' });
        else {
          await client.request('PATCH', `${repoPath(repo)}/hooks/${num(hook.id)}`, CALLS.hooksWrite, {
            body: { events: WEBHOOK_EVENTS, active: true },
          });
          repos.push({ repo, hook: 'updated' });
        }
      } else if (!write) {
        repos.push({ repo, hook: 'missing' });
      } else {
        await client.request('POST', `${repoPath(repo)}/hooks`, CALLS.hooksWrite, {
          body: {
            name: 'web',
            active: true,
            events: WEBHOOK_EVENTS,
            config: { url: createUrl, content_type: 'json', secret: opts.secret, insecure_ssl: '0' },
          },
        });
        repos.push({ repo, hook: 'created' });
      }
    } catch (e) {
      if (!(e instanceof GithubApiError)) throw e;
      if (e.code === 'unauthorized' || e.code === 'rate_limited') throw e;
      // A missing permission is missing for all of the token's repos: don't ask 30 times.
      if (e.code === 'forbidden') blocked = e.message;
      repos.push({ repo, hook: 'error', error: e.message });
    }
  }
  return {
    ...(login ? { login } : {}),
    repos,
    ...(blocked ? { error: 'The token lacks the "Webhooks" permission (read and write).' } : {}),
  };
}
