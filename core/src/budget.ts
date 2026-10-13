// Priority budget: at most 1 urgent and 3 high open issues per team. Only a hint, not a ban;
// the same rule as `budget_warning` in the backend. Pure calculations, testable.
import { OPEN_STATUSES, PRIORITY_BUDGET } from '@xlr8/backend/constants';
import { t } from './i18n.ts';
import type { Issue, IssueId, Status } from './types.ts';

const OPEN = new Set<Status>(OPEN_STATUSES);

export interface TeamBudget {
  urgent: number;
  high: number;
}

/** Open urgent/high issues per team (like the backend: all open statuses, trash excluded). */
export function priorityBudget(all: Iterable<Issue>): Map<string, TeamBudget> {
  const out = new Map<string, TeamBudget>();
  for (const issue of all) {
    if ((issue.priority !== 1 && issue.priority !== 2) || issue.deletedAt !== undefined || issue.pending || !OPEN.has(issue.status)) continue;
    let b = out.get(issue.teamId);
    if (!b) out.set(issue.teamId, (b = { urgent: 0, high: 0 }));
    if (issue.priority === 1) b.urgent++;
    else b.high++;
  }
  return out;
}

/** "Urgent 1/1 · High 4/3" */
export function budgetLabel(b: TeamBudget | undefined) {
  return t('Urgent {urgent}/{urgentMax} · High {high}/{highMax}', { urgent: b?.urgent ?? 0, urgentMax: PRIORITY_BUDGET[1], high: b?.high ?? 0, highMax: PRIORITY_BUDGET[2] });
}

export function overBudget(b: TeamBudget | undefined) {
  return (b?.urgent ?? 0) > PRIORITY_BUDGET[1] || (b?.high ?? 0) > PRIORITY_BUDGET[2];
}

export interface BudgetHit {
  teamId: string;
  priority: 1 | 2;
  /** Open afterwards */
  open: number;
  budget: number;
  /** Previous candidates (without the ones just changed), most recent first */
  previous: Issue[];
  /** The ones just set */
  changed: IssueId[];
}

/**
 * Is the budget exceeded if `ids` get priority `priority`?
 * Computed on the state BEFORE the change (the change itself is added).
 */
export function budgetCheck(all: Iterable<Issue>, ids: readonly IssueId[], priority: number): BudgetHit[] {
  if (priority !== 1 && priority !== 2) return [];
  const p = priority as 1 | 2;
  const changing = new Set(ids);
  const byTeam = new Map<string, { previous: Issue[]; changed: IssueId[] }>();
  const issues = [...all];
  for (const issue of issues) {
    if (!changing.has(issue._id) || issue.deletedAt !== undefined || !OPEN.has(issue.status) || issue.priority === p) continue;
    let entry = byTeam.get(issue.teamId);
    if (!entry) byTeam.set(issue.teamId, (entry = { previous: [], changed: [] }));
    entry.changed.push(issue._id);
  }
  if (byTeam.size === 0) return [];
  for (const issue of issues) {
    const entry = byTeam.get(issue.teamId);
    if (!entry || issue.priority !== p || issue.deletedAt !== undefined || issue.pending || !OPEN.has(issue.status) || changing.has(issue._id)) continue;
    entry.previous.push(issue);
  }
  const hits: BudgetHit[] = [];
  for (const [teamId, entry] of byTeam) {
    const open = entry.previous.length + entry.changed.length;
    if (open > PRIORITY_BUDGET[p]) {
      entry.previous.sort((a, b) => b.updatedAt - a.updatedAt);
      hits.push({ teamId, priority: p, open, budget: PRIORITY_BUDGET[p], previous: entry.previous, changed: entry.changed });
    }
  }
  return hits;
}

