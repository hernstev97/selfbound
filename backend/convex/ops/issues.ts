import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { SEQ, takeCounter, teamCounter } from '../lib/counters';
import { DAY_MS } from '../lib/dates';
import { sameValue } from '../lib/equal';
import { fail, invalid } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { ranksAtEnd, rankAfter, rankBefore, rankBetween } from '../lib/rank';
import type { IssuePatch, NewIssue, PatchField, RevertItem } from '../lib/validators';
import { assertTransition, ensureTeamStates, resolveState, stateFields, workflowOf } from '../lib/workflow';
import { PATCH_FIELDS } from '../lib/validators';
import { priorityLimitsOf, todayOf } from './instance';
import { assertRoom, holds, openWithPriority } from './priorityLimits';
import { isLimited, limitFor, overLimit } from '../shared/priorityLimits';
import {
  bucketOf,
  CLOSED_STATUSES,
  identifierOf,
  LIMITS,
  type Priority,
  type Status,
} from '../shared/constants';
import type { ModelChoice } from '../shared/models';
import { GITHUB_ISSUE } from '../lib/githubIssues';
import { defaultState, statusOfState } from '../shared/workflow';
import { insertBody, writeBody } from './bodies';
import { syncFileRefs } from './files';
import { dropLinksTo, syncArticleLinks } from './links';
import { record } from './history';
import { purgeEntries } from './inbox';
import { openCreatedEntry } from './inboxChanges';
import { notifyAgentIssues } from './notify';
import { attachIssue, detachForTrash, setIssueSprint } from './sprints';
import {
  assertIssuesAllowed,
  checkDay,
  checkDescription,
  checkEstimate,
  checkLabels,
  checkModel,
  checkParent,
  checkProject,
  checkTitle,
  getIssue,
  getTeam,
} from './validate';

export const TRASH_DAYS = 30;

/** Hint (not an error): the team has more open urgent/high issues than its (soft) limit. */
export interface BudgetWarning {
  code: 'budget_warning';
  teamId: Id<'teams'>;
  priority: 1 | 2;
  open: number;
  budget: number;
  message: string;
}

const PRIORITY_NAMES: Record<1 | 2, string> = { 1: 'Urgent', 2: 'High' };

/** Timestamps that come with a status change. */
export function statusTimestamps(issue: Pick<Doc<'issues'>, 'startedAt'> | null, status: Status, now: number) {
  switch (status) {
    case 'triage':
    case 'backlog':
    case 'todo':
      return { startedAt: undefined, completedAt: undefined, canceledAt: undefined };
    case 'in_progress':
    case 'in_review':
      return { startedAt: issue?.startedAt ?? now, completedAt: undefined, canceledAt: undefined };
    case 'done':
      return { completedAt: now, canceledAt: undefined };
    case 'canceled':
    case 'duplicate':
      return { canceledAt: now, completedAt: undefined };
  }
}

