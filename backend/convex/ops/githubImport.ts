import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { SEQ, takeCounter, teamCounter } from '../lib/counters';
import { invalid } from '../lib/errors';
import { hashText } from '../lib/equal';
import { repoPath } from '../lib/githubApi';
import {
  advanceCursor,
  authorName,
  firstPath,
  issueKey,
  issueMarkdown,
  type GhComment,
  type GhIssue,
  type GhPull,
  type GhState,
  type GithubCursor,
  GITHUB_ISSUE,
} from '../lib/githubIssues';
import { teamByKey } from '../lib/identifiers';
import { lastRank, rankBetween } from '../lib/rank';
import { ensureTeamStates, stateFields, workflowOf, type State as WorkflowState } from '../lib/workflow';
import { bucketOf, CLOSED_STATUSES, identifierOf, LIMITS, type Status } from '../shared/constants';
import { defaultState, stateForStatus, statusOfState } from '../shared/workflow';
import { insertBody } from './bodies';
import { syncFileRefs } from './files';
import { record } from './history';
import {
  clip,
  emptyCounts,
  failStaleImports,
  findLink,
  getLocal,
  hueOf,
  IMPORT,
  merge,
  mergeImportedBody,
  payloadHash,
  type Outcome,
  type StepCounts,
} from './import';
import { syncArticleLinks } from './links';
import { statusTimestamps } from './issues';
import { assertIssuesAllowed } from './validate';

// Import from GitHub Issues (docs/architecture/import.md, "Importing from GitHub").
//
// The action in githubImport.ts fetches one page from the GitHub REST API per step; the functions
// here write it. Same principles as the Linear import (ops/import.ts), on the same tables:
// - Repeatable without duplicates: `linearLinks` with kinds `githubIssue` (repo#number),
//   `githubComment` (GitHub's comment ID) and `githubPr` (PR → issue). Same payload hash →
//   untouched.
// - Three-way merge per field (title, status, labels, description) against the last imported
//   GitHub values (`base`): changed only on GitHub → take, only in Selfbound → keep, in both →
//   keep Selfbound's and note a conflict.
// - Unlike Linear, GitHub numbers are per repo, so issues get the team's next number.
// - Runs live in `importRuns` (one import at a time, Linear or GitHub); `cursor` holds the
//   position as JSON. Deviations hold only repo names, numbers and identifiers.

export const GITHUB_COMMENT = 'githubComment';
export const GITHUB_PR = 'githubPr';
export const RUN_PREFIX = 'github:';
export const MAX_REPOS = 20;

const readCursor = (run: Doc<'importRuns'>) => (run.cursor ? (JSON.parse(run.cursor) as GithubCursor) : null);

// ---------------------------------------------------------------- Start

/** Checks team and repos, creates the run. Throws if another import is running. */
export async function startGithubImport(ctx: MutationCtx, args: { team: string; repos: string[] }) {
  const team = await teamByKey(ctx, args.team.trim().toUpperCase());
  if (!team) invalid(`Team ${args.team} does not exist.`);
  assertIssuesAllowed(team);
  const repos: string[] = [];
  for (const raw of args.repos) {
    const repo = raw.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
    try {
      repoPath(repo);
    } catch {
      invalid(`"${raw.slice(0, 200)}" is not a repo name like "owner/name".`);
    }
    if (!repos.some((r) => r.toLowerCase() === repo.toLowerCase())) repos.push(repo);
  }
  if (repos.length === 0 || repos.length > MAX_REPOS) invalid(`Between 1 and ${MAX_REPOS} repos per run.`);
  const now = Date.now();
  await failStaleImports(ctx, now);
  const busy = await ctx.db
    .query('importRuns')
    .withIndex('by_status', (q) => q.eq('status', 'running'))
    .first();
  if (busy) invalid(`An import is already running (${busy.run}). Wait for it to finish first.`);
  const cursor: GithubCursor = { teamId: team._id, repos, phase: 'issues', repo: 0, path: null, attempt: 0 };
  return await ctx.db.insert('importRuns', {
    run: `${RUN_PREFIX}${new Date(now).toISOString()}`,
    startedAt: now,
    status: 'running',
    counts: {},
    deviations: [],
    phase: cursor.phase,
    cursor: JSON.stringify(cursor),
    heartbeatAt: now,
  });
}

