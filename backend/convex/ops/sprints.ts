import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { SPRINT, takeCounter } from '../lib/counters';
import { addDays, berlinDay, daysBetween, nextMonday } from '../lib/dates';
import { fail, invalid, notFound } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { teamKeys } from '../lib/identifiers';
import type { SprintDecision, SprintOutcome } from '../lib/validators';
import { isOpen, LEGACY_SPRINT_SOURCE, SPRINT_SOURCE, type SprintItemKind } from '../shared/constants';
import { record } from './history';
import { applyPatch } from './issues';
import { checkDay, checkName, getIssue } from './validate';

// Sprints across all teams. This file is the ONLY place that writes `issue.sprintId`
// and `sprintItems`. Invariant for every sprint S that is NOT closed:
//   issue.sprintId === S  ⇔  there is exactly one entry for (S, issue) without removedAt.
// Entries of closed sprints are frozen: nothing changes or deletes them anymore (not even
// moving, detaching or purging the issue). If issue.sprintId points to a closed sprint S,
// there is an entry for (S, issue) without removedAt; not necessarily the other way round
// (the issue may have moved on).
// Further rules:
//   - State planning → active → closed; a sprint only starts on explicit request.
//   - At most ONE active sprint.
//   - An issue belongs to at most one sprint that is not closed.
//   - Adding in state planning = 'planned', active = 'late', closed = error.
//   - Closing needs a decision for every open issue; nothing is moved automatically.

export const DEFAULT_SPRINT_DAYS = 14;

async function getSprint(ctx: QueryCtx, sprintId: Id<'sprints'>) {
  return (await ctx.db.get('sprints', sprintId)) ?? notFound('The sprint', { sprintId });
}

/** Open entry (without removedAt) of an issue in a sprint. */
async function openEntry(ctx: QueryCtx, issueId: Id<'issues'>, sprintId: Id<'sprints'>) {
  const entries = await ctx.db
    .query('sprintItems')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .collect();
  return entries.find((e) => e.sprintId === sprintId && e.removedAt === undefined) ?? null;
}

interface MoveOptions {
  now: number;
  requestId?: string;
  /** false: no separate history row (on creation the sprint is part of the 'created' row). */
  history?: boolean;
  kind?: SprintItemKind;
  carriedFrom?: Id<'sprints'>;
  /** Outcome for the old entry (when closing). */
  outcome?: SprintOutcome;
}

/**
 * Closes the issue's open entry (if any); does not clear issue.sprintId.
 * In a closed sprint the entry stays unchanged (frozen).
 */
async function closeEntry(ctx: MutationCtx, issue: Doc<'issues'>, now: number, outcome?: SprintOutcome) {
  if (!issue.sprintId) return;
  const sprint = await ctx.db.get('sprints', issue.sprintId);
  if (sprint?.state === 'closed') return;
  const entry = await openEntry(ctx, issue._id, issue.sprintId);
  if (entry) await ctx.db.patch('sprintItems', entry._id, { removedAt: now, ...(outcome ? { outcome } : {}) });
}

/** Puts an issue into a sprint (removing it from its previous one). */
export async function attachIssue(
  ctx: MutationCtx,
  actor: Actor,
  issue: Doc<'issues'>,
  sprint: Doc<'sprints'>,
  opts: MoveOptions,
): Promise<boolean> {
  if (sprint.state === 'closed') {
    invalid(`Sprint ${sprint.number} is closed, nothing can be added to it.`, { sprintId: sprint._id });
  }
  if (issue.deletedAt !== undefined) invalid('The issue is in the trash.', { issueId: issue._id });
  if (issue.sprintId === sprint._id) return false;
  const previous = issue.sprintId;
  await closeEntry(ctx, issue, opts.now, opts.outcome);
  await ctx.db.insert('sprintItems', {
    sprintId: sprint._id,
    issueId: issue._id,
    kind: opts.kind ?? (sprint.state === 'planning' ? 'planned' : 'late'),
    ...(opts.carriedFrom ? { carriedFrom: opts.carriedFrom } : {}),
    addedAt: opts.now,
    addedBy: actor,
  });
  await ctx.db.patch('issues', issue._id, { sprintId: sprint._id, updatedAt: opts.now });
  if (opts.history !== false) {
    await record(ctx, actor, opts.now, opts.requestId, { issueId: issue._id, field: 'sprint', from: previous, to: sprint._id });
  }
  return true;
}

