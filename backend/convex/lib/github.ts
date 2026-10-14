// Evaluate GitHub webhooks without database access.
//
// This module is pure: it verifies the signature, reads identifiers from the
// branch, title and body, and condenses a `pull_request` event into a summary.
// What of it goes into the database (delivery id, PR, links, issue to done) is
// decided by the webhook's internal mutation.
//
// Rule:
// - `closes = true` if a magic word precedes the identifier (title or body)
//   OR the identifier is in the branch name.
// - Identifier only in title or body, without a magic word: link, don't close.
// - Links are never removed automatically (enforced by the mutation).

/** Known identifiers: team keys ("KIU") and old identifiers ("OLD-12"). */
export interface KnownKeys {
  teams: Iterable<string>;
  aliases?: Iterable<string>;
}

export type PullRequestState = 'open' | 'closed' | 'merged' | 'draft';
export type LinkVia = 'branch' | 'title' | 'body';

export interface PullRequestLink {
  identifier: string; // upper case, "KIU-106"
  via: LinkVia; // first match in the order branch, title, body
  closes: boolean;
}

export interface PullRequestAnalysis {
  kind: 'pull_request';
  action: string;
  repo: string; // "owner/name"
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  branch: string;
  author?: string;
  updatedAt?: number;
  mergedAt?: number;
  /** true exactly for `closed` with `merged: true`: now mark the `closes` issues done. */
  merged: boolean;
  links: PullRequestLink[];
}

export type GithubEventAnalysis =
  | PullRequestAnalysis
  | { kind: 'ping'; hookId?: number; zen?: string }
  | { kind: 'ignored'; reason: string };

// ---------------------------------------------------------------------------
// Signature

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verifies `X-Hub-Signature-256` ("sha256=<hex>") over the raw body text.
 *
 * The comparison goes through `crypto.subtle.verify`, i.e. constant time in the
 * runtime rather than a string comparison. A missing secret or header, or a
 * malformed header, yields `false`.
 */
export async function verifySignature(
  secret: string,
  rawBody: string | Uint8Array<ArrayBuffer>,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;
  const signature = hexToBytes(match[1]!);
  if (!signature) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const data = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  return crypto.subtle.verify('HMAC', key, signature, data);
}

/** Creates a signature (for tests and test deliveries). */
export async function signBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Identifiers

interface Matcher {
  /** Returns the normalized identifier, or null if it is unknown. */
  accept(key: string, number: string): string | null;
}

function matcherOf(known: KnownKeys): Matcher {
  const teams = new Set<string>();
  for (const t of known.teams) teams.add(t.toUpperCase());
  const aliases = new Set<string>();
  for (const a of known.aliases ?? []) aliases.add(a.toUpperCase());
  return {
    accept(key, number) {
      const n = Number(number);
      if (!Number.isSafeInteger(n) || n <= 0) return null;
      const identifier = `${key.toUpperCase()}-${n}`;
      if (teams.has(key.toUpperCase()) || aliases.has(identifier)) return identifier;
      return null;
    },
  };
}

// Identifier with boundaries: no letter/digit before, no digit or letter after
// ("KIU-106-slug" and "KIU-106." count, "KIU-106a" does not).
const ID_CORE = '([A-Za-z][A-Za-z0-9]{1,5})-(\\d{1,6})(?![A-Za-z0-9])';
const ID_SOURCE = `(?<![A-Za-z0-9])${ID_CORE}`;

function collect(text: string, matcher: Matcher): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(ID_SOURCE, 'g'))) {
    const id = matcher.accept(m[1]!, m[2]!);
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * Identifiers in the branch name, e.g. "octocat/kiu-106-title-slug",
 * "kiu-106", "feature/KIU-106-x". Only known team keys and aliases.
 */
export function branchIdentifiers(branch: string, knownKeys: KnownKeys): string[] {
  // Suggested branch names have the form "kiu-106-…": key, hyphen, number.
  return collect(branch, matcherOf(knownKeys));
}

/**
 * Removes places where identifiers don't count: code blocks (``` and ~~~, an
 * unclosed fence runs to the end of the text), inline code (`…`, ``…``) and
 * HTML comments (e.g. placeholders from PR templates).
 */
export function stripCode(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, ' ');
}

/** All known identifiers in a text (title or PR description), excluding code. */
export function textIdentifiers(text: string | null | undefined, knownKeys: KnownKeys): string[] {
  if (!text) return [];
  return collect(stripCode(text), matcherOf(knownKeys));
}