/** What the next step fetches; null if the run is over. */
export async function githubPlan(ctx: QueryCtx, runId: Id<'importRuns'>) {
  const run = await ctx.db.get('importRuns', runId);
  if (!run || run.status !== 'running' || !run.run.startsWith(RUN_PREFIX)) return null;
  const c = readCursor(run);
  if (!c) return null;
  const repo = c.repos[c.repo]!;
  return { cursor: run.cursor!, phase: c.phase, repo, path: c.path ?? firstPath(c.phase, repo), first: c.path === null, attempt: c.attempt };
}

/**
 * A fetch did not work but may later (rate limit, GitHub unavailable): the run waits until
 * `until`. The heartbeat moves there too, so the stale check does not abort a waiting run.
 */
export async function pauseGithubImport(ctx: MutationCtx, runId: Id<'importRuns'>, cursor: string, until: number, attempt: number) {
  const run = await ctx.db.get('importRuns', runId);
  if (!run || run.status !== 'running' || run.cursor !== cursor) return false;
  const c = readCursor(run)!;
  await ctx.db.patch('importRuns', runId, { cursor: JSON.stringify({ ...c, attempt }), heartbeatAt: until });
  return true;
}

// ---------------------------------------------------------------- Pages

interface S {
  ctx: MutationCtx;
  runId: Id<'importRuns'>;
  now: number;
  team: Doc<'teams'>;
  states: WorkflowState[];
  notes: string[];
  rank: { last: string | null };
  /** labels by lower-case name: workspace and team labels; filled lazily */
  labels: Map<string, Doc<'labels'>> | null;
  counts: Record<string, StepCounts>;
}

function note(s: S, text: string) {
  if (!s.notes.includes(text)) s.notes.push(text);
}

function count(s: S, step: string, outcome: Outcome) {
  const c = (s.counts[step] ??= emptyCounts());
  c.seen++;
  c[outcome]++;
}

const STATUS_OF: Record<Exclude<GhState, 'open'>, Status> = { completed: 'done', not_planned: 'canceled', duplicate: 'duplicate' };

/** Open → the team's state for new issues; closed → done, canceled or duplicate by GitHub's reason. */
function targetState(s: S, gh: GhState): WorkflowState {
  const state = gh === 'open' ? defaultState(s.states, workflowOf(s.team)) : stateForStatus(s.states, STATUS_OF[gh]);
  if (!state) throw new Error(`Team ${s.team.key} has no state for ${gh === 'open' ? 'new issues' : STATUS_OF[gh]}.`);
  return state;
}

/** completedAt / canceledAt from GitHub's closing time; open issues have neither. */
function timestamps(status: Status, closedAt: number | undefined, now: number) {
  const at = closedAt ?? now;
  return {
    completedAt: status === 'done' ? at : undefined,
    canceledAt: status === 'canceled' || status === 'duplicate' ? at : undefined,
  };
}

async function labelMap(s: S) {
  if (s.labels) return s.labels;
  const map = new Map<string, Doc<'labels'>>();
  for (const label of await s.ctx.db.query('labels').collect()) {
    if (label.teamId && label.teamId !== s.team._id) continue;
    const key = label.name.trim().toLowerCase();
    const known = map.get(key);
    // Prefer an active label, then a team label over a workspace label.
    if (!known || (known.archived && !label.archived) || (!!known.archived === !!label.archived && !known.teamId && label.teamId)) map.set(key, label);
  }
  s.labels = map;
  return map;
}