/** Takes an issue out of its sprint. */
export async function detachIssue(ctx: MutationCtx, actor: Actor, issue: Doc<'issues'>, opts: MoveOptions) {
  if (!issue.sprintId) return false;
  const previous = issue.sprintId;
  await closeEntry(ctx, issue, opts.now, opts.outcome);
  await ctx.db.patch('issues', issue._id, { sprintId: undefined, updatedAt: opts.now });
  if (opts.history !== false) {
    await record(ctx, actor, opts.now, opts.requestId, { issueId: issue._id, field: 'sprint', from: previous });
  }
  return true;
}

/**
 * For updateIssues: sets sprintId (null = take out). If the issue still points to a
 * closed sprint (e.g. reopened), null only clears issue.sprintId; the entry in the
 * closed sprint stays as it is.
 */
export async function setIssueSprint(
  ctx: MutationCtx,
  actor: Actor,
  issueId: Id<'issues'>,
  sprintId: Id<'sprints'> | null,
  now: number,
  requestId?: string,
) {
  const issue = await getIssue(ctx, issueId);
  if (sprintId === null) return await detachIssue(ctx, actor, issue, { now, requestId });
  return await attachIssue(ctx, actor, issue, await getSprint(ctx, sprintId), { now, requestId });
}

/** On delete (trash): take the issue out of a sprint that is not closed. */
export async function detachForTrash(ctx: MutationCtx, actor: Actor, issue: Doc<'issues'>, now: number, requestId?: string) {
  if (!issue.sprintId) return false;
  const sprint = await ctx.db.get('sprints', issue.sprintId);
  if (sprint && sprint.state === 'closed') return false;
  return await detachIssue(ctx, actor, issue, { now, requestId });
}

// ---------------------------------------------------------------- Sprints

/**
 * Suggested start of a new sprint: the day after the end of the last active or planned
 * sprint (no overlap). Without such sprints, or if that day is in the past: the next Monday.
 * Same rule in core (`defaultSprintRange`).
 */
export function suggestedStart(open: Pick<Doc<'sprints'>, 'endDate'>[], today: string) {
  const lastEnd = open.reduce<string | null>((max, sp) => (max === null || sp.endDate > max ? sp.endDate : max), null);
  const after = lastEnd ? addDays(lastEnd, 1) : null;
  return after && after >= today ? after : nextMonday(today);
}

async function openSprints(ctx: QueryCtx) {
  const [active, planning] = await Promise.all([
    ctx.db
      .query('sprints')
      .withIndex('by_state', (q) => q.eq('state', 'active'))
      .collect(),
    ctx.db
      .query('sprints')
      .withIndex('by_state', (q) => q.eq('state', 'planning'))
      .collect(),
  ]);
  return [...active, ...planning];
}

