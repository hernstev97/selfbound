import type { Doc, Id } from '@selfbound/backend/dataModel';
import type { Priority, Status } from '@selfbound/backend/constants';

export type { Priority, Status };
export type IssueDoc = Doc<'issues'>;
export type IssueId = Id<'issues'>;
/** An open inbox entry (`inbox.list`). */
export type InboxEntry = Doc<'inboxEntries'>;
export type TeamId = Id<'teams'>;
export type LabelId = Id<'labels'>;
export type ProjectId = Id<'projects'>;
export type SprintId = Id<'sprints'>;
export type AgentId = Id<'agents'>;
export type CommentId = Id<'comments'>;
export type ProjectDoc = Doc<'projects'>;
export type LabelDoc = Doc<'labels'>;
export type LabelGroupDoc = Doc<'labelGroups'>;
/** A team's workflow status */
export type StateDoc = Doc<'workflowStates'>;
export type StateId = Id<'workflowStates'>;
export type SprintDoc = Doc<'sprints'>;
export type Actor = IssueDoc['createdBy'];
/** Actor kind of the instance owner. */
export const OWNER_KIND = 'owner' as const;
/** Stored value before the rename; still present in data that has not been migrated (legacy-xlr8). */
export const LEGACY_OWNER_KIND = 'steven' as const;
/** Does this actor kind belong to the owner? Never compare with OWNER_KIND directly. */
export const isOwnerKind = (kind: string): kind is typeof OWNER_KIND | typeof LEGACY_OWNER_KIND => kind === OWNER_KIND || kind === LEGACY_OWNER_KIND;

/** Team from `meta.get`, with logo URLs. */
export type TeamDoc = Doc<'teams'> & { logoUrl: string | null; logoDarkUrl: string | null };

/** Reference data from `meta.get`. */
export interface Meta {
  teams: TeamDoc[];
  /** Statuses of all teams, archived ones included */
  workflowStates: StateDoc[];
  projects: ProjectDoc[];
  labelGroups: LabelGroupDoc[];
  labels: LabelDoc[];
  sprints: SprintDoc[];
  rejectWrites: boolean;
  /** The owner's profile; missing in a cache written before the profile existed */
  owner?: OwnerProfile;
  /** Instance time zone (IANA name); null = not set yet, missing in an older cache */
  timeZone?: string | null;
}

/** Display name and picture URL of the owner (null = not set). */
export interface OwnerProfile {
  name: string | null;
  avatarUrl: string | null;
}

/**
 * Issue in the client store: server document plus derived fields, frozen.
 * Provisional issues (not yet confirmed by the server) carry `pending` and an
 * id `tmp:…` as `_id`.
 */
export interface Issue extends Omit<IssueDoc, 'reviewedAt' | 'readAt'> {
  /** e.g. "KIU-12" */
  key: string;
  /** The issue's open inbox entry, merged in by the store; the old markers on the document are not used any more */
  inbox?: InboxEntry;
  /** Created provisionally, not yet confirmed by the server */
  pending?: true;
}

/** Open `issues.detail` query (backend result). */
export interface DetailDoc {
  id: IssueId;
  identifier: string;
  body: { markdown: string; version: number; updatedAt: number; updatedBy: Actor };
  comments: CommentDoc[];
  /** There are older comments than the ones included (load more through `comments.page`) */
  commentsHasMore?: boolean;
  relations: RelationInfo[];
  pullRequests: PullRequestInfo[];
  history: HistoryDoc[];
  sprints: { sprintId: SprintId; kind: SprintItemKind; addedAt: number; removedAt?: number; sprint: { _id: SprintId; number: number; name: string; state: SprintDoc['state'] } }[];
}

export interface CommentDoc {
  _id: CommentId | string;
  _creationTime: number;
  issueId: IssueId;
  body: string;
  author: Actor;
  authorName?: string;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  /** Inserted optimistically, not yet confirmed by the server */
  pending?: boolean;
}

export interface HistoryDoc {
  _id: string;
  issueId: IssueId;
  field: string;
  from?: unknown;
  to?: unknown;
  actor: Actor;
  at: number;
}

export type RelationType = 'blocks' | 'related' | 'duplicate';
export interface RelationInfo {
  id: Id<'relations'>;
  type: RelationType;
  direction: 'out' | 'in';
  createdAt: number;
  other: { id: IssueId; identifier: string; title: string; status: Status; teamId: TeamId; deleted: boolean };
}

export interface PullRequestInfo {
  _id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  branch: string;
  via: string;
  closes: boolean;
}

export type SprintItemKind = 'planned' | 'late' | 'imported';

export interface AgentInfo {
  _id: AgentId;
  name: string;
}

