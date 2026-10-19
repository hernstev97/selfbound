// Pull requests in Selfbound: types shared by backend and UI.
// Runs in the backend and in the browser. Import nothing from Convex.
//
// A PR's state comes from two sources:
// - `pullRequests` (webhook `pull_request`): title, state, branch. Always present, even without a token.
// - Fetched from the GitHub API with the instance token (`GITHUB_TOKEN`): description as HTML,
//   checks, comments, reviews, mergeability. Stored in `pullRequestDetails` and
//   `pullRequestItems`, refreshed on open and after webhook deliveries.

export type PrState = 'open' | 'closed' | 'merged' | 'draft';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** Result of a check (check run or commit status), reduced to a few values. */
export type PrCheckState = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'cancelled';

export interface PrCheck {
  /** stable per check: "check:<id>" or "status:<context>" */
  key: string;
  name: string;
  source: 'check' | 'status';
  /** app or service, e.g. "GitHub Actions", "Vercel" */
  app?: string;
  state: PrCheckState;
  /** link to the log or the service's detail page */
  url?: string;
  /** short description (check run title or status description) */
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PrPerson {
  login: string;
  avatarUrl?: string;
  bot: boolean;
  url?: string;
}

export interface PrLabel {
  name: string;
  /** hex without #, as GitHub sends it */
  color: string;
}

/** Mergeability from GitHub (`mergeable_state`), reduced to what the UI shows. */
export type PrMergeState =
  | 'clean' // mergeable
  | 'dirty' // conflicts
  | 'blocked' // rules (reviews, required checks) prevent merging
  | 'behind' // branch behind the base (only blocks with an "up to date" rule)
  | 'unstable' // mergeable, but checks not green
  | 'draft'
  | 'unknown'; // GitHub is still computing (mergeable = null)

export interface PrDetail {
  fetchedAt: number;
  /** error of the last fetch (text for the UI); the other fields are then from the fetch before */
  error?: string;
  /** description as HTML from GitHub (`body_html`), media from private repos already rewritten. Passed through DOMPurify in the browser. */
  bodyHtml: string;
  author: PrPerson;
  createdAt: number;
  closedAt?: number;
  mergedBy?: PrPerson;
  baseRef: string;
  headRef: string;
  /** "owner/name" of the head repo; differs from the PR repo for forks */
  headRepo?: string;
  headSha: string;
  draft: boolean;
  mergeState: PrMergeState;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  labels: PrLabel[];
  requestedReviewers: PrPerson[];
  checks: PrCheck[];
  /** merge methods the repo allows, in GitHub's order (merge, squash, rebase) */
  mergeMethods: MergeMethod[];
  /** the repo deletes the branch after merging by itself */
  deleteBranchOnMerge: boolean;
  /** head branch is in the same repo and still exists (so it can be deleted) */
  headBranchDeletable: boolean;
}

export type PrItemKind = 'comment' | 'review' | 'review_comment';
export type PrReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface PrItem {
  /** stable: "<kind>:<GitHub ID>" */
  key: string;
  kind: PrItemKind;
  author: PrPerson;
  /** HTML from GitHub (`body_html`), through DOMPurify in the browser; empty for reviews without text */
  html: string;
  createdAt: number;
  updatedAt?: number;
  url: string;
  reviewState?: PrReviewState;
  /** comment on a line of code */
  path?: string;
  line?: number;
  /** reply to another line comment ("review_comment:<id>") */
  replyTo?: string;
}

/** Result of `githubPr.view`. */
export interface PrView {
  pr: {
    id: string;
    repo: string;
    number: number;
    title: string;
    url: string;
    state: PrState;
    branch: string;
    author?: string;
    updatedAt: number;
    mergedAt?: number;
  };
  /** null: never fetched (or no token) */
  detail: PrDetail | null;
  /** chronological, oldest first */
  items: PrItem[];
  /** GITHUB_TOKEN set: fetching and actions are possible */
  configured: boolean;
  /** error of the last fetch, even if there is no state yet (`detail` null); otherwise equal to `detail.error` */
  error?: string;
}

/** Summary per PR for the list on the issue (`githubPr.summaries`). */
export interface PrSummary {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  branch: string;
  author?: string;
  updatedAt: number;
  mergeState?: PrMergeState;
  checks?: { total: number; failed: number; pending: number };
  /** latest review decision per reviewer, combined */
  review?: 'approved' | 'changes_requested';
  comments?: number;
  fetchedAt?: number;
}

/** A repo's webhook (`githubPr.connection`). */
export interface GithubRepoHook {
  repo: string;
  /**
   * ok: present and matching · created/updated: created or events set during the last check ·
   * missing/outdated: missing or other events, but writing is not allowed (management off, local
   * backend, no GITHUB_WEBHOOK_SECRET) · error: check failed (`error`)
   */
  hook: 'ok' | 'created' | 'updated' | 'missing' | 'outdated' | 'error';
  error?: string;
}

/** GitHub connection for the settings (`githubPr.connection`, `githubPr.ensureWebhooks`). */
export interface GithubConnection {
  /** GITHUB_TOKEN set */
  configured: boolean;
  /** account of the token */
  login?: string;
  /** last webhook check (daily and on demand) */
  checkedAt?: number;
  repos: GithubRepoHook[];
  error?: string;
  /** local backend: webhooks are only checked, never created */
  local: boolean;
  /** webhook management explicitly turned on (GITHUB_MANAGE_WEBHOOKS=1) */
  manage: boolean;
  /** webhooks may be created/changed: `manage`, not local and GITHUB_WEBHOOK_SECRET set */
  canWrite: boolean;
}

/** Check counts (for the summary and the view header). */
export function checkCounts(checks: readonly PrCheck[]) {
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.state === 'failure') failed++;
    else if (c.state === 'pending') pending++;
  }
  return { total: checks.length, failed, pending };
}