/** Checks the priority limits for (team, priority) pairs; teams over a limit get a warning. */
export async function budgetWarnings(
  ctx: QueryCtx,
  pairs: Iterable<{ teamId: Id<'teams'>; priority: Priority }>,
): Promise<BudgetWarning[]> {
  const seen = new Set<string>();
  const warnings: BudgetWarning[] = [];
  const limits = await priorityLimitsOf(ctx);
  for (const { teamId, priority } of pairs) {
    if (!isLimited(priority)) continue;
    const limit = limitFor(limits, priority);
    if (limit?.max == null) continue;
    const key = `${teamId}:${priority}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const open = (await openWithPriority(ctx, teamId, priority)).length;
    if (overLimit(limit, open)) {
      const team = await ctx.db.get('teams', teamId);
      warnings.push({
        code: 'budget_warning',
        teamId,
        priority,
        open,
        budget: limit.max,
        message: `${team?.key ?? 'The team'} now has ${open} open issues with priority "${PRIORITY_NAMES[priority]}" (limit ${limit.max}).`,
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------- Create

export interface CreateIssuesArgs {
  issues: NewIssue[];
  requestId?: string;
}

export interface CreateOptions {
  /** Recurrence the issue comes from. */
  recurrenceId?: Id<'recurrences'>;
  /** Put it in the inbox although the owner creates it (shared from another app). */
  inbox?: boolean;
}

/**
 * Creates 1–50 issues. seq and team numbers are assigned in the same transaction
 * (Convex retries on conflicts, so no number is handed out twice).
 * Each issue gets exactly one 'created' history row.
 */
export async function createIssues(ctx: MutationCtx, actor: Actor, args: CreateIssuesArgs, opts: CreateOptions = {}) {
  return await idempotent(ctx, actor, args.requestId, 'issues.create', { ...args }, async () =>
    createIssuesCore(ctx, actor, args, opts),
  );
}

/**
 * Core of createIssues without the idempotency wrapper. `requestId` only goes into the history.
 * For callers with their own idempotency (MCP create_issues wraps the whole tool).
 */
export async function createIssuesCore(ctx: MutationCtx, actor: Actor, args: CreateIssuesArgs, opts: CreateOptions = {}) {
  const items = args.issues;
  if (items.length === 0 || items.length > LIMITS.batchCreateMax) {
    invalid(`Between 1 and ${LIMITS.batchCreateMax} issues per call.`);
  }
  const now = Date.now();

  // Check everything first, then write.
  const teams = new Map<Id<'teams'>, Doc<'teams'>>();
  const prepared = [];
  for (const item of items) {
    const team = teams.get(item.teamId) ?? (await getTeam(ctx, item.teamId));
    assertIssuesAllowed(team);
    teams.set(team._id, team);
    const states = await ensureTeamStates(ctx, team._id, now);
    const state =
      item.stateId !== undefined || item.status !== undefined
        ? resolveState(states, team, { stateId: item.stateId, status: item.status })
        : (defaultState(states, workflowOf(team), { triage: opts.inbox }) ??
          invalid(`Team ${team.key} has no status for new issues.`));
    assertTransition(actor, team, states, null, state, team.key);
    const sprint = item.sprintId ? await ctx.db.get('sprints', item.sprintId) : null;
    if (item.sprintId && !sprint) invalid('The sprint does not exist.', { sprintId: item.sprintId });
    if (sprint?.state === 'closed') invalid(`Sprint ${sprint.number} is closed.`);
    prepared.push({
      team,
      sprint,
      title: checkTitle(item.title),
      description: checkDescription(item.description ?? ''),
      state,
      status: statusOfState(state),
      // An issue created as done, canceled or duplicate carries no priority.
      priority: CLOSED_STATUSES.includes(statusOfState(state)) ? 0 : (item.priority ?? 0),
      requestedPriority: item.priority ?? 0,
      labelIds: await checkLabels(ctx, team._id, item.labelIds ?? []),
      projectId: item.projectId ? (await checkProject(ctx, team._id, item.projectId))._id : undefined,
      estimate: item.estimate === undefined ? undefined : checkEstimate(item.estimate),
      dueDate: item.dueDate === undefined ? undefined : checkDay(item.dueDate, 'The due date'),
      parentId: item.parentId ? (await checkParent(ctx, null, item.parentId))._id : undefined,
      model: item.model ? await checkModel(ctx, item.model) : undefined,
    });
  }

  // Hard priority limits: all new urgent/high issues of a team together, before anything is written.
  const adding = new Map<string, { teamId: Id<'teams'>; priority: Priority; count: number }>();
  for (const p of prepared) {
    if (!isLimited(p.priority)) continue;
    const key = `${p.team._id}:${p.priority}`;
    const entry = adding.get(key) ?? { teamId: p.team._id, priority: p.priority, count: 0 };
    entry.count++;
    adding.set(key, entry);
  }
  for (const { teamId, priority, count } of adding.values()) await assertRoom(ctx, teamId, priority, count);

  const firstSeq = await takeCounter(ctx, SEQ, items.length);
  const ranks = await ranksAtEnd(ctx, items.length);
  const perTeam = new Map<Id<'teams'>, number>();
  for (const p of prepared) perTeam.set(p.team._id, (perTeam.get(p.team._id) ?? 0) + 1);
  const nextNumber = new Map<Id<'teams'>, number>();
  for (const [teamId, count] of perTeam) nextNumber.set(teamId, await takeCounter(ctx, teamCounter(teamId), count));

  const created: { id: Id<'issues'>; identifier: string; clearedPriority?: Priority }[] = [];
  const announced: { id: Id<'issues'>; identifier: string; title: string }[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const number = nextNumber.get(p.team._id)!;
    nextNumber.set(p.team._id, number + 1);
    const seq = firstSeq + i;
    const id = await ctx.db.insert('issues', {
      seq,
      bucket: bucketOf(seq),
      teamId: p.team._id,
      number,
      title: p.title,
      ...stateFields(p.state),
      priority: p.priority,
      labelIds: p.labelIds,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      ...(p.estimate !== undefined ? { estimate: p.estimate } : {}),
      ...(p.dueDate ? { dueDate: p.dueDate } : {}),
      ...(p.parentId ? { parentId: p.parentId } : {}),
      ...(p.model ? { model: p.model } : {}),
      rank: ranks[i],
      createdBy: actor,
      // Legacy marker (see schema): lets the inbox migration tell issues apart that never had an entry.
      ...(actor.kind === 'agent' || opts.inbox ? {} : { reviewedAt: now }),
      createdAt: now,
      updatedAt: now,
      ...statusTimestamps(null, p.status, now),
      ...(opts.recurrenceId ? { recurrenceId: opts.recurrenceId } : {}),
    });
    await insertBody(ctx, id, p.description, actor, now);
    // Issues created by agents (and shared ones) stay in the inbox until the owner removes the entry.
    if (actor.kind === 'agent' || opts.inbox) await openCreatedEntry(ctx, actor, id, now);
    const identifier = identifierOf(p.team.key, number);
    if (p.sprint) {
      const issue = (await ctx.db.get('issues', id))!;
      await attachIssue(ctx, actor, issue, p.sprint, { now, requestId: args.requestId, history: false });
    }
    await record(ctx, actor, now, args.requestId, {
      issueId: id,
      field: 'created',
      to: { identifier, title: p.title, status: p.status, stateId: p.state._id, ...(p.sprint ? { sprintId: p.sprint._id } : {}) },
    });
    announced.push({ id, identifier, title: p.title });
    created.push({
      id,
      identifier,
      ...(p.priority === 0 && p.requestedPriority !== 0 ? { clearedPriority: p.requestedPriority } : {}),
    });
  }
  await notifyAgentIssues(ctx, actor, announced, now);
  const warnings = await budgetWarnings(
    ctx,
    prepared.map((p) => ({ teamId: p.team._id, priority: p.priority })),
  );
  return { issues: created, warnings };
}

// ---------------------------------------------------------------- Update

/**
 * Applies a patch to an issue. A field is only written if its value changes
 * (value equality, label lists as sets). `expect` turns it into a compare-and-set:
 * if the stored value is no longer the expected one → `conflict`.
 * sprintId is handed on to ops/sprints.ts.
 */
export async function applyPatch(
  ctx: MutationCtx,
  actor: Actor,
  issueId: Id<'issues'>,
  patch: IssuePatch,
  expect: IssuePatch | undefined,
  now: number,
  requestId?: string,
  opts: { undo?: boolean; force?: boolean } = {},
): Promise<boolean> {
  const issue = await getIssue(ctx, issueId);
  if (expect) {
    for (const field of Object.keys(expect) as PatchField[]) {
      const expected = expect[field];
      if (expected === undefined) continue;
      if (!PATCH_FIELDS.includes(field)) invalid(`Unknown field "${field}".`);
      if (!sameValue(issue[field], expected, field === 'labelIds')) {
        const team = await ctx.db.get('teams', issue.teamId);
        const identifier = identifierOf(team?.key ?? '?', issue.number);
        fail('conflict', `${identifier} was changed in the meantime (${field}). Reload and try again.`, {
          issueId,
          identifier,
          field,
          expected,
          actual: issue[field] ?? null,
        });
      }
    }
  }

  const changes: Partial<Doc<'issues'>> = {};
  const rows: { field: string; from: unknown; to: unknown }[] = [];
  const set = <F extends Exclude<PatchField, 'sprintId'>>(field: F, value: Doc<'issues'>[F] | undefined) => {
    if (sameValue(issue[field], value, field === 'labelIds')) return;
    (changes as Record<string, unknown>)[field] = value;
    rows.push({ field, from: issue[field], to: value });
  };

  // An issue that moves into a done/canceled/duplicate status loses its priority. This holds
  // for every path, even if the same patch also sends a priority.
  let closing = false;
  if (patch.title !== undefined) set('title', checkTitle(patch.title));
  if (patch.stateId !== undefined || patch.status !== undefined) {
    // Only a status kind (e.g. 'done' from a GitHub merge, an old client): if the issue already
    // is in a status of that kind (including a custom one like "Testing"), it stays there.
    const keep = patch.stateId === undefined && issue.stateId !== undefined && issue.status === patch.status;
    if (!keep) {
      const team = await getTeam(ctx, issue.teamId);
      const states = await ensureTeamStates(ctx, team._id, now);
      const target = resolveState(states, team, { stateId: patch.stateId, status: patch.status });
      // Fixed order; undo and moving issues off an archived status are exempt.
      const from = issue.stateId ? states.find((s) => s._id === issue.stateId) : undefined;
      if (from && !opts.undo && !opts.force) assertTransition(actor, team, states, from, target, identifierOf(team.key, issue.number));
      set('stateId', target._id);
      // The status kind follows the status (without its own history row).
      const status = statusOfState(target);
      if (status !== issue.status) changes.status = status;
      closing = target._id !== issue.stateId && CLOSED_STATUSES.includes(status);
    }
  }
  // Its own history row, with the same actor and requestId as the status change.
  if (closing) set('priority', 0);
  else if (patch.priority !== undefined) set('priority', patch.priority);
  if (patch.labelIds !== undefined) {
    // Archived labels: only NEWLY added ones are rejected. Labels already on the issue may
    // stay; on undo, so may those the last label change removed.
    const keep = new Set<Id<'labels'>>(issue.labelIds);
    if (opts.undo) for (const id of await lastRemovedLabels(ctx, issue._id)) keep.add(id);
    set('labelIds', await checkLabels(ctx, issue.teamId, patch.labelIds, keep));
  }
  if (patch.projectId !== undefined) {
    set('projectId', patch.projectId === null ? undefined : (await checkProject(ctx, issue.teamId, patch.projectId))._id);
  }
  if (patch.estimate !== undefined) set('estimate', patch.estimate === null ? undefined : checkEstimate(patch.estimate));
  if (patch.dueDate !== undefined) set('dueDate', patch.dueDate === null ? undefined : checkDay(patch.dueDate, 'The due date'));
  // Snooze belongs to open work, like the priority: closing an issue ends it.
  if (closing) {
    if (issue.snoozedUntil !== undefined) set('snoozedUntil', undefined);
  } else if (patch.snoozedUntil !== undefined) {
    if (patch.snoozedUntil === null) set('snoozedUntil', undefined);
    else {
      const until = checkDay(patch.snoozedUntil, 'The snooze date');
      // Undo may bring back a day that has passed; the morning job then returns the issue.
      if (!opts.undo) {
        if (until <= (await todayOf(ctx, now))) invalid('Snooze until a day after today.');
        if (CLOSED_STATUSES.includes(changes.status ?? issue.status)) invalid('Only open issues can be snoozed.');
      }
      set('snoozedUntil', until);
    }
  }
  if (patch.parentId !== undefined) {
    set('parentId', patch.parentId === null ? undefined : (await checkParent(ctx, issue._id, patch.parentId))._id);
  }
  if (patch.model !== undefined) {
    const undo = opts.undo ? await lastReplacedModel(ctx, issue._id) : null;
    set('model', patch.model === null ? undefined : await checkModel(ctx, patch.model, { keep: issue.model, undo }));
  }

  if (changes.status !== undefined) Object.assign(changes, statusTimestamps(issue, changes.status, now));
  // A raise (the issue newly counts toward urgent/high in its team) must fit a hard limit.
  const after = { priority: changes.priority ?? issue.priority, status: changes.status ?? issue.status, deletedAt: issue.deletedAt };
  if (holds(after, after.priority) && !holds(issue, after.priority)) await assertRoom(ctx, issue.teamId, after.priority);
  let changed = false;
  if (rows.length > 0) {
    await ctx.db.patch('issues', issue._id, { ...changes, updatedAt: now });
    for (const row of rows) await record(ctx, actor, now, requestId, { issueId: issue._id, ...row });
    changed = true;
  }
  if (patch.sprintId !== undefined) {
    changed = (await setIssueSprint(ctx, actor, issue._id, patch.sprintId, now, requestId)) || changed;
  }
  return changed;
}

/** Labels the issue had before its last label change (for undo). */
/** The model the issue had before its last model change (for undo and redo). */
async function lastReplacedModel(ctx: QueryCtx, issueId: Id<'issues'>): Promise<ModelChoice | null> {
  const rows = await ctx.db
    .query('history')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .order('desc')
    .take(50);
  const from = rows.find((r) => r.field === 'model')?.from as ModelChoice | undefined;
  return from && typeof from === 'object' ? from : null;
}

async function lastRemovedLabels(ctx: QueryCtx, issueId: Id<'issues'>): Promise<Id<'labels'>[]> {
  const rows = await ctx.db
    .query('history')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .order('desc')
    .take(50);
  const last = rows.find((r) => r.field === 'labelIds');
  return Array.isArray(last?.from) ? (last.from as Id<'labels'>[]) : [];
}

export interface UpdateIssuesArgs {
  ids: Id<'issues'>[];
  patch: IssuePatch;
  expect?: IssuePatch[];
  requestId?: string;
}

/** Updates up to 500 issues with the same patch, optionally with an expected value per issue. */
export async function updateIssues(ctx: MutationCtx, actor: Actor, args: UpdateIssuesArgs) {
  return await idempotent(ctx, actor, args.requestId, 'issues.update', { ...args }, async () =>
    updateIssuesCore(ctx, actor, args),
  );
}

/** Core of updateIssues without the idempotency wrapper (`requestId` only for the history). */
export async function updateIssuesCore(ctx: MutationCtx, actor: Actor, args: UpdateIssuesArgs) {
  if (args.ids.length === 0 || args.ids.length > LIMITS.bulkUpdateMax) {
    invalid(`Between 1 and ${LIMITS.bulkUpdateMax} issues per change.`);
  }
  if (new Set(args.ids).size !== args.ids.length) invalid('An issue appears more than once in the list.');
  if (args.expect && args.expect.length !== args.ids.length) invalid('expect needs exactly one entry per issue.');
  const now = Date.now();
  let changed = 0;
  const touched: { teamId: Id<'teams'>; priority: Priority }[] = [];
  for (let i = 0; i < args.ids.length; i++) {
    if (await applyPatch(ctx, actor, args.ids[i], args.patch, args.expect?.[i], now, args.requestId)) changed++;
    if (args.patch.priority === 1 || args.patch.priority === 2) {
      const issue = await ctx.db.get('issues', args.ids[i]);
      if (issue) touched.push({ teamId: issue.teamId, priority: args.patch.priority });
    }
  }
  return { updatedAt: now, changed, warnings: await budgetWarnings(ctx, touched) };
}

/** Undo: each issue gets its old value back, but only if it still holds the value that was set. */
export async function revertIssues(ctx: MutationCtx, actor: Actor, args: { items: RevertItem[]; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'issues.revert', { ...args }, async () => {
    if (args.items.length === 0 || args.items.length > LIMITS.bulkUpdateMax) {
      invalid(`Between 1 and ${LIMITS.bulkUpdateMax} issues per change.`);
    }
    const now = Date.now();
    let changed = 0;
    for (const item of args.items) {
      if (await applyPatch(ctx, actor, item.id, item.patch, item.expect, now, args.requestId, { undo: true })) changed++;
    }
    return { updatedAt: now, changed };
  });
}

// ---------------------------------------------------------------- Description

export interface SetDescriptionArgs {
  id: Id<'issues'>;
  markdown: string;
  baseVersion: number;
  requestId?: string;
}

/**
 * A new description only on top of the current version. If the version differs,
 * the result is `conflict` with the current state (version, actor, time) instead of
 * a silent overwrite. The history only holds the version and a 120-character preview.
 */
export async function setDescription(ctx: MutationCtx, actor: Actor, args: SetDescriptionArgs) {
  return await idempotent(ctx, actor, args.requestId, 'issues.setDescription', { ...args }, async () =>
    applyDescription(ctx, actor, args, Date.now(), args.requestId),
  );
}

/**
 * Core of setDescription without the idempotency wrapper. For callers that manage
 * their own requestId (MCP update_issue: fields and description in one call).
 */
export async function applyDescription(
  ctx: MutationCtx,
  actor: Actor,
  args: { id: Id<'issues'>; markdown: string; baseVersion: number },
  now: number,
  requestId?: string,
) {
  const issue = await getIssue(ctx, args.id);
  const markdown = checkDescription(args.markdown);
  const body = await ctx.db
    .query('issueBodies')
    .withIndex('by_issue', (q) => q.eq('issueId', issue._id))
    .unique();
  const current = body?.version ?? 0;
  if (current !== args.baseVersion) {
    fail('conflict', 'The description was changed in the meantime. Review the new version and save again.', {
      issueId: issue._id,
      version: current,
      updatedAt: body?.updatedAt,
      updatedBy: body?.updatedBy,
    });
  }
  if (body && body.markdown === markdown) return { version: current, changed: false };
  const version = await writeBody(ctx, issue._id, body, markdown, actor, now);
  await ctx.db.patch('issues', issue._id, { updatedAt: now });
  await record(ctx, actor, now, requestId, {
    issueId: issue._id,
    field: 'description',
    from: { version: current },
    to: { version, preview: markdown.slice(0, 120) },
  });
  return { version, changed: true };
}

// ---------------------------------------------------------------- Trash

/** Moves issues to the trash (deletedAt). They stay in their bucket. */
export async function removeIssues(ctx: MutationCtx, actor: Actor, args: { ids: Id<'issues'>[]; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'issues.remove', { ...args }, async () => {
    if (args.ids.length === 0 || args.ids.length > LIMITS.bulkUpdateMax) invalid(`Between 1 and ${LIMITS.bulkUpdateMax} issues per call.`);
    const now = Date.now();
    let removed = 0;
    for (const id of new Set(args.ids)) {
      const issue = await getIssue(ctx, id, { allowDeleted: true });
      if (issue.deletedAt !== undefined) continue;
      // Take it out of an active or planned sprint (restoring does not put it back).
      await detachForTrash(ctx, actor, issue, now, args.requestId);
      await ctx.db.patch('issues', issue._id, { deletedAt: now, updatedAt: now });
      await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'deleted', to: now });
      removed++;
    }
    return { removed, deletedAt: now };
  });
}

export async function restoreIssues(ctx: MutationCtx, actor: Actor, args: { ids: Id<'issues'>[]; requestId?: string }) {
  return await idempotent(ctx, actor, args.requestId, 'issues.restore', { ...args }, async () => {
    if (args.ids.length === 0 || args.ids.length > LIMITS.bulkUpdateMax) invalid(`Between 1 and ${LIMITS.bulkUpdateMax} issues per call.`);
    const now = Date.now();
    let restored = 0;
    for (const id of new Set(args.ids)) {
      const issue = await getIssue(ctx, id, { allowDeleted: true });
      if (issue.deletedAt === undefined) continue;
      if (holds({ ...issue, deletedAt: undefined }, issue.priority)) await assertRoom(ctx, issue.teamId, issue.priority);
      await ctx.db.patch('issues', issue._id, { deletedAt: undefined, updatedAt: now });
      await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'restored', from: issue.deletedAt });
      restored++;
    }
    return { restored };
  });
}

/**
 * Deletes an issue for good, with everything attached to it.
 * Exceptions: entries of closed sprints stay (frozen, with `points`), and an import link
 * (Linear or GitHub) is only marked `purgedAt`, so a later import does not create the issue again.
 */
export async function purgeIssue(ctx: MutationCtx, issue: Doc<'issues'>, now: number) {
  const id = issue._id;
  await purgeEntries(ctx, id);
  const sprintItems = [];
  for (const entry of await ctx.db.query('sprintItems').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()) {
    const sprint = await ctx.db.get('sprints', entry.sprintId);
    if (sprint?.state !== 'closed') sprintItems.push(entry);
  }
  // Texts that may contain images: drop the references; the cron cleans up the files (ops/files.ts).
  const texts = [
    ...(await ctx.db.query('issueBodies').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
    ...(await ctx.db.query('bodyRevisions').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
    ...(await ctx.db.query('comments').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
  ];
  for (const row of texts) await syncFileRefs(ctx, row._id, null, now);
  // Links to knowledge pages from the description and comments, and links from pages to the issue.
  const linkRows = await ctx.db
    .query('articleLinks')
    .withIndex('by_from_issue', (q) => q.eq('fromIssueId', id))
    .collect();
  for (const row of linkRows) await ctx.db.delete('articleLinks', row._id);
  await dropLinksTo(ctx, { issueId: id });
  const rows = [
    ...texts,
    ...(await ctx.db.query('bodySearch').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
    ...sprintItems,
    ...(await ctx.db.query('issuePullRequests').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
    ...(await ctx.db.query('identifierAliases').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
    ...(await ctx.db.query('history').withIndex('by_issue', (q) => q.eq('issueId', id)).collect()),
  ];
  for (const row of rows) await ctx.db.delete(row._id);
  const links = await ctx.db
    .query('linearLinks')
    .withIndex('by_local', (q) => q.eq('localId', id))
    .collect();
  for (const link of links) if (link.kind === 'issue' || link.kind === GITHUB_ISSUE) await ctx.db.patch('linearLinks', link._id, { purgedAt: now });
  for (const index of ['by_from', 'by_to'] as const) {
    const rows = await ctx.db
      .query('relations')
      .withIndex(index, (q) => q.eq(index === 'by_from' ? 'fromId' : 'toId', issue._id))
      .collect();
    for (const row of rows) await ctx.db.delete('relations', row._id);
  }
  const children = await ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parentId', issue._id))
    .collect();
  for (const child of children) {
    await ctx.db.patch('issues', child._id, { parentId: undefined, updatedAt: now });
    await record(ctx, { kind: 'system' }, now, undefined, { issueId: child._id, field: 'parentId', from: issue._id });
  }
  await ctx.db.delete('issues', issue._id);
}

/** Deletes for good what has been in the trash for more than TRASH_DAYS days (in batches). */
export async function purgeTrash(ctx: MutationCtx, now: number, limit = 25) {
  const cutoff = now - TRASH_DAYS * DAY_MS;
  const due = await ctx.db
    .query('issues')
    .withIndex('by_deleted', (q) => q.gte('deletedAt', 0).lt('deletedAt', cutoff))
    .take(limit);
  for (const issue of due) await purgeIssue(ctx, issue, now);
  return { purged: due.length, more: due.length === limit };
}

// ---------------------------------------------------------------- Order

export interface ReorderArgs {
  id: Id<'issues'>;
  /** Neighbor that ends up directly BEFORE (above) the issue. */
  beforeId?: Id<'issues'>;
  /** Neighbor that ends up directly AFTER (below) the issue. */
  afterId?: Id<'issues'>;
  requestId?: string;
}

/** New backlog rank between the neighbors. Order afterwards: before, issue, after. */
export async function reorderIssue(ctx: MutationCtx, actor: Actor, args: ReorderArgs) {
  return await idempotent(ctx, actor, args.requestId, 'issues.reorder', { ...args }, async () => {
    if (!args.beforeId && !args.afterId) invalid('At least one neighbor (beforeId or afterId) is required.');
    if (args.beforeId === args.id || args.afterId === args.id) invalid('An issue cannot be its own neighbor.');
    const issue = await getIssue(ctx, args.id, { allowDeleted: true });
    const before = args.beforeId ? await getIssue(ctx, args.beforeId, { allowDeleted: true }) : null;
    const after = args.afterId ? await getIssue(ctx, args.afterId, { allowDeleted: true }) : null;
    let lo = before?.rank ?? (after ? await rankBefore(ctx, after.rank, issue._id) : null);
    let hi = after?.rank ?? (before ? await rankAfter(ctx, before.rank, issue._id) : null);
    if (lo !== null && hi !== null && lo >= hi) {
      // The neighbors no longer fit together, e.g. after a concurrent change: place it right after `before`.
      if (before) hi = await rankAfter(ctx, before.rank, issue._id);
      else lo = await rankBefore(ctx, hi, issue._id);
    }
    const rank = rankBetween(lo, hi);
    const now = Date.now();
    await ctx.db.patch('issues', issue._id, { rank, updatedAt: now });
    await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'rank', from: issue.rank, to: rank });
    return { rank };
  });
}