/** Editable fields (like `IssuePatch` in the backend, `null` = clear). */
export interface IssuePatch {
  title?: string;
  /** The team's status; takes precedence over `status` */
  stateId?: StateId;
  /** Status type: the team's matching status */
  status?: Status;
  priority?: Priority;
  labelIds?: LabelId[];
  projectId?: ProjectId | null;
  estimate?: number | null;
  dueDate?: string | null;
  /** Hidden from the lists until this day; `null` = unsnooze */
  snoozedUntil?: string | null;
  parentId?: IssueId | null;
  sprintId?: SprintId | null;
}
export type PatchField = keyof IssuePatch;
export const PATCH_FIELDS: PatchField[] = ['title', 'stateId', 'status', 'priority', 'labelIds', 'projectId', 'estimate', 'dueDate', 'snoozedUntil', 'parentId', 'sprintId'];

/** New issue (like `NewIssue` in the backend). */
export interface NewIssue {
  teamId: TeamId;
  title: string;
  description?: string;
  stateId?: StateId;
  status?: Status;
  priority?: Priority;
  labelIds?: LabelId[];
  projectId?: ProjectId;
  estimate?: number;
  dueDate?: string;
  parentId?: IssueId;
  sprintId?: SprintId;
}

// ---------------------------------------------------------------- Views

/**
 * Kind of view; each has its own definition in `views.ts`. plan = backlog of sprint planning,
 * planned = content of the planned sprint (right column), close = completing the sprint.
 */
export type ViewKind = 'inbox' | 'snoozed' | 'triage' | 'all' | 'active' | 'backlog' | 'trash' | 'sprint' | 'project' | 'plan' | 'planned' | 'close';

/** scope = planned / added later (active sprint); due, created, updated = date buckets */
export type Grouping = 'status' | 'team' | 'priority' | 'label' | 'labelGroup' | 'creator' | 'estimate' | 'due' | 'project' | 'sprint' | 'parent' | 'created' | 'updated' | 'scope' | 'none';
/** Order of the groups: the natural order, reversed, or the biggest group first */
export type GroupOrder = 'asc' | 'desc' | 'size';
export type Ordering = 'priority' | 'rank' | 'updated' | 'created' | 'due' | 'status' | 'snoozed';
export type DisplayProp = 'priority' | 'id' | 'status' | 'labels' | 'project' | 'sprint' | 'estimate' | 'due' | 'snoozed' | 'created' | 'updated' | 'team';
export const DISPLAY_PROPS: DisplayProp[] = ['priority', 'id', 'status', 'team', 'labels', 'project', 'sprint', 'estimate', 'due', 'snoozed', 'created', 'updated'];

export interface Display {
  grouping: Grouping;
  /** Second level inside each group; missing = none */
  subGrouping?: Grouping;
  /** Missing = natural order */
  groupOrder?: GroupOrder;
  /** Also show groups without issues; missing = hide them */
  emptyGroups?: boolean;
  /** Board only: one column per priority instead of per status; missing = status */
  boardColumns?: 'priority';
  ordering: Ordering;
  props: DisplayProp[];
  /** Show done, canceled and duplicate issues */
  showClosed: boolean;
  /** List or board; missing = list */
  layout?: Layout;
}

export type Layout = 'list' | 'board';

/** Board column: one status (same type and name across teams). */
export interface BoardColumn {
  /** Group key `<type>:<name>`, or `p:<priority>` in a priority column */
  key: string;
  label: string;
  status: Status;
  type: import('@selfbound/backend/shared/workflow').StateType;
  color: string | null;
  /** Priority board: the column's priority (`status` and `type` are then placeholders) */
  priority?: Priority;
  /** The column's issues in the view's order (even when collapsed) */
  ids: IssueId[];
  /** Collapsed: header with count only (done and canceled by default) */
  collapsed: boolean;
}

export interface BoardState {
  columns: BoardColumn[];
  count: number;
  empty: null | 'filtered' | 'none';
}

export interface Filters {
  /** Status: lowercase names (across teams) or keys of a status type */
  status: string[];
  priority: Priority[];
  /** Team keys */
  team: string[];
  label: string[];
  project: string[];
  /** Sprint ids, "none" = no sprint */
  sprint: string[];
  /** Only unread inbox entries (URL `unreviewed=1`, an older name) */
  unreviewed: boolean;
  /** Also show snoozed issues (URL `snoozed=1`) */
  snoozed: boolean;
}

/** Where the list is: kind plus optional team or project. */
export interface ViewRoute {
  kind: ViewKind;
  /** Team key or null (all teams) */
  team: string | null;
  /** Project id for kind = 'project' */
  project?: string | null;
  /** Sprint number for kind = 'plan' | 'planned' (null = next sprint in planning) */
  sprint?: string | null;
}

export interface ViewState {
  route: ViewRoute;
  filters: Filters;
  quick: string;
  quickOpen: boolean;
  display: Display;
}