// ---------------------------------------------------------------- Pull requests page (SELF-100)

/**
 * Group of a PR on the pull requests page, by what comes next. In display order:
 * ready · checks failing · checks running · blocked (open, checks fine, but something else stops the
 * merge) · draft · done (merged or closed in the last DONE_WINDOW_MS).
 */
export type PrGroup = 'ready' | 'failing' | 'running' | 'blocked' | 'draft' | 'done';
export const PR_GROUPS: readonly PrGroup[] = ['ready', 'failing', 'running', 'blocked', 'draft', 'done'];

/** Why an open PR with fine checks is not ready. `unknown`: no state from GitHub yet. */
export type PrBlocker = 'conflicts' | 'changes_requested' | 'rules' | 'unknown';

/** Merged and closed PRs stay on the page this long (by `updatedAt`). */
export const DONE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The part of a PR's fetched state the grouping reads (table pullRequestStatus). */
export interface PrStatus {
  draft: boolean;
  mergeState: PrMergeState;
  /** listCheckCounts: a canceled check counts as failed */
  checks: { total: number; failed: number; pending: number };
  /** latest review decision per reviewer, combined */
  review?: 'approved' | 'changes_requested';
}

/** What the grouping reads: the stored state and the fetched status (null = never fetched). */
export interface PrGroupInput {
  state: PrState;
  status: PrStatus | null;
}

/**
 * Check counts for the page: a canceled check counts as failed, because the PR needs a new run
 * before it can be merged (the fetch keeps only the newest run per name).
 */
export function listCheckCounts(checks: readonly PrCheck[]) {
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.state === 'failure' || c.state === 'cancelled') failed++;
    else if (c.state === 'pending') pending++;
  }
  return { total: checks.length, failed, pending };
}

/** The status of a fetched state (pullRequestDetails `data` and `summary.review`). */
export function prStatusOf(detail: Pick<PrDetail, 'draft' | 'mergeState' | 'checks'>, review?: 'approved' | 'changes_requested'): PrStatus {
  return { draft: detail.draft, mergeState: detail.mergeState, checks: listCheckCounts(detail.checks), ...(review ? { review } : {}) };
}

export function sameStatus(a: PrStatus, b: PrStatus) {
  return (
    a.draft === b.draft &&
    a.mergeState === b.mergeState &&
    a.checks.total === b.checks.total &&
    a.checks.failed === b.checks.failed &&
    a.checks.pending === b.checks.pending &&
    a.review === b.review
  );
}

/** Reasons why an open, non-draft PR cannot be merged yet (empty: nothing in the way). Same rules as the merge button in the PR view. */
export function prBlockers(input: PrGroupInput): PrBlocker[] {
  const status = input.status;
  if (!status) return ['unknown'];
  const out: PrBlocker[] = [];
  if (status.mergeState === 'dirty') out.push('conflicts');
  if (status.review === 'changes_requested') out.push('changes_requested');
  if (status.mergeState === 'blocked') out.push('rules');
  return out;
}

/**
 * The group of a PR. Drafts stay drafts whatever their checks say (work in progress, nothing to
 * merge); for the others failing checks come before running ones, and only a PR with all checks
 * successful, neutral or skipped, no requested changes and no conflicts or rules in the way is ready.
 */
export function prGroup(input: PrGroupInput): PrGroup {
  const status = input.status;
  if (input.state === 'merged' || input.state === 'closed') return 'done';
  if (input.state === 'draft' || status?.draft || status?.mergeState === 'draft') return 'draft';
  if (status?.checks.failed) return 'failing';
  if (status?.checks.pending) return 'running';
  return prBlockers(input).length ? 'blocked' : 'ready';
}

/** A row of the pull requests page (`githubPr.list`). */
export interface PrListItem {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  updatedAt: number;
  group: PrGroup;
  /** IDs of the linked issues (at least one); the app shows them from its own store */
  issueIds: string[];
  /** missing until the first fetch */
  checks?: { total: number; failed: number; pending: number };
  blockers?: PrBlocker[];
  review?: 'approved' | 'changes_requested';
}

/** Result of `githubPr.list`: rows sorted by group (PR_GROUPS), then newest change first. */
export interface PrList {
  items: PrListItem[];
  /** GITHUB_TOKEN set: refreshing is possible */
  configured: boolean;
}

/** Result of `githubPr.attention`: the sidebar count is ready + failing. */
export interface PrAttention {
  ready: number;
  failing: number;
}

/** Path of the full view: /pr/<owner>/<name>/<number> */
export function prPath(repo: string, number: number) {
  return `/pr/${repo}/${number}`;
}