/** GitHub labels → Selfbound labels: same name (team or workspace), otherwise a new team label. */
async function labelIdsOf(s: S, gh: GhIssue, identifier: string): Promise<Id<'labels'>[]> {
  const map = await labelMap(s);
  const ids: Id<'labels'>[] = [];
  const groups = new Set<Id<'labelGroups'>>();
  for (const l of gh.labels) {
    const name = clip(l.name, 100, '');
    if (!name) continue;
    let label = map.get(name.toLowerCase());
    if (!label) {
      const id = await s.ctx.db.insert('labels', { name, hue: hueOf(l.color ? `#${l.color}` : undefined) ?? 0, teamId: s.team._id });
      label = (await s.ctx.db.get('labels', id))!;
      map.set(name.toLowerCase(), label);
      count(s, 'label', 'created');
    }
    if (label.archived) {
      note(s, `${identifier}: label "${label.name}" is archived in Selfbound, not assigned`);
      continue;
    }
    if (label.groupId) {
      const group = await s.ctx.db.get('labelGroups', label.groupId);
      if (group?.exclusive && groups.has(group._id)) {
        note(s, `${identifier}: second label of the single-choice group "${group.name}" not assigned`);
        continue;
      }
      groups.add(label.groupId);
    }
    if (!ids.includes(label._id)) ids.push(label._id);
  }
  return ids;
}

/** Last imported GitHub values of an issue in Selfbound form (`linearLinks.base`). */
interface GithubBase {
  state: GhState;
  /** status the GitHub state mapped to */
  status: Status;
  title: string;
  labelIds: Id<'labels'>[];
  descriptionHash: string;
}