async function insertSprint(
  ctx: MutationCtx,
  fields: { name?: string; goal?: string; startDate?: string; endDate?: string; capacity?: number },
  now: number,
) {
  const number = await takeCounter(ctx, SPRINT);
  const startDate = fields.startDate ? checkDay(fields.startDate, 'The start date') : suggestedStart(await openSprints(ctx), berlinDay(now));
  const endDate = fields.endDate ? checkDay(fields.endDate, 'The end date') : addDays(startDate, DEFAULT_SPRINT_DAYS - 1);
  if (daysBetween(startDate, endDate) < 0) invalid('The end date is before the start date.');
  if (fields.capacity !== undefined && (!Number.isFinite(fields.capacity) || fields.capacity < 0)) {
    invalid('The capacity must be a number of 0 or more.');
  }
  const id = await ctx.db.insert('sprints', {
    number,
    name: fields.name ? checkName(fields.name, 'The sprint') : `Sprint ${number}`,
    goal: (fields.goal ?? '').trim(),
    startDate,
    endDate,
    state: 'planning',
    ...(fields.capacity !== undefined ? { capacity: fields.capacity } : {}),
    source: SPRINT_SOURCE,
    updatedAt: now,
  });
  return { id, number };
}

export interface CreateSprintArgs {
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  capacity?: number;
  requestId?: string;
}

/** New sprint in state planning. Default: 14 days from the day after the last open sprint, or from the next Monday. */
export async function createSprint(ctx: MutationCtx, actor: Actor, args: CreateSprintArgs) {
  return await idempotent(ctx, actor, args.requestId, 'sprints.create', { ...args }, async () => {
    if (args.goal && args.goal.length > 2000) invalid('The sprint goal is too long (at most 2000 characters).');
    return await insertSprint(ctx, args, Date.now());
  });
}

export interface UpdateSprintArgs {
  sprintId: Id<'sprints'>;
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  capacity?: number | null;
  retro?: string;
}

export async function updateSprint(ctx: MutationCtx, _actor: Actor, args: UpdateSprintArgs) {
  const sprint = await getSprint(ctx, args.sprintId);
  const patch: Partial<Doc<'sprints'>> = {};
  if (args.name !== undefined) patch.name = checkName(args.name, 'The sprint');
  if (args.goal !== undefined) {
    if (args.goal.length > 2000) invalid('The sprint goal is too long (at most 2000 characters).');
    patch.goal = args.goal.trim();
  }
  if (args.retro !== undefined) patch.retro = args.retro;
  if (args.startDate !== undefined || args.endDate !== undefined) {
    if (sprint.state === 'closed') invalid('The dates of a closed sprint can no longer be changed.');
    const startDate = args.startDate !== undefined ? checkDay(args.startDate, 'The start date') : sprint.startDate;
    const endDate = args.endDate !== undefined ? checkDay(args.endDate, 'The end date') : sprint.endDate;
    if (daysBetween(startDate, endDate) < 0) invalid('The end date is before the start date.');
    patch.startDate = startDate;
    patch.endDate = endDate;
  }
  if (args.capacity !== undefined) {
    if (args.capacity !== null && (!Number.isFinite(args.capacity) || args.capacity < 0)) {
      invalid('The capacity must be a number of 0 or more.');
    }
    patch.capacity = args.capacity ?? undefined;
  }
  await ctx.db.patch('sprints', sprint._id, { ...patch, updatedAt: Date.now() });
  return { sprintId: sprint._id };
}

export async function addToSprint(
  ctx: MutationCtx,
  actor: Actor,
  args: { sprintId: Id<'sprints'>; issueIds: Id<'issues'>[]; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'sprints.add', { ...args }, async () => {
    if (args.issueIds.length === 0 || args.issueIds.length > 500) invalid('Between 1 and 500 issues per call.');
    const sprint = await getSprint(ctx, args.sprintId);
    const now = Date.now();
    let added = 0;
    for (const issueId of new Set(args.issueIds)) {
      const issue = await getIssue(ctx, issueId);
      if (await attachIssue(ctx, actor, issue, sprint, { now, requestId: args.requestId })) added++;
    }
    return { added, kind: sprint.state === 'planning' ? ('planned' as const) : ('late' as const) };
  });
}

