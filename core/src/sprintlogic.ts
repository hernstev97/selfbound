// Pure sprint calculations (no Convex, no DOM, testable). The priority budget lives in budget.ts
// (part of the start bundle; sprints are loaded lazily).
export { budgetCheck, budgetLabel, limitHits, limitsOf, limitsSummary, overBudget, priorityBudget, type BudgetHit, type TeamBudget } from './budget.ts';
import { OPEN_STATUSES } from '@selfbound/backend/constants';
import { addDays, daysBetween, parseDay, shortDate, today } from './format.ts';
import { locale, t, tn } from './i18n.ts';
import type { Issue, IssueId, SprintDoc, SprintItemKind, Status } from './types.ts';

const OPEN = new Set<Status>(OPEN_STATUSES);
export const isOpenStatus = (s: Status) => OPEN.has(s);

/** Entry from `sprints.items` (null instead of missing). */
export interface SprintItem {
  _id: string;
  issueId: IssueId;
  kind: SprintItemKind;
  carriedFrom: string | null;
  addedAt: number;
  removedAt: number | null;
  outcome: 'done' | 'next' | 'backlog' | 'canceled' | null;
}

export { OUTCOME_LABEL, type Outcome } from './format.ts';
import type { Outcome } from './format.ts';

// ---------------------------------------------------------------- Date range

/** Next Monday after `day` (a week later if `day` is a Monday), same as the backend. */
export function nextMonday(day = today()) {
  const weekday = parseDay(day).getDay();
  return addDays(day, ((8 - weekday) % 7) || 7);
}

/**
 * Default for a new sprint: 14 days from the day after the last active or planned sprint (`open`)
 * ends, so nothing overlaps; without one (or if that day is in the past) from next Monday. Same
 * rule as `suggestedStart` in the backend.
 */
export function defaultSprintRange(day = today(), open: readonly { endDate: string }[] = []) {
  const lastEnd = open.reduce<string | null>((max, s) => (max === null || s.endDate > max ? s.endDate : max), null);
  const after = lastEnd ? addDays(lastEnd, 1) : null;
  const start = after && after >= day ? after : nextMonday(day);
  return { startDate: start, endDate: addDays(start, 13) };
}

/** "Oct 6 – Oct 19" */
export function rangeLabel(start: string, end: string, now = Date.now()) {
  return `${shortDate(parseDay(start).getTime(), now)} – ${shortDate(parseDay(end).getTime(), now)}`;
}

/** "4 days left", "last day", "ended 2 days ago", "starts in 3 days". */
export function remainingLabel(sprint: Pick<SprintDoc, 'startDate' | 'endDate' | 'state'>, day = today()) {
  if (sprint.state === 'closed') return t('completed');
  const toStart = daysBetween(day, sprint.startDate);
  if (sprint.state === 'planning') return toStart > 0 ? tn(toStart, 'starts in {count} day', 'starts in {count} days') : t('in planning');
  const left = daysBetween(day, sprint.endDate);
  if (left >= 1) return tn(left + 1, '{count} day left', '{count} days left');
  if (left === 0) return t('last day');
  return tn(-left, 'ended {count} day ago', 'ended {count} days ago');
}

// ---------------------------------------------------------------- Points

export interface SprintTotals {
  issues: number;
  done: number;
  open: number;
  points: number;
  donePoints: number;
  planned: number;
  late: number;
  /** Share added later, in percent (integer) */
  lateShare: number;
  /** Issues without an estimate */
  unestimated: number;
}

/** Totals over the issues of an active or planned sprint. */
export function sprintTotals(issues: Iterable<Issue>, kinds: ReadonlyMap<IssueId, SprintItemKind> = new Map()): SprintTotals {
  const t: SprintTotals = { issues: 0, done: 0, open: 0, points: 0, donePoints: 0, planned: 0, late: 0, lateShare: 0, unestimated: 0 };
  for (const issue of issues) {
    t.issues++;
    const points = issue.estimate ?? 0;
    if (issue.estimate === undefined) t.unestimated++;
    t.points += points;
    if (issue.status === 'done') {
      t.done++;
      t.donePoints += points;
    } else if (isOpenStatus(issue.status)) t.open++;
    if (kinds.get(issue._id) === 'late') t.late++;
    else t.planned++;
  }
  t.lateShare = t.issues ? Math.round((t.late / t.issues) * 100) : 0;
  return t;
}

export interface SprintStats {
  issues: number;
  points: number;
  donePoints: number;
  late: number;
  lateShare: number;
  carried: number;
}

/**
 * Sprint figures from its entries (also completed and imported sprints): counts what belonged to
 * it at the end (not removed, or with an outcome). Done = outcome `done`, or (no outcome yet)
 * status done.
 */
export function sprintStats(items: readonly SprintItem[], get: (id: IssueId) => Issue | undefined): SprintStats {
  const s: SprintStats = { issues: 0, points: 0, donePoints: 0, late: 0, lateShare: 0, carried: 0 };
  for (const item of items) {
    if (item.removedAt !== null && item.outcome === null) continue;
    const issue = get(item.issueId);
    const points = issue?.estimate ?? 0;
    s.issues++;
    s.points += points;
    const done = item.outcome === 'done' || (item.outcome === null && issue?.status === 'done');
    if (done) s.donePoints += points;
    if (item.kind === 'late') s.late++;
    if (item.carriedFrom) s.carried++;
  }
  s.lateShare = s.issues ? Math.round((s.late / s.issues) * 100) : 0;
  return s;
}

/** Points as text: integers without decimals, otherwise one decimal ("2.5", German "2,5"). */
export function points(n: number) {
  if (Number.isInteger(n)) return String(n);
  const text = n.toFixed(1);
  return locale() === 'de' ? text.replace('.', ',') : text;
}

// ---------------------------------------------------------------- Completion

export interface CloseSummary {
  open: number;
  decided: number;
  missing: number;
  counts: Record<Outcome, number>;
  done: number;
  donePoints: number;
  canceled: number;
}

/** State of the decisions when completing a sprint. */
export function closeSummary(issues: Iterable<Issue>, decisions: ReadonlyMap<IssueId, Outcome>): CloseSummary {
  const s: CloseSummary = { open: 0, decided: 0, missing: 0, counts: { next: 0, backlog: 0, canceled: 0 }, done: 0, donePoints: 0, canceled: 0 };
  for (const issue of issues) {
    if (issue.deletedAt !== undefined) continue;
    if (isOpenStatus(issue.status)) {
      s.open++;
      const d = decisions.get(issue._id);
      if (d) {
        s.decided++;
        s.counts[d]++;
      } else s.missing++;
    } else if (issue.status === 'done') {
      s.done++;
      s.donePoints += issue.estimate ?? 0;
    } else s.canceled++;
  }
  return s;
}

/** Places a drop while dragging: neighbours before/after the insertion point (excluding the dragged ones). */
export function dropNeighbors(order: readonly IssueId[], dragged: readonly IssueId[], index: number): { beforeId?: IssueId; afterId?: IssueId } {
  const moving = new Set(dragged);
  let before: IssueId | undefined;
  let after: IssueId | undefined;
  for (let i = index - 1; i >= 0; i--) {
    if (!moving.has(order[i])) {
      before = order[i];
      break;
    }
  }
  for (let i = index; i < order.length; i++) {
    if (!moving.has(order[i])) {
      after = order[i];
      break;
    }
  }
  return { ...(before ? { beforeId: before } : {}), ...(after ? { afterId: after } : {}) };
}