async function importIssue(s: S, gh: GhIssue): Promise<Outcome> {
  const { ctx, now, team } = s;
  const key = issueKey(gh.repo, gh.number);
  const ref = `${gh.repo}#${gh.number}`;
  const link = await findLink(ctx, GITHUB_ISSUE, key);
  if (link?.purgedAt !== undefined) {
    note(s, `${ref}: permanently deleted in Selfbound, not recreated`);
    return 'skipped';
  }
  const hash = payloadHash(gh);
  const existing = link ? await getLocal(ctx, 'issues', link.localId) : null;
  if (existing && link?.hash === hash) return 'unchanged';
  const title = clip(gh.title, LIMITS.titleMax, '(untitled)');
  const markdown = issueMarkdown(gh).slice(0, LIMITS.descriptionMax);

  if (!existing) {
    const state = targetState(s, gh.state);
    const status = statusOfState(state);
    const number = await takeCounter(ctx, teamCounter(team._id));
    const identifier = identifierOf(team.key, number);
    const labelIds = await labelIdsOf(s, gh, identifier);
    const seq = await takeCounter(ctx, SEQ);
    const rank = rankBetween(s.rank.last, null);
    s.rank.last = rank;
    const { completedAt, canceledAt } = timestamps(status, gh.closedAt, now);
    const issueId = await ctx.db.insert('issues', {
      seq,
      bucket: bucketOf(seq),
      teamId: team._id,
      number,
      title,
      ...stateFields(state),
      priority: 0,
      labelIds,
      rank,
      createdBy: IMPORT,
      reviewedAt: now, // imported issues count as reviewed
      createdAt: gh.createdAt || now,
      updatedAt: now,
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(canceledAt !== undefined ? { canceledAt } : {}),
    });
    await insertBody(ctx, issueId, markdown, IMPORT, now);
    await record(ctx, IMPORT, now, undefined, { issueId, field: 'created', to: { identifier, title, status, source: 'github' } });
    const base: GithubBase = { state: gh.state, status, title, labelIds, descriptionHash: hashText(markdown) };
    if (link) await ctx.db.patch('linearLinks', link._id, { localId: issueId, hash, runId: s.runId, base });
    else await ctx.db.insert('linearLinks', { kind: GITHUB_ISSUE, linearId: key, localId: issueId, hash, runId: s.runId, base });
    return 'created';
  }

  // ---- imported before: three-way merge per field
  // The owner may have moved the issue to another team since.
  const issueTeam = existing.teamId === team._id ? team : await ctx.db.get('teams', existing.teamId);
  const identifier = identifierOf(issueTeam?.key ?? '?', existing.number);
  const old = (link?.base ?? null) as GithubBase | null;
  const hasBase = old !== null;
  // Labels belong to the issue's team; an issue moved to another team keeps its labels.
  const labelIds = existing.teamId === team._id ? await labelIdsOf(s, gh, identifier) : existing.labelIds;
  const patch: Partial<Doc<'issues'>> = {};
  const conflicts: string[] = [];
  const decide = (field: 'title' | 'labelIds', value: unknown, base: unknown) => {
    const d = merge(hasBase, base, value, existing[field], field === 'labelIds');
    if (d === 'conflict') conflicts.push(field);
    if (d === 'take') Object.assign(patch, { [field]: value });
  };
  decide('title', title, old?.title);
  if (existing.teamId === team._id) decide('labelIds', labelIds, old?.labelIds);
  // Status: only when GitHub's state changed (a new default state for new issues moves nothing).
  let status = old?.status ?? existing.status;
  if (!old || old.state !== gh.state) {
    const states = existing.teamId === team._id ? s.states : await ensureTeamStates(ctx, existing.teamId, now);
    const state = gh.state === 'open' ? defaultState(states, issueTeam ? workflowOf(issueTeam) : undefined) : stateForStatus(states, STATUS_OF[gh.state]);
    if (state) {
      status = statusOfState(state);
      const d = merge(hasBase, old?.status, status, existing.status);
      if (d === 'conflict') conflicts.push('status');
      if (d === 'take') {
        // As in the app (statusTimestamps), with GitHub's closing time.
        Object.assign(patch, stateFields(state), statusTimestamps(existing, status, now), timestamps(status, gh.closedAt, now));
        if (CLOSED_STATUSES.includes(status)) {
          // Only open work carries a priority or a snooze (as when closing in the app).
          if (existing.priority !== 0) patch.priority = 0;
          if (existing.snoozedUntil !== undefined) patch.snoozedUntil = undefined;
        }
      }
    }
  }
  for (const field of ['title', 'status', 'priority', 'labelIds'] as const) {
    if (field in patch) await record(ctx, IMPORT, now, undefined, { issueId: existing._id, field, from: existing[field], to: patch[field] });
  }
  let changed = false;
  if (Object.keys(patch).length) {
    await ctx.db.patch('issues', existing._id, { ...patch, updatedAt: now });
    changed = true;
  }
  const description = await mergeImportedBody(ctx, s.runId, now, existing._id, hasBase, old?.descriptionHash, markdown);
  if (description === 'take') changed = true;
  else if (description === 'conflict') conflicts.push('description');
  if (conflicts.length) {
    const text = `${identifier} (${ref}): changed in Selfbound and on GitHub (${conflicts.join(', ')}); the Selfbound value stays.`;
    await ctx.db.insert('importConflicts', { runId: s.runId, issueId: existing._id, note: text });
    note(s, text);
  }
  const base: GithubBase = { state: gh.state, status, title, labelIds, descriptionHash: hashText(markdown) };
  await ctx.db.patch('linearLinks', link!._id, { hash, runId: s.runId, base });
  return changed ? 'updated' : 'unchanged';
}

/** The imported issue for repo + number (null: not imported, purged or gone). */
async function issueOf(ctx: QueryCtx, repo: string, number: number) {
  const link = await findLink(ctx, GITHUB_ISSUE, issueKey(repo, number));
  if (!link || link.purgedAt !== undefined) return null;
  return await getLocal(ctx, 'issues', link.localId);
}

