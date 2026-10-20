import type { PrState } from '../shared/pullRequests';
import { MAGIC_RE, SEP_RE, stripCode } from './github';
import { GITHUB_API, prStateOf, repoPath } from './githubApi';

// Import from GitHub Issues: GitHub REST responses → the compact form the import mutation takes.
// Pure (no database, no network); the action in githubImport.ts fetches, ops/githubImport.ts writes.

/** How an issue was left on GitHub. `open`, or the `state_reason` of a closed issue. */
export type GhState = 'open' | 'completed' | 'not_planned' | 'duplicate';

export interface GhLabel {
  name: string;
  /** "d73a4a", without "#" */
  color?: string;
}

export interface GhIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: GhState;
  labels: GhLabel[];
  author: string;
  url: string;
  createdAt: number;
  closedAt?: number;
}

export interface GhComment {
  /** GitHub's comment ID (unique across repos) */
  id: string;
  repo: string;
  /** issue (or PR) number the comment belongs to */
  number: number;
  body: string;
  author: string;
  createdAt: number;
  updatedAt: number;
}

export interface GhRef {
  repo: string;
  number: number;
}

export interface GhPull {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  branch: string;
  author: string;
  updatedAt: number;
  mergedAt?: number;
  /** issues the PR closes by keyword ("Fixes #12"), in its title or description */
  closes: GhRef[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const time = (v: unknown) => {
  const t = Date.parse(str(v) ?? '');
  return Number.isFinite(t) ? t : undefined;
};
const login = (user: unknown) => str(obj(user).login) ?? 'ghost';
const positive = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined);

export function stateOf(issue: Json): GhState {
  if (issue.state !== 'closed') return 'open';
  const reason = str(issue.state_reason);
  return reason === 'not_planned' || reason === 'duplicate' ? reason : 'completed';
}

/** One entry of `GET /repos/{repo}/issues`. Pull requests (the endpoint lists them too) give null. */
export function mapIssue(repo: string, raw: unknown): GhIssue | null {
  const i = obj(raw);
  const number = positive(i.number);
  if (!number || 'pull_request' in i) return null;
  const labels: GhLabel[] = [];
  for (const l of Array.isArray(i.labels) ? i.labels : []) {
    // Labels come as objects, in older payloads also as plain names.
    const name = (typeof l === 'string' ? l : str(obj(l).name))?.trim();
    if (!name || labels.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const color = str(obj(l).color);
    labels.push({ name, ...(color && /^[0-9a-f]{6}$/i.test(color) ? { color: color.toLowerCase() } : {}) });
  }
  const state = stateOf(i);
  const closedAt = state === 'open' ? undefined : time(i.closed_at);
  return {
    repo,
    number,
    title: str(i.title) ?? '',
    body: str(i.body) ?? '',
    state,
    labels,
    author: login(i.user),
    url: str(i.html_url) ?? `https://github.com/${repo}/issues/${number}`,
    createdAt: time(i.created_at) ?? 0,
    ...(closedAt !== undefined ? { closedAt } : {}),
  };
}

/** One entry of `GET /repos/{repo}/issues/comments` (comments on issues and PRs). */
export function mapComment(repo: string, raw: unknown): GhComment | null {
  const c = obj(raw);
  const id = positive(c.id);
  const number = Number(/\/issues\/(\d+)$/.exec(str(c.issue_url) ?? '')?.[1]);
  if (!id || !Number.isSafeInteger(number) || number <= 0) return null;
  const createdAt = time(c.created_at) ?? 0;
  return {
    id: String(id),
    repo,
    number,
    body: str(c.body) ?? '',
    author: login(c.user),
    createdAt,
    updatedAt: time(c.updated_at) ?? createdAt,
  };
}

/** One entry of `GET /repos/{repo}/pulls`. */
export function mapPull(repo: string, raw: unknown): GhPull | null {
  const p = obj(raw);
  const number = positive(p.number);
  if (!number) return null;
  const title = str(p.title) ?? '';
  const closes = closingRefs(`${title}\n${str(p.body) ?? ''}`, repo);
  const mergedAt = time(p.merged_at);
  return {
    repo,
    number,
    title,
    url: str(p.html_url) ?? `https://github.com/${repo}/pull/${number}`,
    state: prStateOf(p),
    branch: str(obj(p.head).ref) ?? '',
    author: login(p.user),
    updatedAt: time(p.updated_at) ?? time(p.created_at) ?? 0,
    ...(mergedAt !== undefined ? { mergedAt } : {}),
    closes,
  };
}

// A referenced issue: "#12", "owner/repo#12" or its URL.
const REF_RE = /(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)|(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+))(?![A-Za-z0-9_])/y;

/**
 * Issues a PR closes by keyword, as GitHub reads them: "Fixes #12", "closes acme/app#3",
 * "resolves https://github.com/acme/app/issues/4", also lists ("Fixes #1, #2"). Code does not count.
 * `repo`: the PR's repo, for plain "#12".
 */
export function closingRefs(text: string, repo: string): GhRef[] {
  const clean = stripCode(text);
  const found = new Map<string, GhRef>();
  for (const magic of clean.matchAll(MAGIC_RE)) {
    let pos = magic.index + magic[0].length;
    for (;;) {
      REF_RE.lastIndex = pos;
      const m = REF_RE.exec(clean);
      if (!m) break;
      const target = (m[1] ?? m[3] ?? repo).toLowerCase() === repo.toLowerCase() ? repo : (m[1] ?? m[3])!;
      const number = Number(m[2] ?? m[4]);
      if (Number.isSafeInteger(number) && number > 0) found.set(`${target.toLowerCase()}#${number}`, { repo: target, number });
      pos = REF_RE.lastIndex;
      SEP_RE.lastIndex = pos;
      const sep = SEP_RE.exec(clean);
      if (!sep || sep[0].length === 0) break;
      pos = SEP_RE.lastIndex;
    }
  }
  return [...found.values()];
}

/** Author of an imported comment, like "Jane Doe (Linear)" for the Linear import. */
export const authorName = (login: string) => `${login} (GitHub)`;

/** Key of an imported issue in `linearLinks` (repo names are case-insensitive on GitHub). */
export const issueKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** Description of an imported issue: GitHub's text, then a line with the original and its author. */
export function issueMarkdown(issue: Pick<GhIssue, 'repo' | 'number' | 'body' | 'author' | 'url'>): string {
  const origin = `Imported from [${issue.repo}#${issue.number}](${issue.url}) on GitHub, opened by ${issue.author}.`;
  const body = issue.body.trim();
  return body ? `${body}\n\n---\n\n${origin}` : origin;
}

// ---------------------------------------------------------------- Run position

/** Order of a run: all issues first, so PRs and comments find issues of every repo. */
export const PHASES = ['issues', 'pulls', 'comments'] as const;
export type GithubPhase = (typeof PHASES)[number];

export interface GithubCursor {
  teamId: string;
  repos: string[];
  phase: GithubPhase;
  /** index into `repos` */
  repo: number;
  /** next page (path below api.github.com); null = first page */
  path: string | null;
  /** failed attempts at this page (GitHub unavailable) */
  attempt: number;
}

/** Issues come in pages of 50 (texts up to 65,536 characters each), the rest in pages of 100. */
export function firstPath(phase: GithubPhase, repo: string): string {
  const base = repoPath(repo);
  switch (phase) {
    case 'issues':
      return `${base}/issues?state=all&sort=created&direction=asc&per_page=50`;
    case 'pulls':
      return `${base}/pulls?state=all&sort=created&direction=asc&per_page=100`;
    case 'comments':
      return `${base}/issues/comments?sort=created&direction=asc&per_page=100`;
  }
}

/** Path of a `next` link (relLink only returns api.github.com addresses). */
export const pathOf = (url: string) => (url.startsWith(`${GITHUB_API}/`) ? url.slice(GITHUB_API.length) : null);

/** The cursor after the current page: next page, next repo or next phase; null = done. */
export function advanceCursor(c: GithubCursor, next: string | null): GithubCursor | null {
  if (next) return { ...c, path: next, attempt: 0 };
  if (c.repo + 1 < c.repos.length) return { ...c, repo: c.repo + 1, path: null, attempt: 0 };
  const i = PHASES.indexOf(c.phase);
  if (i + 1 < PHASES.length) return { ...c, phase: PHASES[i + 1]!, repo: 0, path: null, attempt: 0 };
  return null;
}
