// Filtering, sorting, grouping: synchronous in memory, outside the components.
import { CLOSED, PRIORITY_GROUP_ORDER, PRIORITY_LABEL, STATUS_GROUP_ORDER, priorityRank } from './format.ts';
import { intlLocale, t } from './i18n.ts';
import { stateGroupKey, statusMatcher, workflowsOf, type StateView } from './workflow.ts';
import { VIEWS, type ViewContext } from './views.ts';
import { haystackOf } from './haystack.ts';
import { inboxAt, unread } from './inbox.ts';
import type { Filters, GroupInfo, Grouping, Issue, IssueId, ListRow, ListState, Meta, Ordering, Priority, SprintItemKind, TeamBadge, ViewState } from './types.ts';

/** Extras for groupings that do not follow from the issue itself. */
export interface ListExtras {
  /** Active sprint: planned / added later */
  kinds?: ReadonlyMap<IssueId, SprintItemKind>;
  /** Team groups: budget text and whether it is exceeded, per team id */
  budget?: ReadonlyMap<string, { label: string; over: boolean }>;
}

const STATUS_POS = new Map(STATUS_GROUP_ORDER.map((s, i) => [s, i]));

export function emptyFilters(): Filters {
  return { status: [], priority: [], team: [], label: [], project: [], sprint: [], unreviewed: false };
}

export function filterCount(f: Filters) {
  return f.status.length + f.priority.length + f.team.length + f.label.length + f.project.length + f.sprint.length + (f.unreviewed ? 1 : 0);
}

export function hasFilters(view: ViewState) {
  return filterCount(view.filters) > 0 || view.quick.trim() !== '';
}

export function sameFilters(a: Filters, b: Filters) {
  const eq = (x: readonly unknown[], y: readonly unknown[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.status, b.status) && eq(a.priority, b.priority) && eq(a.team, b.team) && eq(a.label, b.label) && eq(a.project, b.project) && eq(a.sprint, b.sprint) && a.unreviewed === b.unreviewed;
}

const byRank = (a: Issue, b: Issue) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);