async function importComment(s: S, gh: GhComment): Promise<Outcome | null> {
  const { ctx, now } = s;
  // The endpoint lists PR comments too; those have no issue here and are not counted.
  const issue = await issueOf(ctx, gh.repo, gh.number);
  if (!issue) return null;
  const hash = payloadHash(gh);
  const link = await findLink(ctx, GITHUB_COMMENT, gh.id);
  const existing = link ? await getLocal(ctx, 'comments', link.localId) : null;
  if (existing && link?.hash === hash) return 'unchanged';
  if (gh.body.length > LIMITS.commentMax) note(s, `${gh.repo}#${gh.number}: comment shortened to ${LIMITS.commentMax} characters`);
  const body = gh.body.slice(0, LIMITS.commentMax) || '(empty)';
  const save = async (localId: string) => {
    if (link) await ctx.db.patch('linearLinks', link._id, { localId, hash, runId: s.runId });
    else await ctx.db.insert('linearLinks', { kind: GITHUB_COMMENT, linearId: gh.id, localId, hash, runId: s.runId });
  };
  if (!existing) {
    const commentId = await ctx.db.insert('comments', {
      issueId: issue._id,
      body,
      author: IMPORT,
      authorName: authorName(gh.author),
      createdAt: gh.createdAt,
      ...(gh.updatedAt > gh.createdAt ? { editedAt: gh.updatedAt } : {}),
    });
    await syncFileRefs(ctx, commentId, body, now);
    await syncArticleLinks(ctx, { kind: 'comment', id: commentId, issueId: issue._id }, body);
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, { issueId: issue._id, field: 'comment', to: { commentId, preview: body.slice(0, 120) } });
    await save(commentId);
    return 'created';
  }
  // Comments deleted in Selfbound stay deleted.
  let changed = false;
  if (existing.deletedAt === undefined && existing.body !== body) {
    await ctx.db.patch('comments', existing._id, { body, editedAt: gh.updatedAt || now });
    await syncFileRefs(ctx, existing._id, body, now);
    await syncArticleLinks(ctx, { kind: 'comment', id: existing._id, issueId: issue._id }, body);
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, { issueId: issue._id, field: 'comment_edited', to: { commentId: existing._id, preview: body.slice(0, 120) } });
    changed = true;
  }
  await save(existing._id);
  return changed ? 'updated' : 'unchanged';
}

/** Links a PR to the imported issues it closes by keyword. Never closes anything itself. */
async function importPull(s: S, gh: GhPull) {
  const { ctx, now } = s;
  for (const target of gh.closes) {
    const issue = await issueOf(ctx, target.repo, target.number);
    if (!issue) continue;
    const key = `${issueKey(gh.repo, gh.number)}>${issueKey(target.repo, target.number)}`;
    // Once linked, a link removed in Selfbound stays removed.
    if (await findLink(ctx, GITHUB_PR, key)) {
      count(s, 'pullRequest', 'unchanged');
      continue;
    }
    let pr = await ctx.db
      .query('pullRequests')
      .withIndex('by_repo_number', (q) => q.eq('repo', gh.repo).eq('number', gh.number))
      .unique();
    if (!pr) {
      // An existing PR (from the webhook) is more current and stays as it is.
      const prId = await ctx.db.insert('pullRequests', {
        repo: gh.repo,
        number: gh.number,
        title: clip(gh.title, 500, `#${gh.number}`),
        url: gh.url,
        state: gh.state,
        branch: gh.branch,
        author: gh.author,
        updatedAt: gh.updatedAt,
        ...(gh.mergedAt !== undefined ? { mergedAt: gh.mergedAt } : {}),
      });
      pr = (await ctx.db.get('pullRequests', prId))!;
    }
    const rows = await ctx.db
      .query('issuePullRequests')
      .withIndex('by_issue', (q) => q.eq('issueId', issue._id))
      .take(200);
    let row = rows.find((r) => r.prId === pr._id);
    const linked = row !== undefined;
    if (!row) {
      const id = await ctx.db.insert('issuePullRequests', { issueId: issue._id, prId: pr._id, via: 'import', closes: false });
      row = (await ctx.db.get('issuePullRequests', id))!;
      await ctx.db.patch('issues', issue._id, { updatedAt: now });
      await record(ctx, IMPORT, now, undefined, {
        issueId: issue._id,
        field: 'pull_request',
        to: { pr: `${gh.repo}#${gh.number}`, url: gh.url, via: 'import', closes: false },
      });
    }
    await ctx.db.insert('linearLinks', { kind: GITHUB_PR, linearId: key, localId: row._id, runId: s.runId });
    // Already linked (e.g. by the webhook): nothing new.
    count(s, 'pullRequest', linked ? 'unchanged' : 'created');
  }
}

