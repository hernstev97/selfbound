// Views as data: base filter, default display, groupings, row style, defaults for new issues.
// Extension point: a new list = an entry in VIEWS plus a route in route.ts.
import { ACTIVE } from './format.ts';
import { t, translated } from './i18n.ts';
import { inInbox } from './inbox.ts';
import type { IconName } from './icons.ts';
import type { StateType } from '@xlr8/backend/shared/workflow';
import type { Display, DisplayProp, Grouping, Issue, IssueId, Meta, NewIssue, Ordering, RowStyle, ViewKind, ViewRoute } from './types.ts';

/** What a view needs for filtering (resolved up front so the loop stays cheap). */
export interface ViewContext {
  teamId: string | null;
  activeSprintId: string | null;
  projectId: string | null;
  /**
   * Issues read during this visit of the view: they stay in the "Unread" filter. Otherwise the one
   * just shown would drop out, focus would move to the next, which would be read, and so on.
   */
  keep: ReadonlySet<IssueId>;
  /** Sprint planning: the planned sprint */
  planSprintId?: string | null;
  /** Sprint planning: only active (not dormant) teams */
  activeTeams?: ReadonlySet<string>;
  /** The view is shown as a board (triage has no column there) */
  board?: boolean;
}

export interface ViewDef {
  kind: ViewKind;
  /** Translated on read */
  readonly label: string;
  icon: IconName;
  /** Does the issue belong to the view (before filters)? Deleted ones only in the trash. */
  includes(issue: Issue, ctx: ViewContext): boolean;
  display(route: ViewRoute): Display;
  groupings: Grouping[];
  orderings: Ordering[];
  style: RowStyle;
  /** Are closed issues relevant here at all (option "Show closed")? */
  closedOption: boolean;
  /** Snoozed issues: hidden unless the filter "Snoozed" is on; `show` = the view is about them or needs them */
  snoozed: 'hide' | 'show';
  /** Defaults for new issues */
  createDefaults?(route: ViewRoute, ctx: ViewContext): Partial<NewIssue>;
  /** Empty state without filters (translated on read) */
  readonly emptyText: string;
  /**
   * Board available: types whose statuses appear as columns even when empty. Columns with issues
   * always appear. Missing = no board in this view.
   */
  boardTypes?: readonly StateType[];
}

const BASE_PROPS: DisplayProp[] = ['priority', 'id', 'status', 'labels', 'project', 'sprint', 'estimate', 'due', 'created'];

const display = (grouping: Grouping, ordering: Ordering, props: DisplayProp[] = BASE_PROPS, showClosed = true): Display => ({ grouping, ordering, props, showClosed });
const crossTeam = (route: ViewRoute, props: DisplayProp[] = BASE_PROPS) => (route.team ? props : ['team' as DisplayProp, ...props]);

const notDeleted = (i: Issue) => i.deletedAt === undefined;
/** Open and accepted (no triage): eligible for a sprint */
const PLANNABLE = new Set(['backlog', 'todo', 'in_progress', 'in_review']);
const OPEN = new Set(['triage', 'backlog', 'todo', 'in_progress', 'in_review']);
const PLAN_PROPS: DisplayProp[] = ['team', 'priority', 'id', 'status', 'labels', 'estimate', 'due'];
const inTeam = (i: Issue, ctx: ViewContext) => !ctx.teamId || i.teamId === ctx.teamId;

const ALL_GROUPINGS: Grouping[] = ['status', 'team', 'priority', 'project', 'sprint', 'none'];
const ALL_ORDERINGS: Ordering[] = ['priority', 'rank', 'updated', 'created', 'due'];
const PLAN_ORDERINGS: Ordering[] = ['rank', 'priority', 'status', 'created', 'updated', 'due'];