export async function removeFromSprint(
  ctx: MutationCtx,
  actor: Actor,
  args: { sprintId: Id<'sprints'>; issueIds: Id<'issues'>[]; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'sprints.remove', { ...args }, async () => {
    if (args.issueIds.length === 0 || args.issueIds.length > 500) invalid('Between 1 and 500 issues per call.');
    const sprint = await getSprint(ctx, args.sprintId);
    if (sprint.state === 'closed') invalid(`Sprint ${sprint.number} is closed, its entries stay unchanged.`);
    const now = Date.now();
    let removed = 0;
    for (const issueId of new Set(args.issueIds)) {
      const issue = await getIssue(ctx, issueId, { allowDeleted: true });
      if (issue.sprintId !== sprint._id) continue;
      if (await detachIssue(ctx, actor, issue, { now, requestId: args.requestId })) removed++;
    }
    return { removed };
  });
}

/**
 * Starts a sprint (only from planning, at most one active sprint). If the planned start is in
 * the future, it starts today and keeps its planned end (`moved`). If the planned end already
 * lies in the past, the sprint would start overdue: it starts today and keeps its length instead.
 */
export async function startSprint(ctx: MutationCtx, _actor: Actor, args: { sprintId: Id<'sprints'> }) {
  const sprint = await getSprint(ctx, args.sprintId);
  if (sprint.state !== 'planning') {
    invalid(sprint.state === 'active' ? `Sprint ${sprint.number} is already active.` : `Sprint ${sprint.number} is closed.`);
  }
  const active = await ctx.db
    .query('sprints')
    .withIndex('by_state', (q) => q.eq('state', 'active'))
    .first();
  if (active) {
    fail('conflict', `${active.name} (sprint ${active.number}) is already active. Close it first, then start this one.`, {
      activeSprintId: active._id,
    });
  }
  const now = Date.now();
  const today = berlinDay(now);
  const early = sprint.startDate > today;
  const overdue = sprint.endDate < today;
  const range = early
    ? { startDate: today, endDate: sprint.endDate }
    : overdue
      ? { startDate: today, endDate: addDays(today, daysBetween(sprint.startDate, sprint.endDate)) }
      : null;
  await ctx.db.patch('sprints', sprint._id, { state: 'active', startedAt: now, updatedAt: now, ...(range ?? {}) });
  return { sprintId: sprint._id, startedAt: now, moved: range };
}

export interface CloseSprintArgs {
  sprintId: Id<'sprints'>;
  decisions: SprintDecision[];
  nextSprintId?: Id<'sprints'>;
  requestId?: string;
}

/**
 * Closes the active sprint. Every open issue needs a decision: 'next' (into the given or a
 * newly created sprint, there as 'planned' with carriedFrom), 'backlog' (taken out) or
 * 'canceled' (status canceled). Done or canceled issues get 'done' or 'canceled' and stay
 * in the closed sprint. If it closes before its planned end, the end is set to today
 * (`endedEarly`); a newly created follow-up sprint then starts tomorrow.
 */