// Magic words as on GitHub, case-insensitive, optionally followed by a colon.
const MAGIC_RE = /(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![A-Za-z0-9])[ \t]*:?[ \t]*/gi;
// A list item: identifier or a Linear link to the issue.
const ITEM_RE = new RegExp(`(?:https?://linear\\.app/[A-Za-z0-9_-]+/issue/)?${ID_CORE}(?:/[A-Za-z0-9_-]*)?`, 'y');
// List separators: ", ", " and ", ", and ", " & ".
const SEP_RE = /[ \t]*(?:,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+|[ \t]*&[ \t]*)/iy;

/**
 * Identifiers to close via magic word: "Fixes KIU-1", "closes: kiu-2", also
 * lists like "Fixes KIU-1, KIU-2 and KIU-3". Code does not count.
 */
export function closingIdentifiers(text: string | null | undefined, knownKeys: KnownKeys): string[] {
  if (!text) return [];
  const clean = stripCode(text);
  const matcher = matcherOf(knownKeys);
  const found = new Set<string>();
  for (const magic of clean.matchAll(MAGIC_RE)) {
    let pos = magic.index! + magic[0].length;
    for (;;) {
      ITEM_RE.lastIndex = pos;
      const item = ITEM_RE.exec(clean);
      if (!item) break;
      const id = matcher.accept(item[1]!, item[2]!);
      if (id) found.add(id);
      pos = ITEM_RE.lastIndex;
      SEP_RE.lastIndex = pos;
      const sep = SEP_RE.exec(clean);
      if (!sep || sep[0].length === 0) break;
      pos = SEP_RE.lastIndex;
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Events

/** Actions that can change the PR or its links. */
const RELEVANT_ACTIONS = new Set(['opened', 'edited', 'reopened', 'ready_for_review', 'converted_to_draft', 'closed']);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const time = (v: unknown) => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Summarizes a delivery. `event` is the `X-GitHub-Event` header.
 *
 * - `ping` → `{kind: 'ping'}` (the webhook responds 200).
 * - `pull_request` with a relevant action → summary with links.
 * - everything else (including `synchronize`) → `{kind: 'ignored', reason}`.
 */
export function analyzePullRequestEvent(event: string, payload: unknown, knownKeys: KnownKeys): GithubEventAnalysis {
  if (event === 'ping') {
    const p = isObj(payload) ? payload : {};
    return { kind: 'ping', hookId: typeof p.hook_id === 'number' ? p.hook_id : undefined, zen: str(p.zen) };
  }
  if (event !== 'pull_request') return { kind: 'ignored', reason: `event ${event || '(empty)'} is not evaluated` };
  if (!isObj(payload)) return { kind: 'ignored', reason: 'payload is not an object' };
  const action = str(payload.action) ?? '';
  if (!RELEVANT_ACTIONS.has(action)) return { kind: 'ignored', reason: `action ${action || '(empty)'} is ignored` };
  const pr = payload.pull_request;
  const repository = payload.repository;
  if (!isObj(pr) || !isObj(repository)) return { kind: 'ignored', reason: 'pull_request or repository missing' };
  const number = typeof pr.number === 'number' ? pr.number : typeof payload.number === 'number' ? payload.number : NaN;
  const repo = str(repository.full_name);
  const head = isObj(pr.head) ? pr.head : {};
  const branch = str(head.ref) ?? '';
  if (!repo || !Number.isSafeInteger(number)) return { kind: 'ignored', reason: 'repo or number missing' };

  const merged = pr.merged === true || (str(pr.merged_at) !== undefined && pr.state === 'closed');
  const state: PullRequestState =
    pr.state === 'closed' ? (merged ? 'merged' : 'closed') : pr.draft === true ? 'draft' : 'open';
  const title = str(pr.title) ?? '';
  const body = str(pr.body) ?? '';

  const links = new Map<string, PullRequestLink>();
  const add = (ids: string[], via: LinkVia, closes: boolean) => {
    for (const identifier of ids) {
      const existing = links.get(identifier);
      if (existing) existing.closes ||= closes;
      else links.set(identifier, { identifier, via, closes });
    }
  };
  add(branchIdentifiers(branch, knownKeys), 'branch', true);
  const titleClosing = new Set(closingIdentifiers(title, knownKeys));
  const bodyClosing = new Set(closingIdentifiers(body, knownKeys));
  for (const id of textIdentifiers(title, knownKeys)) add([id], 'title', titleClosing.has(id) || bodyClosing.has(id));
  for (const id of textIdentifiers(body, knownKeys)) add([id], 'body', bodyClosing.has(id) || titleClosing.has(id));

  const user = isObj(pr.user) ? pr.user : {};
  return {
    kind: 'pull_request',
    action,
    repo,
    number,
    title,
    url: str(pr.html_url) ?? `https://github.com/${repo}/pull/${number}`,
    state,
    branch,
    author: str(user.login),
    updatedAt: time(pr.updated_at),
    mergedAt: merged ? time(pr.merged_at) : undefined,
    merged: action === 'closed' && merged,
    links: [...links.values()],
  };
}

// ---------------------------------------------------------------------------
// Triggering a refresh

/** Events after which a PR's state is fetched again from GitHub. */
export const REFRESH_EVENTS = new Set([
  'pull_request',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'check_run',
  'check_suite',
  'status',
  'workflow_run',
]);

export interface RefreshTargets {
  repo: string;
  /** PR numbers in the repo */
  numbers: number[];
  /** Head commits (for events without a PR number, e.g. `status`) */
  shas: string[];
  /** `pull_request`: the PR's current head commit */
  headSha?: string;
}

const MAX_TARGETS = 10;

/** PR numbers from `pull_requests[]` (check_run, check_suite, workflow_run), only PRs whose base is in this repo. */
function prNumbers(list: unknown, repo: string): number[] {
  const out: number[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!isObj(item) || typeof item.number !== 'number' || !Number.isSafeInteger(item.number)) continue;
    const base = isObj(item.base) ? item.base : {};
    const url = str(isObj(base.repo) ? base.repo.url : undefined);
    if (url && !url.toLowerCase().endsWith(`/repos/${repo.toLowerCase()}`)) continue;
    out.push(item.number);
  }
  return out;
}

/**
 * Which PRs does a delivery affect? null = event not related to a PR (not evaluated).
 * Whether the PR exists in Selfbound is checked by the mutation.
 */
export function refreshTargets(event: string, payload: unknown): RefreshTargets | null {
  if (!REFRESH_EVENTS.has(event) || !isObj(payload)) return null;
  const repo = str(isObj(payload.repository) ? payload.repository.full_name : undefined);
  if (!repo) return null;
  const numbers: number[] = [];
  const shas: string[] = [];
  let headSha: string | undefined;
  const numberOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
  switch (event) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'pull_request_review_thread': {
      const pr = isObj(payload.pull_request) ? payload.pull_request : {};
      const n = numberOf(pr.number) ?? numberOf(payload.number);
      if (n !== undefined) numbers.push(n);
      if (event === 'pull_request') headSha = str(isObj(pr.head) ? pr.head.sha : undefined);
      break;
    }
    case 'issue_comment': {
      const issue = isObj(payload.issue) ? payload.issue : {};
      // Comments on issues (without pull_request) don't concern a PR.
      if (!isObj(issue.pull_request)) return null;
      const n = numberOf(issue.number);
      if (n !== undefined) numbers.push(n);
      break;
    }
    case 'check_run':
    case 'check_suite':
    case 'workflow_run': {
      const x = isObj(payload[event]) ? (payload[event] as Record<string, unknown>) : {};
      numbers.push(...prNumbers(x.pull_requests, repo));
      const sha = str(x.head_sha);
      if (sha) shas.push(sha);
      break;
    }
    case 'status': {
      const sha = str(payload.sha);
      if (sha) shas.push(sha);
      break;
    }
  }
  if (numbers.length === 0 && shas.length === 0) return null;
  return { repo, numbers: [...new Set(numbers)].slice(0, MAX_TARGETS), shas: shas.slice(0, 1), ...(headSha ? { headSha } : {}) };
}

/** Reads the GitHub headers (case-insensitive). */
export function githubHeaders(headers: Headers | Record<string, string | undefined>) {
  const get = (name: string) =>
    headers instanceof Headers
      ? (headers.get(name) ?? undefined)
      : Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  return {
    event: get('x-github-event') ?? '',
    deliveryId: get('x-github-delivery') ?? '',
    signature: get('x-hub-signature-256'),
  };
}
