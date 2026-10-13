// Pull requests in XLR8: types shared by backend and UI.
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

/** Path of the full view: /pr/<owner>/<name>/<number> */
export function prPath(repo: string, number: number) {
  return `/pr/${repo}/${number}`;
}