export type GithubRows =
  | { phase: 'issues'; rows: GhIssue[] }
  | { phase: 'pulls'; rows: GhPull[] }
  | { phase: 'comments'; rows: GhComment[] };

/**
 * Writes one fetched page (or a part of it). `done`: the page is complete, move the cursor on
 * to `next` (or the next repo / phase). `notes`: deviations from fetching.
 * Returns null if the run moved on in the meantime (a duplicate step), else whether it finished.
 */
export async function applyGithubPage(
  ctx: MutationCtx,
  runId: Id<'importRuns'>,
  args: { cursor: string; page: GithubRows; done: boolean; next: string | null; notes: string[]; heartbeatAt?: number; repo?: string },
): Promise<{ finished: boolean } | null> {
  const run = await ctx.db.get('importRuns', runId);
  if (!run || run.status !== 'running' || run.cursor !== args.cursor) return null;
  const c = readCursor(run)!;
  const teamId = ctx.db.normalizeId('teams', c.teamId);
  const team = teamId ? await ctx.db.get('teams', teamId) : null;
  if (!team) throw new Error('The target team no longer exists.');
  const now = Date.now();
  const s: S = {
    ctx,
    runId,
    now,
    team,
    states: await ensureTeamStates(ctx, team._id, now),
    notes: [...args.notes],
    rank: { last: args.page.phase === 'issues' ? await lastRank(ctx) : null },
    labels: null,
    counts: { ...(run.counts as Record<string, StepCounts>) },
  };
  for (const step of ['issue', 'label', 'comment', 'pullRequest']) if (s.counts[step]) s.counts[step] = { ...s.counts[step] };
  if (args.page.phase === 'issues') for (const gh of args.page.rows) count(s, 'issue', await importIssue(s, gh));
  else if (args.page.phase === 'comments') {
    for (const gh of args.page.rows) {
      const outcome = await importComment(s, gh);
      if (outcome) count(s, 'comment', outcome);
    }
  } else for (const gh of args.page.rows) await importPull(s, gh);

  const deviations = [...run.deviations];
  for (const text of s.notes) if (!deviations.includes(text) && deviations.length < 1000) deviations.push(text);
  // GitHub's spelling of the repo (as the webhook stores it) replaces the typed one.
  const current = args.repo ? { ...c, repos: c.repos.map((r, i) => (i === c.repo ? args.repo! : r)) } : c;
  const following = args.done ? advanceCursor(current, args.next) : c;
  const heartbeatAt = Math.max(now, args.heartbeatAt ?? now);
  if (!following) {
    await ctx.db.patch('importRuns', runId, { counts: s.counts, deviations, status: 'done', finishedAt: now, phase: 'done', cursor: null, heartbeatAt: now });
    return { finished: true };
  }
  await ctx.db.patch('importRuns', runId, { counts: s.counts, deviations, phase: following.phase, cursor: JSON.stringify(following), heartbeatAt });
  return { finished: false };
}

/** The latest GitHub run (for `githubImport:status` without arguments). */
export async function latestGithubRun(ctx: QueryCtx) {
  return await ctx.db
    .query('importRuns')
    .withIndex('by_run', (q) => q.gte('run', RUN_PREFIX).lt('run', 'github;'))
    .order('desc')
    .first();
}
