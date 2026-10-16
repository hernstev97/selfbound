// Filtering, sorting, grouping: synchronous in memory, outside the components.
import { CLOSED, PRIORITY_GROUP_ORDER, PRIORITY_LABEL, STATUS_GROUP_ORDER, actorName, addDays, parseDay, priorityRank, today } from './format.ts';
import { OWNER_KIND, isOwnerKind } from './types.ts';
import { intlLocale, t, tn, translated } from './i18n.ts';
import { stateGroupKey, statusMatcher, workflowsOf, type StateView } from './workflow.ts';
import { VIEWS, type ViewContext } from './views.ts';
import { haystackOf } from './haystack.ts';
import { modelFilterMatches } from '@selfbound/backend/shared/models';
import { effectiveChoice, modelKey, teamModels } from './models.ts';
import { inboxAt, unread } from './inbox.ts';
import type { Filters, GroupInfo, GroupOrder, Grouping, Issue, IssueId, ListRow, ListState, Meta, Ordering, Priority, SprintItemKind, TeamBadge, ViewState } from './types.ts';

/** Extras for groupings that do not follow from the issue itself. */
export interface ListExtras {
  /** Active sprint: planned / added later */
  kinds?: ReadonlyMap<IssueId, SprintItemKind>;
  /** Team groups: budget text and whether it is exceeded, per team id */
  budget?: ReadonlyMap<string, { label: string; over: boolean; title: string }>;
  /** Creator groups: display names of agents and the owner (store.agents) */
  actors?: ReadonlyMap<string, string>;
  /** Parent groups: name of the parent issue */
  issueOf?: (id: IssueId) => Issue | undefined;
  /** "Now" for the date groups (tests) */
  now?: number;
}

/** What the groups of one list depend on besides the issues. */
interface GroupOptions {
  /** Also offer groups without issues (top level only) */
  showEmpty: boolean;
  /** Teams whose statuses, labels and projects count for the empty groups */
  teams: readonly string[];
  now: number;
}

const NO_OPTIONS: GroupOptions = { showEmpty: false, teams: [], now: 0 };

/** Teams whose values count for the empty groups: the view's team, otherwise every active team. */
function groupTeams(view: ViewState, meta: Meta | null): string[] {
  const teams = meta?.teams ?? [];
  if (view.route.team) return teams.filter((team) => team.key === view.route.team).map((team) => team._id as string);
  return teams.filter((team) => !team.dormant && team.wiki !== 'only').map((team) => team._id as string);
}

const STATUS_POS = new Map(STATUS_GROUP_ORDER.map((s, i) => [s, i]));

export function emptyFilters(): Filters {
  return { status: [], priority: [], team: [], label: [], project: [], sprint: [], model: [], unreviewed: false, snoozed: false };
}

export function filterCount(f: Filters) {
  return f.status.length + f.priority.length + f.team.length + f.label.length + f.project.length + f.sprint.length + (f.model?.length ?? 0) + (f.unreviewed ? 1 : 0) + (f.snoozed ? 1 : 0);
}

export function hasFilters(view: ViewState) {
  return filterCount(view.filters) > 0 || view.quick.trim() !== '';
}