export async function closeSprint(ctx: MutationCtx, actor: Actor, args: CloseSprintArgs) {
  return await idempotent(ctx, actor, args.requestId, 'sprints.close', { ...args }, async () => {
    const sprint = await getSprint(ctx, args.sprintId);
    if (sprint.state !== 'active') {
      invalid(
        sprint.state === 'planning'
          ? `Sprint ${sprint.number} was never started and cannot be closed.`
          : `Sprint ${sprint.number} is already closed.`,
      );
    }
    const now = Date.now();
    const today = berlinDay(now);
    // Closed early: end today (before creating a follow-up sprint, so that one starts after it).
    const endedEarly = sprint.endDate > today && sprint.startDate <= today ? today : null;
    if (endedEarly) await ctx.db.patch('sprints', sprint._id, { endDate: endedEarly });
    const identifier = teamKeys(ctx);
    const entries = (
      await ctx.db
        .query('sprintItems')
        .withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id))
        .collect()
    ).filter((e) => e.removedAt === undefined);

    const decisions = new Map<Id<'issues'>, SprintDecision['outcome']>();
    for (const decision of args.decisions) {
      if (decisions.has(decision.issueId)) invalid('An issue has more than one decision.', { issueId: decision.issueId });
      decisions.set(decision.issueId, decision.outcome);
    }

    const issues: Doc<'issues'>[] = [];
    for (const entry of entries) {
      const issue = await ctx.db.get('issues', entry.issueId);
      if (issue && issue.sprintId === sprint._id) issues.push(issue);
    }
    const inSprint = new Set(issues.map((i) => i._id));
    for (const issueId of decisions.keys()) {
      if (!inSprint.has(issueId)) invalid('A decision refers to an issue that is not in this sprint.', { issueId });
    }
    const open = issues.filter((i) => isOpen(i.status) && i.deletedAt === undefined);
    const missing = open.filter((i) => !decisions.has(i._id));
    if (missing.length > 0) {
      const names = await Promise.all(missing.slice(0, 10).map(identifier));
      invalid(
        `${missing.length} open issues need a decision (next sprint, backlog or cancel): ${names.join(', ')}${missing.length > 10 ? ' …' : ''}.`,
        { missing: missing.map((i) => i._id) },
      );
    }

    let next: Doc<'sprints'> | null = null;
    const needsNext = open.some((i) => decisions.get(i._id) === 'next');
    if (args.nextSprintId) {
      next = await getSprint(ctx, args.nextSprintId);
      if (next._id === sprint._id) invalid('The next sprint must be a different one.');
      if (next.state !== 'planning') invalid(`Sprint ${next.number} is not in planning.`);
    } else if (needsNext) {
      const created = await insertSprint(ctx, {}, now);
      next = await ctx.db.get('sprints', created.id);
    }

    const counts = { done: 0, next: 0, backlog: 0, canceled: 0 };
    for (const issue of issues) {
      // Record the points at close: the entry never changes afterwards.
      const entry = await openEntry(ctx, issue._id, sprint._id);
      if (entry && issue.estimate !== undefined) await ctx.db.patch('sprintItems', entry._id, { points: issue.estimate });
      if (!isOpen(issue.status) || issue.deletedAt !== undefined) {
        // Done or canceled: stays in the closed sprint.
        const outcome: SprintOutcome = issue.status === 'done' ? 'done' : 'canceled';
        if (entry) await ctx.db.patch('sprintItems', entry._id, { outcome });
        counts[outcome]++;
        continue;
      }
      const outcome = decisions.get(issue._id)!;
      if (outcome === 'next') {
        await attachIssue(ctx, actor, issue, next!, {
          now,
          requestId: args.requestId,
          kind: 'planned',
          carriedFrom: sprint._id,
          outcome: 'next',
        });
      } else if (outcome === 'backlog') {
        await detachIssue(ctx, actor, issue, { now, requestId: args.requestId, outcome: 'backlog' });
      } else {
        await detachIssue(ctx, actor, issue, { now, requestId: args.requestId, outcome: 'canceled' });
        await applyPatch(ctx, actor, issue._id, { status: 'canceled' }, undefined, now, args.requestId);
      }
      counts[outcome]++;
    }
    await ctx.db.patch('sprints', sprint._id, { state: 'closed', closedAt: now, updatedAt: now });
    return { sprintId: sprint._id, nextSprintId: next?._id ?? null, counts, endedEarly };
  });
}

/**
 * Most recently closed sprints of a source, newest first (by closedAt). 'selfbound' also reads the
 * legacy source value, so the result is the same before and after the data migration.
 */
export async function recentClosedSprints(ctx: QueryCtx, source: 'selfbound' | 'linear', count: number) {
  if (count <= 0) return [];
  const recent = async (value: Doc<'sprints'>['source']) =>
    await ctx.db
      .query('sprints')
      .withIndex('by_source_state_closed', (q) => q.eq('source', value).eq('state', 'closed'))
      .order('desc')
      .take(count);
  if (source === 'linear') return await recent('linear');
  const both = [...(await recent(SPRINT_SOURCE)), ...(await recent(LEGACY_SPRINT_SOURCE))];
  return both.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, count);
}