export function comparator(ordering: Ordering): (a: Issue, b: Issue) => number {
  switch (ordering) {
    case 'priority':
      return (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.seq - a.seq;
    case 'rank':
      return byRank;
    case 'updated':
      return (a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq;
    case 'created':
      return (a, b) => b.createdAt - a.createdAt || b.seq - a.seq;
    case 'status':
      return (a, b) => STATUS_POS.get(a.status)! - STATUS_POS.get(b.status)! || priorityRank(a.priority) - priorityRank(b.priority) || b.seq - a.seq;
    case 'due':
      return (a, b) => {
        if (a.dueDate === b.dueDate) return priorityRank(a.priority) - priorityRank(b.priority) || b.seq - a.seq;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      };
  }
}

/** Test "belongs to the view?" for an issue (base filter, filters, quick search). */
export function visibleFilter(view: ViewState, meta: Meta | null, ctx: ViewContext): (issue: Issue) => boolean {
  const def = VIEWS[view.route.kind];
  const f = view.filters;
  const teamIdByKey = new Map(meta?.teams.map((team) => [team.key, team._id as string]) ?? []);
  const status = statusMatcher(meta, f.status);
  const priority = f.priority.length ? new Set<Priority>(f.priority) : null;
  const teams = f.team.length ? new Set(f.team.map((k) => teamIdByKey.get(k))) : null;
  const labels = f.label.length ? new Set(f.label) : null;
  const projects = f.project.length ? new Set(f.project) : null;
  const sprints = f.sprint.length ? new Set(f.sprint) : null;
  const hideClosed = def.closedOption && !view.display.showClosed && !status;
  const tokens = view.quick.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unreviewed = f.unreviewed;
  return (issue) => {
    if (!def.includes(issue, ctx)) return false;
    if (hideClosed && CLOSED.has(issue.status)) return false;
    if (status && !status(issue)) return false;
    if (priority && !priority.has(issue.priority)) return false;
    if (teams && !teams.has(issue.teamId)) return false;
    if (labels && !issue.labelIds.some((l) => labels.has(l))) return false;
    if (projects && !projects.has(issue.projectId ?? 'none')) return false;
    if (sprints && !sprints.has(issue.sprintId ?? 'none')) return false;
    if (unreviewed && !unread(issue) && !ctx.keep.has(issue._id)) return false;
    if (tokens.length && !tokens.every((token) => haystackOf(issue).includes(token))) return false;
    return true;
  };
}

/** The view's sort order (trash: most recently deleted at the top). */
export function viewComparator(view: ViewState): (a: Issue, b: Issue) => number {
  if (view.route.kind === 'trash' && view.display.ordering === 'updated') return (a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0) || b.seq - a.seq;
  // Inbox: newest first by the entry's latest change, so an agent's new change moves it to the top.
  if (view.route.kind === 'inbox' && view.display.ordering === 'created') return (a, b) => inboxAt(b) - inboxAt(a) || b.seq - a.seq;
  return comparator(view.display.ordering);
}

/** The view's visible issues, sorted. */
export function computeVisible(all: Issue[], view: ViewState, meta: Meta | null, ctx: ViewContext): Issue[] {
  const matches = visibleFilter(view, meta, ctx);
  const out: Issue[] = [];
  for (const issue of all) if (matches(issue)) out.push(issue);
  out.sort(viewComparator(view));
  return out;
}

/** An issue's group key in the grouping (null = no groups). */
export function groupKeyOf(by: Grouping, extras: ListExtras = {}, meta: Meta | null = null): ((issue: Issue) => string) | null {
  return groupSpec(by, meta, true, extras)?.key ?? null;
}

export function teamBadge(team: Meta['teams'][number] | undefined, dark: boolean): TeamBadge {
  if (!team) return { id: '', key: '?', name: '?', hue: 0, logo: null };
  return { id: team._id, key: team.key, name: team.name, hue: team.hue, logo: (dark ? (team.logoDarkUrl ?? team.logoUrl) : (team.logoUrl ?? team.logoDarkUrl)) ?? null };
}

interface GroupSpec {
  key: (issue: Issue) => string;
  /** Order and labels of the groups */
  order: (keys: Set<string>) => GroupInfo[];
}

function groupSpec(by: Grouping, meta: Meta | null, dark: boolean, extras: ListExtras): GroupSpec | null {
  switch (by) {
    case 'none':
      return null;
    case 'status': {
      // One group per status; across teams, the same type and name form one group.
      const workflows = workflowsOf(meta);
      const seen = new Map<string, StateView & { position: number }>();
      return {
        key: (i) => {
          const state = workflows.of(i);
          const key = stateGroupKey(state);
          const position = workflows.byId.get(state.id)?.position ?? 0;
          const known = seen.get(key);
          if (!known || position < known.position) seen.set(key, { ...state, position });
          return key;
        },
        order: (keys) =>
          [...keys]
            .map((k) => seen.get(k)!)
            .sort(groupOrder)
            .map((s) => ({ by, value: stateGroupKey(s), label: s.name, status: s.status, color: s.color })),
      };
    }
    case 'priority':
      return {
        key: (i) => String(i.priority),
        order: (keys) => PRIORITY_GROUP_ORDER.filter((p) => keys.has(String(p))).map((p) => ({ by, value: String(p), label: PRIORITY_LABEL[p], priority: p })),
      };
    case 'team': {
      const teams = meta?.teams ?? [];
      return {
        key: (i) => i.teamId,
        order: (keys) =>
          teams
            .filter((team) => keys.has(team._id))
            .map((team) => {
              const b = extras.budget?.get(team._id);
              return { by, value: team._id, label: team.name, team: teamBadge(team, dark), ...(b ? { budget: b.label, overBudget: b.over } : {}) };
            }),
      };
    }
    case 'project': {
      const projects = meta?.projects ?? [];
      return {
        key: (i) => i.projectId ?? 'none',
        order: (keys) => [
          ...projects.filter((p) => keys.has(p._id)).map((p) => ({ by, value: p._id as string, label: p.name })),
          ...(keys.has('none') ? [{ by, value: 'none', label: t('No project') }] : []),
        ],
      };
    }
    case 'sprint': {
      const sprints = [...(meta?.sprints ?? [])].sort((a, b) => stateRank(a.state) - stateRank(b.state) || b.number - a.number);
      return {
        key: (i) => i.sprintId ?? 'none',
        order: (keys) => [
          ...sprints.filter((s) => keys.has(s._id)).map((s) => ({ by, value: s._id as string, label: s.state === 'active' ? t('{name} (active)', { name: s.name }) : s.name })),
          ...(keys.has('none') ? [{ by, value: 'none', label: t('No sprint') }] : []),
        ],
      };
    }
    case 'scope': {
      const kinds = extras.kinds;
      return {
        key: (i) => (kinds?.get(i._id) === 'late' ? 'late' : 'planned'),
        order: (keys) => [
          ...(keys.has('planned') ? [{ by, value: 'planned', label: t('Planned') }] : []),
          ...(keys.has('late') ? [{ by, value: 'late', label: t('Added later') }] : []),
        ],
      };
    }
  }
}

/**
 * Order of status groups in lists: triage, started (later ones first), unstarted, backlog,
 * completed, canceled.
 */
const GROUP_TYPE_RANK = { triage: 0, started: 1, unstarted: 2, backlog: 3, completed: 4, canceled: 5 } as const;
function groupOrder(a: StateView & { position: number }, b: StateView & { position: number }) {
  return (
    GROUP_TYPE_RANK[a.type] - GROUP_TYPE_RANK[b.type] ||
    (a.type === 'started' ? b.position - a.position : a.position - b.position) ||
    STATUS_POS.get(a.status)! - STATUS_POS.get(b.status)! ||
    a.name.localeCompare(b.name, intlLocale())
  );
}

const stateRank = (s: string) => (s === 'active' ? 0 : s === 'planning' ? 1 : 2);

/**
 * Rows of the list: group headers and issues. Collapsed groups keep their header (with the
 * count), their issues are left out.
 */
export function computeList(visible: Issue[], view: ViewState, meta: Meta | null, collapsed: ReadonlySet<string>, dark = true, extras: ListExtras = {}): ListState {
  const rows: ListRow[] = [];
  const spec = groupSpec(view.display.grouping, meta, dark, extras);
  if (spec) {
    const groups = new Map<string, Issue[]>();
    for (const issue of visible) {
      const k = spec.key(issue);
      let group = groups.get(k);
      if (!group) groups.set(k, (group = []));
      group.push(issue);
    }
    for (const info of spec.order(new Set(groups.keys()))) {
      const group = groups.get(info.value)!;
      const key = `g:${info.by}:${info.value}`;
      const isCollapsed = collapsed.has(key);
      rows.push({ kind: 'group', key, group: info, count: group.length, collapsed: isCollapsed });
      if (!isCollapsed) for (const issue of group) rows.push({ kind: 'issue', key: issue._id, id: issue._id });
    }
  } else {
    for (const issue of visible) rows.push({ kind: 'issue', key: issue._id, id: issue._id });
  }
  return {
    rows,
    ...keyWidth(visible),
    count: visible.length,
    empty: visible.length > 0 ? null : hasFilters(view) ? 'filtered' : 'none',
    style: VIEWS[view.route.kind].style,
  };
}

/**
 * Width of the identifier column: the longest identifier in characters plus, per team key, the
 * longest number as a pattern ("NOVA-0000"). Digits are tabular, so one pattern per key is
 * enough; the UI measures the patterns and takes the widest (never truncate).
 */
export function keyWidth(visible: readonly Issue[]): { keyChars: number; keySamples: string[] } {
  // Remember the key per team instead of splitting every identifier (runs over all issues on every recompute).
  const prefixOf = new Map<string, string>();
  const digits = new Map<string, number>();
  let keyChars = 0;
  for (const issue of visible) {
    const key = issue.key;
    if (key.length > keyChars) keyChars = key.length;
    let prefix = prefixOf.get(issue.teamId);
    if (prefix === undefined || key.charCodeAt(prefix.length) !== 45 || !key.startsWith(prefix)) {
      prefix = key.slice(0, key.lastIndexOf('-'));
      prefixOf.set(issue.teamId, prefix);
    }
    const n = key.length - prefix.length - 1;
    if ((digits.get(prefix) ?? 0) < n) digits.set(prefix, n);
  }
  const keySamples = [...digits].map(([prefix, n]) => `${prefix}-${'0'.repeat(n)}`).sort();
  return { keyChars, keySamples };
}

/** Keeps the old object if the rows have not changed (saves re-rendering). */
export function reuseList(prev: ListState, next: ListState): ListState {
  if (prev.count !== next.count || prev.empty !== next.empty || prev.rows.length !== next.rows.length || prev.style !== next.style || prev.keyChars !== next.keyChars || prev.keySamples.join() !== next.keySamples.join()) return next;
  for (let i = 0; i < next.rows.length; i++) {
    const a = prev.rows[i];
    const b = next.rows[i];
    if (a.key !== b.key) return next;
    if (a.kind === 'group' && b.kind === 'group' && (a.count !== b.count || a.collapsed !== b.collapsed || a.group.label !== b.group.label || a.group.color !== b.group.color || a.group.team?.logo !== b.group.team?.logo || a.group.budget !== b.group.budget)) return next;
  }
  return prev;
}
