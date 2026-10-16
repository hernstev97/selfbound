// Priority limits per team (XLR8-91): at most `max` open urgent/high issues, set for the instance
// (meta.priorityLimits). Soft limits warn, hard ones block; the same rule as `budget_warning` and
// `priority_limit` in the backend. Pure calculations, testable.
import { OPEN_STATUSES } from '@selfbound/backend/constants';
import { DEFAULT_PRIORITY_LIMITS, limitFor, overLimit, type PriorityLimits } from '@selfbound/backend/shared/priorityLimits';
import { PRIORITY_LABEL } from './format.ts';
import { t } from './i18n.ts';
import type { Issue, IssueId, Status } from './types.ts';

export type { PriorityLimits } from '@selfbound/backend/shared/priorityLimits';
export { DEFAULT_PRIORITY_LIMITS } from '@selfbound/backend/shared/priorityLimits';

const OPEN = new Set<Status>(OPEN_STATUSES);

/** The limits in effect (an old cache without the field: the defaults). */
export function limitsOf(meta: { priorityLimits?: PriorityLimits } | null | undefined): PriorityLimits {
  return meta?.priorityLimits ?? DEFAULT_PRIORITY_LIMITS;
}

export interface TeamBudget {
  urgent: number;
  high: number;
}

const counts = (issue: Issue) => issue.deletedAt === undefined && !issue.pending && OPEN.has(issue.status);

/** Open urgent/high issues per team (like the backend: all open statuses, trash excluded). */
export function priorityBudget(all: Iterable<Issue>): Map<string, TeamBudget> {
  const out = new Map<string, TeamBudget>();
  for (const issue of all) {
    if ((issue.priority !== 1 && issue.priority !== 2) || !counts(issue)) continue;
    let b = out.get(issue.teamId);
    if (!b) out.set(issue.teamId, (b = { urgent: 0, high: 0 }));
    if (issue.priority === 1) b.urgent++;
    else b.high++;
  }
  return out;
}

/** "Urgent 1/1 · High 4/3"; without a limit only the count ("High 4"). */
export function budgetLabel(b: TeamBudget | undefined, limits: PriorityLimits = DEFAULT_PRIORITY_LIMITS) {
  const urgent = b?.urgent ?? 0;
  const high = b?.high ?? 0;
  const { urgent: u, high: h } = limits;
  return [
    u.max === null ? t('Urgent {count}', { count: urgent }) : t('Urgent {count}/{max}', { count: urgent, max: u.max }),
    h.max === null ? t('High {count}', { count: high }) : t('High {count}/{max}', { count: high, max: h.max }),
  ].join(' · ');
}

export function overBudget(b: TeamBudget | undefined, limits: PriorityLimits = DEFAULT_PRIORITY_LIMITS) {
  return overLimit(limits.urgent, b?.urgent ?? 0) || overLimit(limits.high, b?.high ?? 0);
}

/** Tooltip: what the limits are. */
export function limitsSummary(limits: PriorityLimits = DEFAULT_PRIORITY_LIMITS) {
  const part = (max: number | null, hard: boolean, name: string) =>
    max === null ? t('{priority}: no limit', { priority: name }) : hard ? t('{priority}: at most {max}, blocks', { priority: name, max }) : t('{priority}: at most {max}, warns', { priority: name, max });
  return t('Priority limits per team (open issues). {urgent} · {high}', {
    urgent: part(limits.urgent.max, limits.urgent.hard, PRIORITY_LABEL[1]),
    high: part(limits.high.max, limits.high.hard, PRIORITY_LABEL[2]),
  });
}

export interface BudgetHit {
  teamId: string;
  priority: 1 | 2;
  /** Open afterwards */
  open: number;
  budget: number;
  /** A hard limit: the change must not happen. */
  hard: boolean;
  /** Previous candidates (without the ones just changed), most recent first */
  previous: Issue[];
  /** The ones just set */
  changed: IssueId[];
}

/**
 * Would `incoming` (issues that newly count toward `priority` in the given team) go over a limit?
 * Computed on the state BEFORE the change (the change itself is added).
 */
export function limitHits(all: Iterable<Issue>, incoming: readonly { id: IssueId; teamId: string }[], priority: number, limits: PriorityLimits = DEFAULT_PRIORITY_LIMITS): BudgetHit[] {
  const limit = limitFor(limits, priority);
  if (limit?.max == null || incoming.length === 0) return [];
  const p = priority as 1 | 2;
  const changing = new Set(incoming.map((i) => i.id));
  const byTeam = new Map<string, { previous: Issue[]; changed: IssueId[] }>();
  for (const { id, teamId } of incoming) {
    let entry = byTeam.get(teamId);
    if (!entry) byTeam.set(teamId, (entry = { previous: [], changed: [] }));
    entry.changed.push(id);
  }
  for (const issue of all) {
    const entry = byTeam.get(issue.teamId);
    if (!entry || issue.priority !== p || !counts(issue) || changing.has(issue._id)) continue;
    entry.previous.push(issue);
  }
  const hits: BudgetHit[] = [];
  for (const [teamId, entry] of byTeam) {
    const open = entry.previous.length + entry.changed.length;
    if (overLimit(limit, open)) {
      entry.previous.sort((a, b) => b.updatedAt - a.updatedAt);
      hits.push({ teamId, priority: p, open, budget: limit.max, hard: limit.hard, previous: entry.previous, changed: entry.changed });
    }
  }
  return hits;
}

/**
 * Is a limit exceeded if `ids` get priority `priority`? Issues that already have it, closed and
 * deleted ones do not count as a change.
 */
export function budgetCheck(all: Iterable<Issue>, ids: readonly IssueId[], priority: number, limits: PriorityLimits = DEFAULT_PRIORITY_LIMITS): BudgetHit[] {
  if (priority !== 1 && priority !== 2) return [];
  const changing = new Set(ids);
  const issues = [...all];
  const incoming = issues.filter((i) => changing.has(i._id) && i.deletedAt === undefined && OPEN.has(i.status) && i.priority !== priority).map((i) => ({ id: i._id, teamId: i.teamId }));
  return limitHits(issues, incoming, priority, limits);
}