export const VIEWS: Record<ViewKind, ViewDef> = {
  inbox: {
    kind: 'inbox',
    get label() {
      return t('Inbox');
    },
    icon: 'inbox',
    includes: (i) => inInbox(i),
    display: () => display('none', 'created', ['status', 'id']),
    groupings: ['none', 'team'],
    orderings: ['created', 'updated', 'priority'],
    style: 'inbox',
    closedOption: false,
    snoozed: 'hide',
    get emptyText() {
      return t('The inbox is empty. Issues that agents create and snoozed issues that come back show up here until you remove the entry.');
    },
  },
  snoozed: {
    kind: 'snoozed',
    get label() {
      return t('Snoozed');
    },
    icon: 'snooze',
    includes: (i, ctx) => notDeleted(i) && i.snoozedUntil !== undefined && inTeam(i, ctx),
    display: (r) => display('none', 'snoozed', ['priority', 'id', 'status', 'snoozed', ...(r.team ? [] : ['team' as DisplayProp])]),
    groupings: ['none', 'team', 'priority', 'status'],
    orderings: ['snoozed', 'priority', 'updated', 'created'],
    style: 'issue',
    closedOption: false,
    snoozed: 'show',
    get emptyText() {
      return t('Nothing is snoozed. Snooze an issue with H to hide it until a day you choose.');
    },
  },
  triage: {
    kind: 'triage',
    get label() {
      return t('Triage');
    },
    icon: 'triage',
    includes: (i, ctx) => notDeleted(i) && i.status === 'triage' && inTeam(i, ctx),
    display: (r) => display(r.team ? 'none' : 'team', 'created', crossTeam(r, ['priority', 'id', 'status', 'labels', 'created'])),
    groupings: ['team', 'priority', 'none'],
    orderings: ['created', 'priority', 'updated'],
    style: 'issue',
    closedOption: false,
    snoozed: 'hide',
    createDefaults: () => ({ status: 'triage' }),
    get emptyText() {
      return t('Triage is empty. New issues with status "Triage" land here for sorting.');
    },
  },
  all: {
    kind: 'all',
    get label() {
      return t('All issues');
    },
    icon: 'issues',
    // Triage is its own group in the list; the board has no triage.
    includes: (i, ctx) => notDeleted(i) && (i.status !== 'triage' || !ctx.board) && inTeam(i, ctx),
    display: (r) => display(r.team ? 'status' : 'team', 'priority', crossTeam(r)),
    groupings: ALL_GROUPINGS,
    orderings: ALL_ORDERINGS,
    style: 'issue',
    closedOption: true,
    snoozed: 'hide',
    get emptyText() {
      return t('There are no issues here yet.');
    },
    boardTypes: ['backlog', 'unstarted', 'started', 'completed', 'canceled'],
  },
  active: {
    kind: 'active',
    get label() {
      return t('Active');
    },
    icon: 'active',
    includes: (i, ctx) => notDeleted(i) && ACTIVE.has(i.status) && inTeam(i, ctx),
    display: (r) => display('status', 'priority', crossTeam(r)),
    groupings: ALL_GROUPINGS,
    orderings: ALL_ORDERINGS,
    style: 'issue',
    closedOption: false,
    snoozed: 'hide',
    createDefaults: () => ({ status: 'todo' }),
    get emptyText() {
      return t('Nothing in progress. Issues with status Todo, In Progress or In Review show up here.');
    },
    boardTypes: ['unstarted', 'started'],
  },
  backlog: {
    kind: 'backlog',
    get label() {
      return t('Backlog');
    },
    icon: 'backlog',
    includes: (i, ctx) => notDeleted(i) && i.status === 'backlog' && inTeam(i, ctx),
    display: (r) => display(r.team ? 'none' : 'team', 'rank', crossTeam(r)),
    groupings: ALL_GROUPINGS,
    orderings: ALL_ORDERINGS,
    style: 'issue',
    closedOption: false,
    snoozed: 'hide',
    createDefaults: () => ({ status: 'backlog' }),
    get emptyText() {
      return t('The backlog is empty.');
    },
    boardTypes: ['backlog'],
  },
  sprint: {
    kind: 'sprint',
    get label() {
      return t('Sprint');
    },
    icon: 'sprint',
    includes: (i, ctx) => notDeleted(i) && ctx.activeSprintId !== null && i.sprintId === ctx.activeSprintId && inTeam(i, ctx),
    display: (r) => display(r.team ? 'status' : 'scope', 'status', crossTeam(r, ['priority', 'id', 'status', 'labels', 'project', 'estimate', 'due'])),
    groupings: ['scope', ...ALL_GROUPINGS],
    orderings: [...ALL_ORDERINGS, 'status'],
    style: 'issue',
    closedOption: true,
    snoozed: 'hide',
    createDefaults: (_r, ctx) => (ctx.activeSprintId ? { sprintId: ctx.activeSprintId as never, status: 'todo' } : {}),
    get emptyText() {
      return t('No sprint is running. A sprint runs once you start it after planning.');
    },
    boardTypes: ['unstarted', 'started', 'completed', 'canceled'],
  },
  plan: {
    kind: 'plan',
    get label() {
      return t('Backlog');
    },
    icon: 'backlog',
    includes: (i, ctx) => notDeleted(i) && !i.sprintId && PLANNABLE.has(i.status) && !i.pending && (!ctx.activeTeams || ctx.activeTeams.has(i.teamId)),
    display: () => display('none', 'rank', PLAN_PROPS),
    groupings: ['none', 'team', 'priority', 'status'],
    orderings: PLAN_ORDERINGS,
    style: 'issue',
    closedOption: false,
    snoozed: 'hide',
    createDefaults: () => ({ status: 'backlog' }),
    get emptyText() {
      return t('No open issues without a sprint. New issues land here once they are accepted.');
    },
  },
  planned: {
    kind: 'planned',
    get label() {
      return t('Sprint');
    },
    icon: 'sprint',
    includes: (i, ctx) => notDeleted(i) && !!ctx.planSprintId && i.sprintId === ctx.planSprintId,
    display: () => display('none', 'rank', PLAN_PROPS),
    groupings: ['none', 'team', 'priority', 'status'],
    orderings: PLAN_ORDERINGS,
    style: 'issue',
    closedOption: false,
    snoozed: 'show',
    createDefaults: (_r, ctx) => (ctx.planSprintId ? { sprintId: ctx.planSprintId as never, status: 'todo' } : {}),
    get emptyText() {
      return t('Nothing planned yet. Select issues on the left and bring them here with → or drag them over.');
    },
  },
  close: {
    kind: 'close',
    get label() {
      return t('Complete sprint');
    },
    icon: 'sprint',
    includes: (i, ctx) => notDeleted(i) && ctx.activeSprintId !== null && i.sprintId === ctx.activeSprintId && OPEN.has(i.status) && !i.pending,
    display: () => display('none', 'status', ['team', 'priority', 'id', 'status', 'labels', 'estimate']),
    groupings: ['none', 'team', 'status', 'scope'],
    orderings: ['status', 'priority', 'rank'],
    style: 'issue',
    closedOption: false,
    snoozed: 'show',
    get emptyText() {
      return t('All issues of this sprint are done or canceled. You can complete it.');
    },
  },
  project: {
    kind: 'project',
    get label() {
      return t('Project');
    },
    icon: 'projects',
    includes: (i, ctx) => notDeleted(i) && i.projectId === ctx.projectId,
    display: () => display('status', 'priority', BASE_PROPS.filter((p) => p !== 'project')),
    groupings: ALL_GROUPINGS,
    orderings: ALL_ORDERINGS,
    style: 'issue',
    closedOption: true,
    snoozed: 'hide',
    createDefaults: (r) => (r.project ? { projectId: r.project as never } : {}),
    get emptyText() {
      return t('This project has no issues yet.');
    },
    boardTypes: ['backlog', 'unstarted', 'started', 'completed', 'canceled'],
  },
  trash: {
    kind: 'trash',
    get label() {
      return t('Trash');
    },
    icon: 'trash',
    includes: (i, ctx) => i.deletedAt !== undefined && !i.pending && inTeam(i, ctx),
    display: () => display('none', 'updated', ['team', 'priority', 'id', 'status']),
    groupings: ['none', 'team'],
    orderings: ['updated', 'created'],
    style: 'trash',
    closedOption: false,
    snoozed: 'show',
    get emptyText() {
      return t('The trash is empty. Deleted issues stay here for 30 days.');
    },
  },
};