export function sameFilters(a: Filters, b: Filters) {
  const eq = (x: readonly unknown[], y: readonly unknown[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.status, b.status) && eq(a.priority, b.priority) && eq(a.team, b.team) && eq(a.label, b.label) && eq(a.project, b.project) && eq(a.sprint, b.sprint) && eq(a.model ?? [], b.model ?? []) && a.unreviewed === b.unreviewed && a.snoozed === b.snoozed;
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
    case 'snoozed':
      return (a, b) => {
        const x = a.snoozedUntil ?? '9999';
        const y = b.snoozedUntil ?? '9999';
        return x < y ? -1 : x > y ? 1 : priorityRank(a.priority) - priorityRank(b.priority) || b.seq - a.seq;
      };
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
  // Effective model: "provider/modelId", a model ID, a provider ID or "none" (as MCP's `model` filter).
  const models = f.model.length ? f.model : null;
  const teamDefaults = teamModels(meta);
  const hideClosed = def.closedOption && !view.display.showClosed && !status;
  const tokens = view.quick.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unreviewed = f.unreviewed;
  // Snoozed issues stay out of the lists unless the view is about them or the filter asks for them.
  const hideSnoozed = def.snoozed === 'hide' && !f.snoozed;
  return (issue) => {
    if (!def.includes(issue, ctx)) return false;
    if (hideSnoozed && issue.snoozedUntil !== undefined) return false;
    if (hideClosed && CLOSED.has(issue.status)) return false;
    if (status && !status(issue)) return false;
    if (priority && !priority.has(issue.priority)) return false;
    if (teams && !teams.has(issue.teamId)) return false;
    if (labels && !issue.labelIds.some((l) => labels.has(l))) return false;
    if (projects && !projects.has(issue.projectId ?? 'none')) return false;
    if (sprints && !sprints.has(issue.sprintId ?? 'none')) return false;
    if (models) {
      const m = effectiveChoice(issue, ctx.issueOf, teamDefaults);
      if (!models.some((value) => modelFilterMatches(value, m))) return false;
    }
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

/** An issue's group key in the grouping (null = no groups, or the issue has several keys). */
export function groupKeyOf(by: Grouping, extras: ListExtras = {}, meta: Meta | null = null): ((issue: Issue) => string) | null {
  const spec = groupSpec(by, meta, true, extras, { ...NO_OPTIONS, now: extras.now ?? Date.now() });
  return spec && !spec.keys ? spec.key : null;
}

/** Groups in which an issue appears more than once (a list may then show one issue several times). */
export function multiGrouping(by: Grouping) {
  return by === 'label' || by === 'labelGroup';
}

export function teamBadge(team: Meta['teams'][number] | undefined, dark: boolean): TeamBadge {
  if (!team) return { id: '', key: '?', name: '?', hue: 0, logo: null };
  return { id: team._id, key: team.key, name: team.name, hue: team.hue, logo: (dark ? (team.logoDarkUrl ?? team.logoUrl) : (team.logoUrl ?? team.logoDarkUrl)) ?? null };
}

interface GroupSpec {
  key: (issue: Issue) => string;
  /** Several groups per issue (labels): used instead of `key` */
  keys?: (issue: Issue) => readonly string[];
  /** Order and labels of the groups; `showEmpty` adds the ones without issues */
  order: (keys: Set<string>, showEmpty: boolean) => GroupInfo[];
}

const NONE = 'none';
const NO_GROUP: readonly string[] = [NONE];

// Date groups. The keys are fixed and ordered; the labels are translated on read.
const DUE_ORDER = ['overdue', 'today', 'week', 'next', 'later', 'past', NONE] as const;
const DUE_LABEL = translated({ overdue: 'Overdue', today: 'Today', week: 'This week', next: 'Next week', later: 'Later', past: 'Closed, was due earlier', none: 'No due date' });
const AGE_ORDER = ['today', 'yesterday', 'week', 'month', 'older'] as const;
const AGE_LABEL = translated({ today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', month: 'Last 30 days', older: 'Older' });

/** Spec for groups with a fixed list of keys. */
function fixedSpec(by: Grouping, order: readonly string[], labels: Record<string, string>, key: (issue: Issue) => string): GroupSpec {
  return { key, order: (keys, showEmpty) => order.filter((k) => showEmpty || keys.has(k)).map((k) => ({ by, value: k, label: labels[k] })) };
}

/** Due date: overdue, today, rest of this week, next week, later. The week starts on Monday. */
function dueSpec(now: number): GroupSpec {
  const day = today(now);
  const weekEnd = addDays(day, 6 - ((parseDay(day).getDay() + 6) % 7));
  const nextEnd = addDays(weekEnd, 7);
  return fixedSpec('due', DUE_ORDER, DUE_LABEL, (i) => {
    const due = i.dueDate;
    if (!due) return NONE;
    // Only open work is overdue.
    if (due < day) return CLOSED.has(i.status) ? 'past' : 'overdue';
    return due === day ? 'today' : due <= weekEnd ? 'week' : due <= nextEnd ? 'next' : 'later';
  });
}

/** Created / updated: buckets by age, compared as numbers (no date objects per issue). */
function ageSpec(by: 'created' | 'updated', now: number): GroupSpec {
  const day = today(now);
  const t0 = parseDay(day).getTime();
  const t1 = parseDay(addDays(day, -1)).getTime();
  const t7 = parseDay(addDays(day, -7)).getTime();
  const t30 = parseDay(addDays(day, -30)).getTime();
  return fixedSpec(by, AGE_ORDER, AGE_LABEL, (i) => {
    const at = i[by === 'created' ? 'createdAt' : 'updatedAt'];
    return at >= t0 ? 'today' : at >= t1 ? 'yesterday' : at >= t7 ? 'week' : at >= t30 ? 'month' : 'older';
  });
}

function groupSpec(by: Grouping, meta: Meta | null, dark: boolean, extras: ListExtras, opts: GroupOptions = NO_OPTIONS): GroupSpec | null {
  const inTeams = (teamId: string | undefined) => !teamId || opts.teams.includes(teamId);
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
        order: (keys, showEmpty) => {
          const wanted = new Set(keys);
          if (showEmpty) {
            for (const g of workflows.groups(opts.teams)) {
              wanted.add(g.key);
              if (!seen.has(g.key)) seen.set(g.key, { id: '', name: g.name, status: g.status, type: g.type, color: g.color, position: g.position });
            }
          }
          return [...wanted]
            .map((k) => seen.get(k)!)
            .sort(groupOrder)
            .map((s) => ({ by, value: stateGroupKey(s), label: s.name, status: s.status, color: s.color }));
        },
      };
    }
    case 'priority':
      return {
        key: (i) => String(i.priority),
        order: (keys, showEmpty) => PRIORITY_GROUP_ORDER.filter((p) => showEmpty || keys.has(String(p))).map((p) => ({ by, value: String(p), label: PRIORITY_LABEL[p], priority: p })),
      };
    case 'team': {
      const teams = meta?.teams ?? [];
      return {
        key: (i) => i.teamId,
        order: (keys, showEmpty) =>
          teams
            .filter((team) => keys.has(team._id) || (showEmpty && opts.teams.includes(team._id)))
            .map((team) => {
              const b = extras.budget?.get(team._id);
              return { by, value: team._id, label: team.name, team: teamBadge(team, dark), ...(b ? { budget: b.label, overBudget: b.over, budgetTitle: b.title } : {}) };
            }),
      };
    }
    case 'label': {
      const labels = [...(meta?.labels ?? [])].sort((a, b) => a.name.localeCompare(b.name, intlLocale()));
      return {
        key: (i) => i.labelIds[0] ?? NONE,
        keys: (i) => (i.labelIds.length ? i.labelIds : NO_GROUP),
        order: (keys, showEmpty) => [
          ...labels.filter((l) => keys.has(l._id) || (showEmpty && !l.archived && inTeams(l.teamId))).map((l) => ({ by, value: l._id as string, label: l.name, hue: l.hue })),
          ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No label') }] : []),
        ],
      };
    }
    case 'labelGroup': {
      const groups = [...(meta?.labelGroups ?? [])].sort((a, b) => a.name.localeCompare(b.name, intlLocale()));
      const groupOf = new Map<string, string>();
      for (const label of meta?.labels ?? []) if (label.groupId) groupOf.set(label._id, label.groupId);
      // An issue appears once per group, however many of the group's labels it has.
      const keysOf = (i: Issue) => {
        const out: string[] = [];
        for (const id of i.labelIds) {
          const g = groupOf.get(id);
          if (g && !out.includes(g)) out.push(g);
        }
        return out.length ? out : NO_GROUP;
      };
      return {
        key: (i) => keysOf(i)[0]!,
        keys: keysOf,
        order: (keys, showEmpty) => [
          ...groups.filter((g) => keys.has(g._id) || (showEmpty && inTeams(g.teamId))).map((g) => ({ by, value: g._id as string, label: g.name, hue: g.hue })),
          ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No label group') }] : []),
        ],
      };
    }
    case 'creator': {
      const names = new Map<string, string>();
      return {
        key: (i) => {
          const actor = i.createdBy;
          const key = isOwnerKind(actor.kind) ? OWNER_KIND : actor.kind === 'agent' ? `agent:${actor.agentId ?? ''}` : actor.kind;
          if (!names.has(key)) names.set(key, actorName(actor, extras.actors ?? new Map()));
          return key;
        },
        // The owner first, then the others by name.
        order: (keys) =>
          [...keys]
            .sort((a, b) => (a === OWNER_KIND ? -1 : b === OWNER_KIND ? 1 : names.get(a)!.localeCompare(names.get(b)!, intlLocale())))
            .map((k) => ({ by, value: k, label: names.get(k)! })),
      };
    }
    case 'estimate':
      return {
        key: (i) => (i.estimate === undefined ? NONE : String(i.estimate)),
        order: (keys, showEmpty) => [
          ...[...keys]
            .filter((k) => k !== NONE)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => ({ by, value: k, label: tn(Number(k), '{count} point', '{count} points') })),
          ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No estimate') }] : []),
        ],
      };
    case 'due':
      return dueSpec(opts.now);
    case 'created':
    case 'updated':
      return ageSpec(by, opts.now);
    case 'project': {
      const projects = meta?.projects ?? [];
      return {
        key: (i) => i.projectId ?? NONE,
        order: (keys, showEmpty) => [
          ...projects.filter((p) => keys.has(p._id) || (showEmpty && inTeams(p.teamId) && p.state !== 'done' && p.state !== 'canceled')).map((p) => ({ by, value: p._id as string, label: p.name })),
          ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No project') }] : []),
        ],
      };
    }
    case 'sprint': {
      const sprints = [...(meta?.sprints ?? [])].sort((a, b) => stateRank(a.state) - stateRank(b.state) || b.number - a.number);
      return {
        key: (i) => i.sprintId ?? NONE,
        order: (keys, showEmpty) => [
          ...sprints.filter((s) => keys.has(s._id) || (showEmpty && s.state !== 'closed')).map((s) => ({ by, value: s._id as string, label: s.state === 'active' ? t('{name} (active)', { name: s.name }) : s.name })),
          ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No sprint') }] : []),
        ],
      };
    }
    case 'model': {
      // Effective model (own, parent's, team default), one group per model whatever the effort.
      const teams = teamModels(meta);
      const models = (meta?.models ?? []).map((m) => ({ key: modelKey(m.provider, m.modelId), m }));
      const names = new Map<string, number>();
      for (const { m } of models) names.set(m.name, (names.get(m.name) ?? 0) + 1);
      const label = (m: (typeof models)[number]['m']) => ((names.get(m.name) ?? 0) > 1 ? `${m.name} · ${m.providerName}` : m.name);
      return {
        key: (i) => {
          const m = effectiveChoice(i, extras.issueOf, teams);
          return m ? modelKey(m.provider, m.modelId) : NONE;
        },
        order: (keys, showEmpty) => {
          const known = new Set(models.map((x) => x.key));
          return [
            ...models.filter((x) => keys.has(x.key) || (showEmpty && !x.m.removed)).map((x) => ({ by, value: x.key, label: label(x.m), ...(x.m.logo ? { logo: x.m.logo } : {}) })),
            // A model no longer enabled: its ID and provider.
            ...[...keys].filter((k) => k !== NONE && !known.has(k)).map((k) => ({ by, value: k, label: `${k.slice(k.indexOf('/') + 1)} · ${k.slice(0, k.indexOf('/'))}` })),
            ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No model') }] : []),
          ];
        },
      };
    }
    case 'parent':
      return {
        key: (i) => i.parentId ?? NONE,
        // Parents in the order of their first sub-issue in the list, so the view's ordering decides.
        order: (keys, showEmpty) => [
          ...[...keys]
            .filter((k) => k !== NONE)
            .map((k) => {
              const parent = extras.issueOf?.(k as IssueId);
              return { by, value: k, label: parent ? `${parent.key} ${parent.title}` : t('Unknown issue') };
            }),
          ...(keys.has(NONE) || showEmpty ? [{ by, value: NONE, label: t('No parent issue') }] : []),
        ],
      };
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

/** Splits the issues into their groups; they keep the order they come in (already sorted, no re-sort). */
function bucket(items: readonly Issue[], spec: GroupSpec): Map<string, Issue[]> {
  const groups = new Map<string, Issue[]>();
  const keys = spec.keys;
  if (keys) {
    for (const issue of items) {
      for (const k of keys(issue)) {
        const group = groups.get(k);
        if (group) group.push(issue);
        else groups.set(k, [issue]);
      }
    }
  } else {
    const key = spec.key;
    for (const issue of items) {
      const k = key(issue);
      const group = groups.get(k);
      if (group) group.push(issue);
      else groups.set(k, [issue]);
    }
  }
  return groups;
}

/** The groups in display order: natural, reversed or by size; groups the spec does not know come last. */
function arrange(by: Grouping, spec: GroupSpec, groups: ReadonlyMap<string, Issue[]>, order: GroupOrder | undefined, showEmpty: boolean): GroupInfo[] {
  const infos = spec.order(new Set(groups.keys()), showEmpty);
  const known = new Set(infos.map((info) => info.value));
  for (const k of groups.keys()) if (!known.has(k)) infos.push({ by, value: k, label: t('Unknown') });
  if (order === 'desc') infos.reverse();
  else if (order === 'size') {
    const size = (info: GroupInfo) => groups.get(info.value)?.length ?? 0;
    // Array.sort is stable: equal sizes keep their natural order.
    infos.sort((a, b) => size(b) - size(a));
  }
  return infos;
}

const NO_ISSUES: readonly Issue[] = [];

/**
 * Rows of the list: group headers and issues. Collapsed groups keep their header (with the
 * count), their issues are left out. With a second level, each group holds sub-group headers.
 * Grouping by labels lists an issue under each of its labels; its rows then get distinct keys.
 */
export function computeList(visible: Issue[], view: ViewState, meta: Meta | null, collapsed: ReadonlySet<string>, dark = true, extras: ListExtras = {}): ListState {
  const rows: ListRow[] = [];
  const display = view.display;
  const opts: GroupOptions = { showEmpty: display.emptyGroups === true, teams: display.emptyGroups ? groupTeams(view, meta) : [], now: extras.now ?? Date.now() };
  const spec = groupSpec(display.grouping, meta, dark, extras, opts);
  if (spec) {
    const subBy = display.subGrouping && display.subGrouping !== 'none' && display.subGrouping !== display.grouping ? display.subGrouping : null;
    const subSpec = subBy ? groupSpec(subBy, meta, dark, extras, { ...opts, showEmpty: false }) : null;
    // Only with several groups per issue can an issue show up twice.
    const shown = spec.keys || subSpec?.keys ? new Set<string>() : null;
    const pushIssue = (issue: Issue, prefix: string) => {
      let key: string = issue._id;
      if (shown) {
        if (shown.has(key)) key = `${prefix}|${key}`;
        else shown.add(key);
      }
      rows.push({ kind: 'issue', key, id: issue._id });
    };
    const groups = bucket(visible, spec);
    for (const info of arrange(display.grouping, spec, groups, display.groupOrder, opts.showEmpty)) {
      const members = groups.get(info.value) ?? NO_ISSUES;
      const key = `g:${info.by}:${info.value}`;
      const isCollapsed = collapsed.has(key);
      rows.push({ kind: 'group', key, group: info, count: members.length, collapsed: isCollapsed });
      if (isCollapsed) continue;
      if (!subSpec || !subBy) {
        for (const issue of members) pushIssue(issue, key);
        continue;
      }
      const subGroups = bucket(members, subSpec);
      for (const sub of arrange(subBy, subSpec, subGroups, display.groupOrder, false)) {
        const subMembers = subGroups.get(sub.value)!;
        const subKey = `${key}/${sub.by}:${sub.value}`;
        const subCollapsed = collapsed.has(subKey);
        rows.push({ kind: 'group', key: subKey, group: { ...sub, parent: info }, count: subMembers.length, collapsed: subCollapsed });
        if (!subCollapsed) for (const issue of subMembers) pushIssue(issue, subKey);
      }
    }
  } else {
    for (const issue of visible) rows.push({ kind: 'issue', key: issue._id, id: issue._id });
  }
  return {
    rows,
    ...keyWidth(visible),
    count: visible.length,
    // Empty groups on screen are content too (they carry the "+" button).
    empty: rows.length > 0 ? null : hasFilters(view) ? 'filtered' : 'none',
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
    if (a.kind === 'group' && b.kind === 'group' && (a.count !== b.count || a.collapsed !== b.collapsed || a.group.label !== b.group.label || a.group.color !== b.group.color || a.group.hue !== b.group.hue || a.group.team?.logo !== b.group.team?.logo || a.group.budget !== b.group.budget || a.group.budgetTitle !== b.group.budgetTitle)) return next;
  }
  return prev;
}