/**
 * Suggested capacity: average of the done points of the last 3 closed Selfbound sprints.
 * Counts every entry with outcome 'done' with the points recorded at close (older
 * entries without `points`: the current estimate).
 */
export async function capacitySuggestion(ctx: QueryCtx) {
  const recent = await recentClosedSprints(ctx, 'selfbound', 3);
  const basis = [];
  for (const sprint of recent) {
    const entries = await ctx.db
      .query('sprintItems')
      .withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id))
      .collect();
    let donePoints = 0;
    for (const entry of entries) {
      if (entry.outcome !== 'done') continue;
      donePoints += entry.points ?? (await ctx.db.get('issues', entry.issueId))?.estimate ?? 0;
    }
    basis.push({ sprintId: sprint._id, number: sprint.number, name: sprint.name, donePoints });
  }
  const capacity =
    basis.length === 0 ? null : Math.round((basis.reduce((sum, s) => sum + s.donePoints, 0) / basis.length) * 10) / 10;
  return { capacity, basis };
}

/**
 * Checks the sprint invariant for ONE sprint (entries and issues via indexes).
 * Open sprints: entry without removedAt ⇔ issue.sprintId. Closed sprints are frozen:
 * every entry without removedAt needs an outcome, and every issue that still points to
 * the sprint needs such an entry. The issue itself may have moved on or been purged.
 */
export async function auditSprint(ctx: QueryCtx, sprint: Doc<'sprints'>) {
  const problems: string[] = [];
  const entries = await ctx.db
    .query('sprintItems')
    .withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id))
    .collect();
  const closed = sprint.state === 'closed';
  const seen = new Set<string>();
  for (const entry of entries.filter((e) => e.removedAt === undefined)) {
    if (seen.has(entry.issueId)) problems.push(`Sprint ${sprint.number}: issue ${entry.issueId} has more than one open entry`);
    seen.add(entry.issueId);
    if (closed) {
      if (!entry.outcome) problems.push(`Sprint ${sprint.number}: closed, but entry without outcome (${entry.issueId})`);
      continue;
    }
    const issue = await ctx.db.get('issues', entry.issueId);
    if (!issue) problems.push(`Sprint ${sprint.number}: entry points to deleted issue ${entry.issueId}`);
    else if (issue.sprintId !== sprint._id) {
      problems.push(`Sprint ${sprint.number}: open entry, but issue.sprintId = ${issue.sprintId ?? 'empty'} (${issue._id})`);
    }
  }
  const members = await ctx.db
    .query('issues')
    .withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id))
    .collect();
  for (const issue of members) {
    if (!seen.has(issue._id)) problems.push(`Sprint ${sprint.number}: issue.sprintId set, but no open entry (${issue._id})`);
  }
  return { problems, items: entries.length };
}

/** Sprints checked per page of the nightly audit (one query). */
export const AUDIT_PAGE = 10;

export interface AuditTotals {
  problems: string[];
  sprints: number;
  items: number;
  active: number;
}

/**
 * One page of the audit: up to AUDIT_PAGE sprints with number > `after`. Linear sprints
 * (imported, closed, entries owned by the import) are skipped.
 * No `paginate`, so several pages may run in one function (tests).
 */
export async function auditSprintPage(ctx: QueryCtx, after: number | null) {
  const page = await ctx.db
    .query('sprints')
    .withIndex('by_number', (q) => (after === null ? q : q.gt('number', after)))
    .take(AUDIT_PAGE);
  const totals: AuditTotals = { problems: [], sprints: 0, items: 0, active: 0 };
  for (const sprint of page) {
    if (sprint.source === 'linear') continue;
    totals.sprints++;
    if (sprint.state === 'active') totals.active++;
    const result = await auditSprint(ctx, sprint);
    totals.problems.push(...result.problems.slice(0, 100));
    totals.items += result.items;
  }
  return { ...totals, isDone: page.length < AUDIT_PAGE, last: page.at(-1)?.number ?? after };
}

