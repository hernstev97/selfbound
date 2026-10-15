// Board: columns from the teams' statuses, synchronous in memory like the list.
// One column per status; across teams, the same type and name form one column.
// Done and canceled columns are collapsed by default (speed: fewer cards to render).
import { PRIORITY_GROUP_ORDER, PRIORITY_LABEL } from './format.ts';
import { hasFilters } from './query.ts';
import { VIEWS } from './views.ts';
import { stateGroupKey, workflowsOf, type StateGroup } from './workflow.ts';
import type { BoardColumn, BoardState, Issue, IssueId, Meta, Priority, ViewState } from './types.ts';

/**
 * Cards grow with their title (never cut off). Windowing per column uses measured heights and this
 * estimate (a one-to-two-line card) for cards not shown yet; `CARD_GAP` sits below each card.
 */
export const CARD_ESTIMATE = 112;
export const CARD_GAP = 8;

const CLOSED_TYPES = new Set(['completed', 'canceled']);

/** Collapsed by default? (done and canceled columns) */
export function collapsedByDefault(type: string) {
  return CLOSED_TYPES.has(type);
}

/**
 * Saved deviations from the default: `b+:<key>` = expanded (a column collapsed by default),
 * `b-:<key>` = collapsed (a column open by default).
 */
export function isCollapsed(type: string, key: string, toggled: ReadonlySet<string>) {
  return collapsedByDefault(type) ? !toggled.has(`b+:${key}`) : toggled.has(`b-:${key}`);
}

/** The column an issue belongs to: its status group, or its priority on a priority board. */
export function boardKeyOf(issue: Issue, view: ViewState, meta: Meta | null) {
  return view.display.boardColumns === 'priority' ? priorityKey(issue.priority) : stateGroupKey(workflowsOf(meta).of(issue));
}

const priorityKey = (priority: Priority) => `p:${priority}`;

/** Priority board: always all five columns (they are the drop targets), none collapsed by default. */
function computePriorityBoard(visible: readonly Issue[], view: ViewState, toggled: ReadonlySet<string>): BoardState {
  const byPriority = new Map<Priority, IssueId[]>(PRIORITY_GROUP_ORDER.map((p) => [p, []]));
  for (const issue of visible) byPriority.get(issue.priority)?.push(issue._id);
  const columns: BoardColumn[] = PRIORITY_GROUP_ORDER.map((p) => {
    const key = priorityKey(p);
    return { key, label: PRIORITY_LABEL[p], status: 'todo', type: 'unstarted', color: null, priority: p, ids: byPriority.get(p)!, collapsed: toggled.has(`b-:${key}`) };
  });
  return { columns, count: visible.length, empty: visible.length > 0 ? null : hasFilters(view) ? 'filtered' : 'none' };
}

/** Teams whose statuses appear as columns: the view's team, the project's team, or all active ones. */
export function boardTeams(view: ViewState, meta: Meta | null, visible: readonly Issue[]): string[] {
  const route = view.route;
  if (route.team) {
    const team = meta?.teams.find((t) => t.key === route.team);
    return team ? [team._id] : [];
  }
  if (route.kind === 'project') {
    const project = meta?.projects.find((p) => p._id === route.project);
    if (project) return [project.teamId];
  }
  const teams = new Set<string>(meta?.teams.filter((t) => !t.dormant && t.wiki !== 'only').map((t) => t._id) ?? []);
  for (const issue of visible) teams.add(issue.teamId);
  return [...teams];
}

/**
 * Columns of the board. `visible` is already filtered and sorted (the view's order applies in every
 * column). Empty columns appear only for the view's types (`boardTypes`); done and canceled ones
 * only if the view shows them or they have issues.
 */
export function computeBoard(visible: readonly Issue[], view: ViewState, meta: Meta | null, toggled: ReadonlySet<string>): BoardState {
  if (view.display.boardColumns === 'priority') return computePriorityBoard(visible, view, toggled);
  const def = VIEWS[view.route.kind];
  const workflows = workflowsOf(meta);
  const byKey = new Map<string, IssueId[]>();
  for (const issue of visible) {
    const key = stateGroupKey(workflows.of(issue));
    let ids = byKey.get(key);
    if (!ids) byKey.set(key, (ids = []));
    ids.push(issue._id);
  }
  const types = new Set(def.boardTypes ?? []);
  const showClosed = !def.closedOption || view.display.showClosed;
  const groups: StateGroup[] = workflows.groups(boardTeams(view, meta, visible));
  const columns: BoardColumn[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const ids = byKey.get(g.key) ?? [];
    seen.add(g.key);
    const wanted = ids.length > 0 || (types.has(g.type) && (showClosed || !CLOSED_TYPES.has(g.type)));
    if (!wanted) continue;
    columns.push({ key: g.key, label: g.name, status: g.status, type: g.type, color: g.color, ids, collapsed: isCollapsed(g.type, g.key, toggled) });
  }
  // Issues in statuses that do not exist (any more) in the view's teams (e.g. archived): own column at the end.
  for (const [key, ids] of byKey) {
    if (seen.has(key)) continue;
    const view0 = workflows.of(visible.find((i) => i._id === ids[0])!);
    columns.push({ key, label: view0.name, status: view0.status, type: view0.type, color: view0.color, ids, collapsed: isCollapsed(view0.type, key, toggled) });
  }
  return { columns, count: visible.length, empty: visible.length > 0 ? null : hasFilters(view) ? 'filtered' : 'none' };
}

function sameIds(a: readonly IssueId[], b: readonly IssueId[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Keeps unchanged columns (and the whole board) so Svelte only re-renders what changed. */
export function reuseBoard(prev: BoardState | null, next: BoardState): BoardState {
  if (!prev) return next;
  let changed = prev.count !== next.count || prev.empty !== next.empty || prev.columns.length !== next.columns.length;
  const columns = next.columns.map((column, i) => {
    const old = prev.columns[i];
    if (
      old &&
      old.key === column.key &&
      old.label === column.label &&
      old.color === column.color &&
      old.priority === column.priority &&
      old.collapsed === column.collapsed &&
      sameIds(old.ids, column.ids)
    ) {
      return old;
    }
    changed = true;
    return column;
  });
  return changed ? { ...next, columns } : prev;
}