/** Title for the header and the window title. */
export function viewTitle(route: ViewRoute, meta: Meta | null) {
  if (route.kind === 'project') return meta?.projects.find((p) => p._id === route.project)?.name ?? t('Project');
  if (route.kind === 'sprint' || route.kind === 'close') {
    const sprint = meta?.sprints.find((s) => s.state === 'active');
    const name = sprint ? sprint.name : t('Sprint');
    return route.kind === 'close' ? t('Complete {name}', { name }) : name;
  }
  if (route.kind === 'plan' || route.kind === 'planned') {
    const sprint = planSprint(route, meta);
    return sprint ? t('Plan {name}', { name: sprint.name }) : t('Plan sprint');
  }
  return VIEWS[route.kind].label;
}

/** The sprint that planning shows: by number, else the next one in planning. */
export function planSprint(route: ViewRoute, meta: Meta | null) {
  const sprints = meta?.sprints ?? [];
  if (route.sprint) return sprints.find((s) => String(s.number) === route.sprint) ?? null;
  return [...sprints].filter((s) => s.state === 'planning').sort((a, b) => a.number - b.number)[0] ?? null;
}

/** Target of "Add to sprint": the active sprint, else the next one in planning. */
export function addTarget(meta: Meta | null) {
  const sprints = meta?.sprints ?? [];
  return sprints.find((s) => s.state === 'active') ?? [...sprints].filter((s) => s.state === 'planning').sort((a, b) => a.number - b.number)[0] ?? null;
}

/** Key under which display options, scroll position and collapsed groups are saved. */
export function viewKey(route: ViewRoute) {
  return `${route.kind}:${route.team ?? '*'}${route.project ? `:${route.project}` : ''}`;
}

export const GROUPING_LABEL: Record<Grouping, string> = translated({
  status: 'Status',
  team: 'Team',
  priority: 'Priority',
  project: 'Project',
  sprint: 'Sprint',
  scope: 'Planned / added later',
  none: 'None',
});

export const ORDERING_LABEL: Record<Ordering, string> = translated({
  priority: 'Priority',
  rank: 'Manual',
  updated: 'Last updated',
  created: 'Created',
  due: 'Due date',
  status: 'Status',
  snoozed: 'Snoozed until',
});

export const PROP_LABEL: Record<DisplayProp, string> = translated({
  priority: 'Priority',
  id: 'ID',
  status: 'Status',
  team: 'Team',
  labels: 'Labels',
  project: 'Project',
  sprint: 'Sprint',
  estimate: 'Estimate',
  due: 'Due date',
  snoozed: 'Snoozed until',
  created: 'Created',
  updated: 'Updated',
});