export function addAuditTotals(acc: AuditTotals, page: AuditTotals) {
  acc.problems.push(...page.problems.slice(0, Math.max(0, 200 - acc.problems.length)));
  acc.sprints += page.sprints;
  acc.items += page.items;
  acc.active += page.active;
}

export function auditResult(acc: AuditTotals) {
  const problems = acc.active > 1 ? [`More than one active sprint (${acc.active})`, ...acc.problems] : acc.problems;
  return { ok: problems.length === 0, problems: problems.slice(0, 100), sprints: acc.sprints, items: acc.items };
}

/** Full audit in one call (tests). The cron goes page by page (maintenance.auditSprints). */
export async function auditSprints(ctx: QueryCtx) {
  const acc: AuditTotals = { problems: [], sprints: 0, items: 0, active: 0 };
  let after: number | null = null;
  for (;;) {
    const page = await auditSprintPage(ctx, after);
    addAuditTotals(acc, page);
    if (page.isDone) break;
    after = page.last;
  }
  return auditResult(acc);
}

// ---------------------------------------------------------------- Import from Linear

export interface ImportedSprintFields {
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  startedAt: number;
  closedAt: number;
}

/**
 * A Linear cycle as a closed sprint (`source: 'linear'`). New: number from the shared
 * counter. Existing: only Linear sprints are updated, never Selfbound sprints.
 */
export async function upsertImportedSprint(
  ctx: MutationCtx,
  existing: Doc<'sprints'> | null,
  fields: ImportedSprintFields,
  now: number,
): Promise<{ sprintId: Id<'sprints'>; changed: boolean }> {
  if (existing) {
    if (existing.source !== 'linear') return { sprintId: existing._id, changed: false };
    const patch: Partial<Doc<'sprints'>> = {};
    for (const key of Object.keys(fields) as (keyof ImportedSprintFields)[]) {
      if (existing[key] !== fields[key]) (patch as Record<string, unknown>)[key] = fields[key];
    }
    if (Object.keys(patch).length === 0) return { sprintId: existing._id, changed: false };
    await ctx.db.patch('sprints', existing._id, { ...patch, updatedAt: now });
    return { sprintId: existing._id, changed: true };
  }
  const number = await takeCounter(ctx, SPRINT);
  const sprintId = await ctx.db.insert('sprints', {
    number,
    ...fields,
    state: 'closed',
    source: 'linear',
    updatedAt: now,
  });
  return { sprintId, changed: true };
}

/**
 * "Imported" entry for an issue in a closed Linear sprint.
 * `issue.sprintId` stays untouched (the sprint is closed), so the entry has
 * `removedAt` = end of the sprint: the invariant still holds.
 * If the entry exists, only its outcome is aligned.
 */
export async function setImportedSprintItem(
  ctx: MutationCtx,
  issueId: Id<'issues'>,
  sprint: Doc<'sprints'>,
  outcome: SprintOutcome,
  now: number,
) {
  if (sprint.state !== 'closed' || sprint.source !== 'linear') {
    invalid('Imported entries exist only for closed Linear sprints.');
  }
  const entries = await ctx.db
    .query('sprintItems')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .collect();
  const entry = entries.find((e) => e.sprintId === sprint._id && e.kind === 'imported');
  if (entry) {
    if (entry.outcome !== outcome) await ctx.db.patch('sprintItems', entry._id, { outcome });
    return false;
  }
  await ctx.db.insert('sprintItems', {
    sprintId: sprint._id,
    issueId,
    kind: 'imported',
    addedAt: sprint.startedAt ?? now,
    addedBy: { kind: 'import' },
    removedAt: sprint.closedAt ?? now,
    outcome,
  });
  return true;
}