/** What a list row needs to render. */
export interface RowState {
  id: IssueId;
  key: string;
  title: string;
  status: Status;
  statusLabel: string;
  /** The status's own color (#rrggbb), else null */
  statusColor: string | null;
  priority: Priority;
  priorityLabel: string;
  team: TeamBadge;
  labels: { id: string; name: string; hue: number }[];
  project: string | null;
  sprint: { name: string; late: boolean; active: boolean } | null;
  estimate: number | null;
  due: { label: string; overdue: boolean; soon: boolean } | null;
  /** Snoozed until (column "Snoozed") */
  snoozed: string | null;
  created: string;
  updated: string;
  /** "3 hours ago" (inbox) */
  age: string;
  deleted: string | null;
  /** Unread inbox entry: an agent created or changed the issue, the owner has not looked at it yet */
  unread: boolean;
  /** What the inbox entry says ("Aleister set the status to Done"); empty outside the inbox */
  inboxText: string;
  /** Still being saved */
  pending: boolean;
  createdBy: string;
  /** Decision when completing the sprint */
  decision: { outcome: 'next' | 'backlog' | 'canceled'; label: string } | null;
  focused: boolean;
  selected: boolean;
}

export interface TeamBadge {
  id: string;
  key: string;
  name: string;
  hue: number;
  /** Logo URL for the color scheme, else null (placeholder) */
  logo: string | null;
}

export type ListRow =
  | { kind: 'group'; key: string; group: GroupInfo; count: number; collapsed: boolean }
  | { kind: 'issue'; key: string; id: IssueId };

export interface GroupInfo {
  by: Grouping;
  /** Sub-group: the group it sits in */
  parent?: GroupInfo;
  /** The group's value (status, team id, priority …) as text */
  value: string;
  label: string;
  status?: Status;
  /** Status group: the status's own color */
  color?: string | null;
  priority?: Priority;
  team?: TeamBadge;
  /** Label groups: the label's color */
  hue?: number;
  /** Team groups: priority budget "Urgent 1/1 · High 3/3" */
  budget?: string;
  overBudget?: boolean;
}

export type RowStyle = 'issue' | 'inbox' | 'trash';

export interface ListState {
  rows: ListRow[];
  /** Number of issues (without group headers, collapsed ones included) */
  count: number;
  /** null = the list has content */
  empty: null | 'filtered' | 'none';
  style: RowStyle;
  /** Longest identifier (characters) for an aligned id column */
  keyChars: number;
  /** Widest identifier per team key as a pattern ("NOVA-0000"), measured in the UI */
  keySamples: string[];
}

// ---------------------------------------------------------------- Menus

export interface MenuItem {
  id: string;
  label: string;
  /** Second text after the name (muted), e.g. group or identifier */
  detail?: string;
  /** Small line below (search hit in the text) */
  snippet?: string;
  /** Shortcut on the right */
  shortcut?: string;
  /** Icon as SVG text (own icons only, never user data) */
  icon?: string;
  /** Team logo instead of an icon */
  team?: TeamBadge;
  /** Color dot (labels) */
  dot?: number;
  /** Current value (check mark) */
  checked?: boolean;
  /** Multiple choice: checkbox instead of check mark */
  checkbox?: boolean;
  /** Section (a heading is drawn when it changes) */
  section?: string;
  /** Opens a second level */
  submenu?: boolean;
  /** Extra search terms */
  keywords?: string;
  /** Destructive (red) */
  danger?: boolean;
  /** Issue shown as a preview while the item is highlighted */
  preview?: IssueId;
}

export type PaletteKind =
  | 'command'
  | 'search'
  | 'help'
  | 'filter'
  | 'status'
  | 'priority'
  | 'labels'
  | 'project'
  | 'sprint'
  | 'estimate'
  | 'due'
  | 'snooze'
  | 'parent'
  | 'team'
  | 'relation'
  | 'duplicate'
  | 'move'
  | 'repeat'
  | 'downgrade'
  | 'switchTeam'
  | 'article';

export interface PaletteState {
  kind: PaletteKind;
  title: string;
  placeholder: string;
  query: string;
  items: MenuItem[];
  active: number;
  /** What the action applies to: "KIU-12" or "3 issues" */
  targetLabel: string | null;
  /** Stays open after Enter (multiple choice) */
  multi: boolean;
  /** Anchored at an element (click), else centered at the top (keyboard) */
  anchor: { x: number; y: number; width?: number } | null;
  /** Second level: name of the first (for "‹ Status") */
  parent: string | null;
  /** Calendar for the due date */
  calendar: { month: string; selected: string | null; /** First day that can be picked (snooze: the day after today) */ min?: string } | null;
  /** Hint below the input (e.g. "tomorrow → Fri, Oct 10") */
  hint: string | null;
  /** Counts every opening: the UI then rebuilds the picker (focus, position), even while the previous one is still fading out. */
  seq: number;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
  active: number;
  /** Open submenu */
  sub: { parent: string; items: MenuItem[]; active: number; multi: boolean; y: number } | null;
  targetLabel: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
  /** Second line: the reason for errors */
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface SyncState {
  /** empty: no data yet; cache: from IndexedDB; syncing: subscriptions running; live: everything from the server */
  phase: 'empty' | 'cache' | 'syncing' | 'live';
  pending: number;
  connected: boolean;
  /** Without connection for OFFLINE_AFTER, in any phase: also when starting from the cache */
  offline: boolean;
  /** Shown only when writes pile up or without connection */
  visible: boolean;
  text: string;
}
