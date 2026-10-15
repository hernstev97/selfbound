// List of the current view: filters, display, focus, selection, groups, scroll position.
// Computes outside the components and passes unchanged results through (reuseList), so Svelte
// only redraws changed rows.
import { t, tn, translated } from '../i18n.ts';
import { OUTCOME_LABEL, PRIORITY_LABEL, dueLabel, parseDay, relativeTime, shortDate, actorName } from '../format.ts';
import { statusFilterLabel, workflowsOf } from '../workflow.ts';
import { Slice, SliceFamily } from '../observable.ts';
import { computeList, emptyFilters, filterCount, groupKeyOf, keyWidth, reuseList, sameFilters, teamBadge, viewComparator, visibleFilter, type ListExtras } from '../query.ts';
import { computeBoard, reuseBoard } from '../board.ts';
import { stateGroupKey } from '../workflow.ts';

import { VIEWS, planSprint, viewKey, viewTitle, type ViewContext } from '../views.ts';
import { revealIndex, revealSpan } from '../window.ts';
import { inboxAt, unread } from '../inbox.ts';
import { entryText } from '../inboxText.ts';
import type { BoardColumn, BoardState, Display, Filters, Grouping, Issue, IssueId, ListState, Meta, Ordering, RowState, StateId, TeamBadge, ViewKind, ViewRoute, ViewState } from '../types.ts';
import type { App } from './index.ts';

/** A board column's scroll container; `span` is the position of a card (estimated while it is not measured). */
export interface ColumnScroller {
  el: HTMLElement;
  span(index: number): { top: number; bottom: number; measured: boolean };
}

export interface HeaderState {
  title: string;
  kind: ViewKind;
  team: TeamBadge | null;
  count: number;
  tabs: { label: string; route: ViewRoute; active: boolean }[];
  chips: { field: keyof Filters; label: string }[];
  filterCount: number;
  /** Display differs from the view's default (dot on the button) */
  displayChanged: boolean;
  quick: string;
  quickOpen: boolean;
}

/**
 * Motion signal for rendering. Only a hint: list, focus and selection are already set; the UI may
 * show a short animation with it (or nothing).
 * - `toggle`: group at row `index` expanded or collapsed, `rows` issues were added or removed
 * - `moved`: these issues are somewhere else after a change (status, priority, column …)
 */
export type ListMotion = { kind: 'toggle'; key: string; index: number; rows: number; open: boolean } | { kind: 'moved'; ids: IssueId[] };

/** Up to this many changed issues, the UI shows where they ended up. */
const MOVED_MAX = 20;

const TAB_KINDS: ViewKind[] = ['all', 'active', 'backlog'];
const TAB_LABEL: Partial<Record<ViewKind, string>> = translated({ all: 'All issues', active: 'Active', backlog: 'Backlog' });

/** Does the ID fit the measured ID column (same team key, no more digits)? */
function keyFits(samples: readonly string[], key: string) {
  const dash = key.lastIndexOf('-');
  const prefix = key.slice(0, dash + 1);
  const digits = key.length - dash - 1;
  return samples.some((s) => s.startsWith(prefix) && s.length - prefix.length >= digits);
}

function readJson<T>(key: string): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export class ListController {
  readonly view: Slice<ViewState>;
  readonly list = new Slice<ListState>({ rows: [], count: 0, empty: null, style: 'issue', keyChars: 0, keySamples: [] });
  readonly header: Slice<HeaderState>;
  readonly rows: SliceFamily<IssueId, RowState | null>;
  readonly selectionCount = new Slice(0);
  /** Board: columns while the view is shown as a board, otherwise null */
  readonly board = new Slice<BoardState | null>(null);
  /** Motion signal, each signal a new object */
  readonly motion = new Slice<ListMotion | null>(null);

  #focus: IssueId | null = null;
  #selection = new Set<IssueId>();
  #anchor: IssueId | null = null;
  #order: IssueId[] = [];
  #rowIndex = new Map<IssueId, number>();
  /** Issues of the view (also in collapsed groups) */
  #visibleSet = new Set<IssueId>();
  #lastFocusIndex = 0;
  #autoFocus = false;
  #ownChanges = new Set<IssueId>();
  #collapsed = new Map<string, Set<string>>();
  #memory = new Map<string, { filters: Filters; quick: string }>();
  #scroll = new Map<string, number>();
  #scroller: HTMLElement | null = null;
  #keep = new Set<IssueId>();
  #recentFocus = 0;
  // Lookup tables, rebuilt when meta changes
  #labels = new Map<string, { name: string; hue: number }>();
  #projects = new Map<string, string>();
  #sprints = new Map<string, { name: string; state: string }>();
  #badges = new Map<string, TeamBadge>();
  /** Board: column and position per issue (also in collapsed columns) */
  #boardPos = new Map<IssueId, { col: number; index: number }>();
  #columnScrollers = new Map<string, ColumnScroller>();

  /**
   * Second list (right column of sprint planning): writes no URL and only computes while it is
   * needed (`idle` = false).
   */
  readonly side: boolean;
  idle: boolean;

  constructor(
    private app: App,
    opts: { side?: boolean } = {},
  ) {
    this.side = opts.side ?? false;
    this.idle = this.side;
    const route: ViewRoute = { kind: this.side ? 'planned' : 'inbox', team: null };
    this.view = new Slice<ViewState>({ route, filters: emptyFilters(), quick: '', quickOpen: false, display: this.displayFor(route) });
    this.header = new Slice(this.#computeHeader());
    this.rows = new SliceFamily((id) => this.#rowState(id));
  }

  // ---------------------------------------------------------------- Reading

  focusId() {
    return this.#focus;
  }

  isSelected(id: IssueId) {
    return this.#selection.has(id);
  }

  selection(): IssueId[] {
    return [...this.#selection];
  }

  /** Visible issues in list order (without collapsed ones). */
  order(): readonly IssueId[] {
    return this.#order;
  }

  isVisible(id: IssueId) {
    return this.#visibleSet.has(id);
  }

  /** Actions apply to the selection, otherwise to the focused issue. */
  targets(): IssueId[] {
    if (this.#selection.size > 0) return [...this.#selection];
    return this.#focus ? [this.#focus] : [];
  }

  context(): ViewContext {
    const route = this.view.get().route;
    const meta = this.app.store.meta.get();
    const planning = route.kind === 'plan' || route.kind === 'planned';
    return {
      teamId: route.team ? (meta?.teams.find((t) => t.key === route.team)?._id ?? 'unknown') : null,
      activeSprintId: meta?.sprints.find((s) => s.state === 'active')?._id ?? null,
      projectId: route.project ?? null,
      keep: this.#keep,
      board: this.isBoard(),
      ...(planning ? { planSprintId: planSprint(route, meta)?._id ?? null, activeTeams: new Set(meta?.teams.filter((t) => !t.dormant && t.wiki !== 'only').map((t) => t._id as string)) } : {}),
    };
  }

  teamBadge(teamId: string): TeamBadge {
    let badge = this.#badges.get(teamId);
    if (!badge) {
      badge = teamBadge(this.app.store.team(teamId), this.app.prefs.dark.get());
      this.#badges.set(teamId, badge);
    }
    return badge;
  }

  // ---------------------------------------------------------------- Data → derived state

  onMeta(meta: Meta | null) {
    this.#labels = new Map(meta?.labels.map((l) => [l._id, { name: l.name, hue: l.hue }]) ?? []);
    this.#projects = new Map(meta?.projects.map((p) => [p._id, p.name]) ?? []);
    this.#sprints = new Map(meta?.sprints.map((s) => [s._id, { name: s.name, state: s.state }]) ?? []);
    this.#badges.clear();
    this.rows.refreshAll();
    this.recompute();
  }

  onTheme() {
    this.#badges.clear();
    this.rows.refreshAll();
    this.recompute();
  }

  onIssues(ids: ReadonlySet<IssueId>) {
    for (const id of ids) this.rows.refresh(id);
    const quick = this.#tryInPlace(ids);
    // Pending issue confirmed: focus and selection move to the real one.
    const store = this.app.store;
    if (this.#focus && store.resolvedId(this.#focus) !== this.#focus && !store.isPending(this.#focus)) {
      this.#focus = store.resolvedId(this.#focus);
      this.rows.refresh(this.#focus);
    }
    for (const id of [...this.#selection]) {
      const real = store.resolvedId(id);
      if (real !== id && !store.isPending(id)) {
        this.#selection.delete(id);
        this.#selection.add(real);
        this.rows.refresh(real);
      }
    }
    if (quick) {
      this.#fixFocus();
      return;
    }
    const before = ids.size <= MOVED_MAX ? this.#places(ids) : null;
    this.recompute(true);
    if (before) this.#signalMoved(before);
  }

  /**
   * Place per issue: column or group header, and predecessor. If a change alters it, the issue has
   * moved (not just shifted because something was added above it).
   */
  #places(ids: Iterable<IssueId>): Map<IssueId, string | null> {
    const places = new Map<IssueId, string | null>();
    const board = this.board.get();
    const rows = this.list.get().rows;
    for (const id of ids) {
      if (board) {
        const pos = this.#boardPos.get(id);
        places.set(id, pos ? `${board.columns[pos.col].key}:${board.columns[pos.col].ids[pos.index - 1] ?? ''}` : null);
        continue;
      }
      const index = this.#rowIndex.get(id);
      places.set(id, index === undefined ? null : `${rows[this.#groupHeadBefore(index)]?.key ?? ''}:${rows[index - 1]?.key ?? ''}`);
    }
    return places;
  }

  #signalMoved(before: Map<IssueId, string | null>) {
    const after = this.#places(before.keys());
    // New in the view (null before) does not count: on confirmation the real issue replaces the pending one.
    const moved = [...before].filter(([id, place]) => place !== null && after.get(id) !== null && after.get(id) !== place).map(([id]) => id);
    if (moved.length) this.motion.set({ kind: 'moved', ids: moved });
  }

  /**
   * Few changed issues (agent, own change, server confirmation): if each stays in or out of the
   * view, at its place in the sort order and in its group, the list does not change. Then redrawing
   * the row is enough, without filtering and sorting 10,000 issues again.
   */
  #tryInPlace(ids: ReadonlySet<IssueId>): boolean {
    if (this.isBoard()) return this.#tryInPlaceBoard(ids);
    // Up to 200 issues (bulk change of a selection) the per-issue check pays off; O(log groups) per issue.
    if (this.idle || ids.size > 200 || this.#rowIndex.size === 0) return false;
    const view = this.view.get();
    const grouping = view.display.grouping;
    // Groups that do not depend on the issue alone: budget (team) and sprint scope.
    if (grouping === 'team' || grouping === 'scope') return false;
    const store = this.app.store;
    const matches = visibleFilter(view, store.meta.get(), this.context());
    const compare = viewComparator(view);
    const groupKey = groupKeyOf(grouping, {}, store.meta.get());
    const rows = this.list.get().rows;
    const issueAt = (i: number) => {
      const row = rows[i];
      return row?.kind === 'issue' ? store.get(row.id) : undefined;
    };
    for (const id of ids) {
      const next = store.get(id);
      const shown = next !== undefined && store.resolvedId(id) === id && matches(next);
      const index = this.#rowIndex.get(id);
      if (index === undefined) {
        // Not in the list (or in a collapsed group): must not become part of it either.
        if (shown || this.#visibleSet.has(id)) return false;
        continue;
      }
      if (!next || !shown) return false;
      const row = rows[index];
      if (row.kind !== 'issue' || !keyFits(this.list.get().keySamples, next.key)) return false;
      // Group (nearest group header above) and place in the sort order (neighbors in the list).
      if (groupKey) {
        const head = rows[this.#groupHeadBefore(index)];
        if (!head || head.kind !== 'group' || head.group.value !== groupKey(next)) return false;
      }
      const before = issueAt(index - 1);
      const after = issueAt(index + 1);
      if (before && compare(before, next) > 0) return false;
      if (after && compare(next, after) > 0) return false;
    }
    return true;
  }

  /**
   * Recompute the list. `anchor`: the data changed (not the view). Then the topmost visible row
   * stays in place on screen, even if issues are added or removed above it (an agent creates 10
   * issues).
   */
  recompute(anchor = false) {
    if (this.idle) return;
    const view = this.view.get();
    const meta = this.app.store.meta.get();
    const matches = visibleFilter(view, meta, this.context());
    const visible: Issue[] = [];
    for (const issue of this.app.store.all()) if (matches(issue)) visible.push(issue);
    visible.sort(viewComparator(view));
    this.#visibleSet = new Set();
    for (const issue of visible) this.#visibleSet.add(issue._id);
    if (this.isBoard()) {
      this.#recomputeBoard(visible, view, meta);
      return;
    }
    if (this.board.get()) {
      this.board.set(null);
      this.#boardPos.clear();
      // Back to the list: rebuild the rows (on the board the list was flat).
      this.list.set({ rows: [], count: 0, empty: null, style: 'issue', keyChars: 0, keySamples: [] });
    }
    const extras: ListExtras = {};
    if (view.display.grouping === 'scope') extras.kinds = this.app.store.sprintKinds.get();
    if (view.display.grouping === 'team') extras.budget = this.app.budgetLabels();
    const next = reuseList(this.list.get(), computeList(visible, view, meta, this.#collapsedFor(view.route), this.app.prefs.dark.get(), extras));
    if (next !== this.list.get()) {
      const keep = anchor ? this.#scrollAnchor() : null;
      this.rows.prune();
      this.list.set(next);
      this.#order = [];
      this.#rowIndex.clear();
      this.#groupStarts = [];
      next.rows.forEach((row, index) => {
        if (row.kind === 'group') this.#groupStarts.push(index);
        if (row.kind === 'issue') {
          this.#order.push(row.id);
          this.#rowIndex.set(row.id, index);
        }
      });
      if (keep) this.#restoreAnchor(keep);
    }
    this.header.set(this.#computeHeader());
    this.#fixFocus();
  }

  // ---------------------------------------------------------------- Board

  /** Is the view shown as a board? */
  isBoard() {
    const view = this.view.get();
    return view.display.layout === 'board' && !!VIEWS[view.route.kind].boardTypes;
  }

  /** Ctrl B: list ↔ board. Focus stays on the same issue. */
  toggleLayout() {
    if (!VIEWS[this.view.get().route.kind].boardTypes) return;
    this.setDisplay({ layout: this.isBoard() ? 'list' : 'board' });
  }

  #recomputeBoard(visible: Issue[], view: ViewState, meta: Meta | null) {
    const prev = this.board.get();
    const next = reuseBoard(prev, computeBoard(visible, view, meta, this.#collapsedFor(view.route)));
    if (next !== prev) {
      this.rows.prune();
      this.board.set(next);
      this.#order = [];
      this.#rowIndex.clear();
      this.#boardPos.clear();
      this.#groupStarts = [];
      next.columns.forEach((column, col) => {
        column.ids.forEach((id, index) => {
          this.#boardPos.set(id, { col, index });
          if (column.collapsed) return;
          this.#rowIndex.set(id, this.#order.length);
          this.#order.push(id);
        });
      });
      // Flat list for everything that expects rows (header, selection, paging in peek).
      this.list.set({ rows: this.#order.map((id) => ({ kind: 'issue', key: id, id })), count: next.count, empty: next.empty, style: VIEWS[view.route.kind].style, ...keyWidth(visible) });
    }
    this.header.set(this.#computeHeader());
    this.#fixFocus();
  }

  /** Few changed issues: if each stays in its column and place, only redraw the card. */
  #tryInPlaceBoard(ids: ReadonlySet<IssueId>): boolean {
    const board = this.board.get();
    if (this.idle || !board || ids.size > 200) return false;
    const view = this.view.get();
    const store = this.app.store;
    const meta = store.meta.get();
    const matches = visibleFilter(view, meta, this.context());
    const compare = viewComparator(view);
    const workflows = workflowsOf(meta);
    for (const id of ids) {
      const next = store.get(id);
      const shown = next !== undefined && store.resolvedId(id) === id && matches(next);
      const pos = this.#boardPos.get(id);
      if (!pos) {
        if (shown || this.#visibleSet.has(id)) return false;
        continue;
      }
      if (!next || !shown) return false;
      const column = board.columns[pos.col];
      if (stateGroupKey(workflows.of(next)) !== column.key) return false;
      const before = column.ids[pos.index - 1];
      const after = column.ids[pos.index + 1];
      const b = before ? store.get(before) : undefined;
      const a = after ? store.get(after) : undefined;
      if (b && compare(b, next) > 0) return false;
      if (a && compare(next, a) > 0) return false;
    }
    return true;
  }

  /** Collapse or expand a column (done and canceled are collapsed by default). */
  toggleColumn(key: string) {
    const column = this.board.get()?.columns.find((c) => c.key === key);
    if (!column) return;
    const route = this.view.get().route;
    const set = this.#collapsedFor(route);
    const closed = column.type === 'completed' || column.type === 'canceled';
    const mark = closed ? `b+:${key}` : `b-:${key}`;
    if (set.has(mark)) set.delete(mark);
    else set.add(mark);
    writeJson(`xlr8:collapsed:${viewKey(route)}`, [...set]);
    this.recompute();
  }

  registerColumnScroller(key: string, scroller: ColumnScroller | null) {
    if (scroller) this.#columnScrollers.set(key, scroller);
    else this.#columnScrollers.delete(key);
  }

  /** Column of the focused issue (index) or -1. */
  #focusColumn() {
    return this.#focus ? (this.#boardPos.get(this.#focus)?.col ?? -1) : -1;
  }

  /** ←/→: to the next column with cards, at the same height if possible. */
  moveColumn(delta: -1 | 1) {
    const board = this.board.get();
    if (!board) return;
    this.#recentFocus = performance.now();
    const pos = this.#focus ? this.#boardPos.get(this.#focus) : undefined;
    let col = pos ? pos.col : delta > 0 ? -1 : board.columns.length;
    for (col += delta; col >= 0 && col < board.columns.length; col += delta) {
      const column = board.columns[col];
      if (column.collapsed || column.ids.length === 0) continue;
      this.#setFocus(column.ids[Math.min(pos?.index ?? 0, column.ids.length - 1)]);
      return;
    }
  }

  /** Status of an issue for a column: its team's status with the same type and name. */
  #stateFor(issue: Issue, column: BoardColumn): StateId | undefined {
    const state = workflowsOf(this.app.store.meta.get()).byName(issue.teamId, column.label);
    return state && stateGroupKey(state) === column.key ? state._id : undefined;
  }

  /**
   * May `ids` go into the column? Returns null (yes) or the reason (status missing in the team,
   * fixed order). Same rule as in the backend (`allowedTargets`).
   */
  dropProblem(ids: readonly IssueId[], key: string): string | null {
    const column = this.board.get()?.columns.find((c) => c.key === key);
    if (!column) return t('Column does not exist');
    const workflows = workflowsOf(this.app.store.meta.get());
    for (const id of ids) {
      const issue = this.app.store.get(id);
      if (!issue) continue;
      const target = this.#stateFor(issue, column);
      if (!target) {
        const team = this.app.store.team(issue.teamId)?.name;
        return team ? t('{team} has no status “{status}”', { team, status: column.label }) : t('This team has no status “{status}”', { status: column.label });
      }
      if (target === issue.stateId) continue;
      const allowed = workflows.allowed(issue.teamId, issue.stateId ?? null);
      if (allowed && !allowed.has(target)) return t('{key}: “{from}” → “{to}” is not allowed (fixed order)', { key: issue.key, from: workflows.of(issue).name, to: column.label });
    }
    return null;
  }

  /** Put cards into a column (drag, Shift ←/→). Not allowed: notice, nothing happens. */
  dropOnColumn(ids: readonly IssueId[], key: string): boolean {
    const column = this.board.get()?.columns.find((c) => c.key === key);
    if (!column) return false;
    const problem = this.dropProblem(ids, key);
    if (problem) {
      this.app.toasts.show(problem, undefined, 'error');
      return false;
    }
    this.app.edit.setState([...ids], (issue) => this.#stateFor(issue, column));
    return true;
  }

  /** Shift ←/→: move the selection or focused card one column (also into collapsed ones). */
  moveCard(delta: -1 | 1) {
    const board = this.board.get();
    const col = this.#focusColumn();
    if (!board || col < 0) return;
    const target = board.columns[col + delta];
    if (!target) return;
    const ids = this.targets();
    if (this.dropOnColumn(ids, target.key) && target.collapsed) {
      const what = ids.length === 1 ? (this.app.store.get(ids[0])?.key ?? t('Issue')) : tn(ids.length, '{count} issue', '{count} issues');
      this.app.toasts.show(`${what} → ${target.label}`);
    }
  }

  /** Row indices of the group headers, ascending */
  #groupStarts: number[] = [];

  /** Index of the group header above row `index` (-1: none), by binary search. */
  #groupHeadBefore(index: number) {
    const starts = this.#groupStarts;
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < index) {
        found = starts[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /** Topmost (fully or partly) visible issue and its distance from the top edge. */
  #scrollAnchor(): { id: IssueId; offset: number } | null {
    const el = this.#scroller;
    if (!el || el.scrollTop <= 0) return null;
    const h = this.app.rowHeight();
    const rows = this.list.get().rows;
    for (let i = Math.floor(el.scrollTop / h); i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === 'issue') return { id: row.id, offset: i * h - el.scrollTop };
    }
    return null;
  }

  #restoreAnchor(anchor: { id: IssueId; offset: number }) {
    const el = this.#scroller;
    const index = this.#rowIndex.get(anchor.id);
    if (!el || index === undefined) return;
    const top = index * this.app.rowHeight() - anchor.offset;
    if (Math.abs(top - el.scrollTop) >= 1) {
      el.scrollTop = top;
      this.saveScroll(el.scrollTop);
    }
  }

  // If the focused issue drops out of the view, the focus moves to its neighbor.
  #fixFocus() {
    const focus = this.#focus;
    const listPage = this.app.nav.page.get().name === 'view';
    if (focus && !this.#rowIndex.has(focus)) {
      const issue = this.app.store.get(focus);
      if (issue && this.#ownChanges.has(focus) && listPage && !this.#visibleSet.has(focus)) {
        this.app.edit.toastForLast(t('{key} is no longer in this view', { key: issue.key }));
      }
      const next = this.#order[Math.min(this.#lastFocusIndex, this.#order.length - 1)] ?? null;
      this.#setFocus(next, false);
      if (next) this.#autoFocus = false;
    } else if ((!focus || this.#autoFocus) && this.#order.length > 0) {
      // An automatically set focus stays on the first row until someone moves it.
      // Otherwise it slides out of view while more batches load.
      if (focus !== this.#order[0]) this.#setFocus(this.#order[0], false);
      this.#autoFocus = true;
    }
    let changed = false;
    for (const id of this.#selection) {
      if (!this.#visibleSet.has(id)) {
        this.#selection.delete(id);
        this.rows.refresh(id);
        changed = true;
      }
    }
    if (changed || this.selectionCount.get() !== this.#selection.size) this.selectionCount.set(this.#selection.size);
    this.#ownChanges.clear();
  }

  /** Own change: if the issue then drops out of the view, show a notice. */
  noteOwnChange(ids: IssueId[]) {
    for (const id of ids) this.#ownChanges.add(id);
  }

  #rowState(id: IssueId): RowState | null {
    const issue = this.app.store.get(id);
    if (!issue) return null;
    const sprint = issue.sprintId ? this.#sprints.get(issue.sprintId) : undefined;
    const state = workflowsOf(this.app.store.meta.get()).of(issue);
    return {
      id,
      key: issue.key,
      title: issue.title,
      status: state.status,
      statusLabel: state.name,
      statusColor: state.color,
      priority: issue.priority,
      priorityLabel: PRIORITY_LABEL[issue.priority],
      team: this.teamBadge(issue.teamId),
      labels: issue.labelIds.map((labelId) => ({ id: labelId, name: this.#labels.get(labelId)?.name ?? '…', hue: this.#labels.get(labelId)?.hue ?? 0 })),
      project: issue.projectId ? (this.#projects.get(issue.projectId) ?? null) : null,
      sprint: sprint && sprint.state !== 'closed' ? { name: sprint.name, late: this.app.store.sprintKinds.get().get(id) === 'late', active: sprint.state === 'active' } : null,
      estimate: issue.estimate ?? null,
      due: issue.dueDate ? dueLabel(issue.dueDate) : null,
      snoozed: issue.snoozedUntil ? shortDate(parseDay(issue.snoozedUntil).getTime()) : null,
      created: shortDate(issue.createdAt),
      updated: shortDate(issue.updatedAt),
      age: relativeTime(inboxAt(issue)),
      deleted: issue.deletedAt !== undefined ? relativeTime(issue.deletedAt) : null,
      unread: unread(issue),
      inboxText: issue.inbox ? entryText(issue.inbox, this.app.store, this.app.store.agents.get()) : '',
      pending: !!issue.pending,
      createdBy: actorName(issue.createdBy, this.app.store.agents.get()),
      decision: this.#decision(id),
      focused: this.#focus === id && this.app.list === this,
      selected: this.#selection.has(id),
    };
  }

  /** Column in use changed (sprint planning): redraw the focus row. */
  refreshFocusRow() {
    if (this.#focus) this.#refreshFlags(this.#focus);
  }

  /** Update focus/selection of a row, keep the rest of the row state. */
  #refreshFlags(id: IssueId) {
    const focused = this.#focus === id && this.app.list === this;
    const selected = this.#selection.has(id);
    this.rows.refresh(id, (current) => (current && (current.focused !== focused || current.selected !== selected) ? { ...current, focused, selected } : current));
  }

  #decision(id: IssueId): RowState['decision'] {
    if (this.view?.get().route.kind !== 'close') return null;
    const outcome = this.app.sprintsLoaded()?.decision(id);
    return outcome ? { outcome, label: OUTCOME_LABEL[outcome] } : null;
  }

  #computeHeader(): HeaderState {
    const view = this.view.get();
    const meta = this.app?.store.meta.get() ?? null;
    const route = view.route;
    const team = route.team ? meta?.teams.find((t) => t.key === route.team) : undefined;
    const def = VIEWS[route.kind];
    const defaults = def.display(route);
    const tabs = TAB_KINDS.includes(route.kind) ? TAB_KINDS.map((kind) => ({ label: TAB_LABEL[kind]!, route: { kind, team: route.team }, active: kind === route.kind })) : [];
    const next: HeaderState = {
      title: viewTitle(route, meta),
      kind: route.kind,
      team: team ? this.teamBadge(team._id) : null,
      count: this.list?.get().count ?? 0,
      tabs,
      chips: this.#chips(view.filters, meta),
      filterCount: filterCount(view.filters),
      displayChanged: view.display.grouping !== defaults.grouping || view.display.ordering !== defaults.ordering || view.display.showClosed !== defaults.showClosed || view.display.props.join() !== defaults.props.join(),
      quick: view.quick,
      quickOpen: view.quickOpen,
    };
    const prev = this.header?.get();
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
    return next;
  }

  #chips(f: Filters, meta: Meta | null) {
    const chips: HeaderState['chips'] = [];
    const none = t('none');
    const names = (ids: string[], map: Map<string, string>) => ids.map((id) => map.get(id) ?? (id === 'none' ? none : '?')).join(', ');
    if (f.status.length) chips.push({ field: 'status', label: t('Status: {values}', { values: f.status.map((s) => statusFilterLabel(meta, s)).join(', ') }) });
    if (f.priority.length) chips.push({ field: 'priority', label: t('Priority: {values}', { values: f.priority.map((p) => PRIORITY_LABEL[p]).join(', ') }) });
    if (f.team.length) chips.push({ field: 'team', label: t('Team: {values}', { values: f.team.map((k) => meta?.teams.find((team) => team.key === k)?.name ?? k).join(', ') }) });
    if (f.label.length) chips.push({ field: 'label', label: t('Label: {values}', { values: names(f.label, new Map(meta?.labels.map((l) => [l._id, l.name]))) }) });
    if (f.project.length) chips.push({ field: 'project', label: t('Project: {values}', { values: names(f.project, new Map(meta?.projects.map((p) => [p._id, p.name]))) }) });
    if (f.sprint.length) chips.push({ field: 'sprint', label: t('Sprint: {values}', { values: names(f.sprint, new Map(meta?.sprints.map((s) => [s._id, s.name]))) }) });
    if (f.unreviewed) chips.push({ field: 'unreviewed', label: t('Unread') });
    if (f.snoozed) chips.push({ field: 'snoozed', label: t('With snoozed') });
    return chips;
  }

  // ---------------------------------------------------------------- Switching views

  /** Display of a view: saved choice, otherwise the default. */
  displayFor(route: ViewRoute): Display {
    const def = VIEWS[route.kind];
    const base = def.display(route);
    const saved = readJson<Partial<Display>>(`xlr8:display:${viewKey(route)}`);
    if (!saved) return base;
    return {
      grouping: saved.grouping && def.groupings.includes(saved.grouping) ? saved.grouping : base.grouping,
      ordering: saved.ordering && def.orderings.includes(saved.ordering) ? saved.ordering : base.ordering,
      props: Array.isArray(saved.props) ? saved.props : base.props,
      showClosed: typeof saved.showClosed === 'boolean' ? saved.showClosed : base.showClosed,
      ...(saved.layout === 'board' && def.boardTypes ? { layout: 'board' as const } : {}),
    };
  }

  /**
   * Switch to a view. Without given values, the filters last set there apply; with given values
   * (URL), those.
   */
  setRoute(route: ViewRoute, given?: { filters?: Filters; quick?: string; group?: Grouping | null; order?: Ordering | null; layout?: 'board' | null }) {
    const prev = this.view.get();
    const prevKey = viewKey(prev.route);
    const key = viewKey(route);
    this.#memory.set(prevKey, { filters: prev.filters, quick: prev.quick });
    if (prevKey !== key) this.#keep.clear();
    const remembered = this.#memory.get(key);
    const display = { ...this.displayFor(route) };
    if (given?.group && VIEWS[route.kind].groupings.includes(given.group)) display.grouping = given.group;
    if (given?.order && VIEWS[route.kind].orderings.includes(given.order)) display.ordering = given.order;
    if (given?.layout === 'board' && VIEWS[route.kind].boardTypes) display.layout = 'board';
    const filters = given?.filters && filterCount(given.filters) > 0 ? given.filters : (remembered?.filters ?? emptyFilters());
    const quick = given?.quick ?? remembered?.quick ?? '';
    const same = prevKey === key && (prev.route.sprint ?? null) === (route.sprint ?? null) && sameFilters(prev.filters, filters) && prev.quick === quick && JSON.stringify(prev.display) === JSON.stringify(display);
    const wasIdle = this.idle;
    this.idle = false;
    if (same && !wasIdle) return;
    if (prevKey !== key) {
      this.#setSelection(new Set());
      // New view: focus starts at the top, unless the focused issue is here too.
      this.#autoFocus = true;
    }
    this.view.set({ route, filters, quick, quickOpen: quick !== '', display });
    this.recompute();
    if (prevKey !== key) this.#restoreScroll();
  }

  #syncUrl() {
    if (!this.side) this.app.nav.syncUrl('replace');
  }

  setDisplay(patch: Partial<Display>) {
    const view = this.view.get();
    const display = { ...view.display, ...patch };
    this.view.set({ ...view, display });
    writeJson(`xlr8:display:${viewKey(view.route)}`, display);
    this.recompute();
    this.#syncUrl();
    // Changing grouping/ordering keeps the focused issue in view.
    queueMicrotask(() => this.revealFocus());
  }

  resetDisplay() {
    const view = this.view.get();
    writeJson(`xlr8:display:${viewKey(view.route)}`, null);
    this.view.set({ ...view, display: VIEWS[view.route.kind].display(view.route) });
    this.recompute();
    this.#syncUrl();
  }

  toggleProp(prop: Display['props'][number]) {
    const props = this.view.get().display.props;
    this.setDisplay({ props: props.includes(prop) ? props.filter((p) => p !== prop) : [...props, prop] });
  }

  setFilters(filters: Filters) {
    this.view.set({ ...this.view.get(), filters });
    this.recompute();
    this.#syncUrl();
  }

  toggleFilter<K extends Exclude<keyof Filters, 'unreviewed' | 'snoozed'>>(field: K, value: Filters[K][number]) {
    const current = this.view.get().filters[field] as unknown[];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    this.setFilters({ ...this.view.get().filters, [field]: next });
  }

  toggleUnreviewed() {
    this.setFilters({ ...this.view.get().filters, unreviewed: !this.view.get().filters.unreviewed });
  }

  toggleSnoozed() {
    this.setFilters({ ...this.view.get().filters, snoozed: !this.view.get().filters.snoozed });
  }

  removeFilter(field: keyof Filters) {
    this.setFilters({ ...this.view.get().filters, [field]: field === 'unreviewed' || field === 'snoozed' ? false : [] });
  }

  clearFilters() {
    this.view.set({ ...this.view.get(), filters: emptyFilters(), quick: '', quickOpen: false });
    this.recompute();
    this.#syncUrl();
  }

  openQuick() {
    this.view.set({ ...this.view.get(), quickOpen: true });
    this.header.set(this.#computeHeader());
  }

  setQuick(quick: string) {
    this.view.set({ ...this.view.get(), quick, quickOpen: true });
    this.recompute();
    this.#syncUrl();
  }

  closeQuick() {
    this.view.set({ ...this.view.get(), quick: '', quickOpen: false });
    this.recompute();
    this.#syncUrl();
  }

  /** Issues read during this visit stay in the "Unread" filter. */
  keep(ids: IssueId[]) {
    for (const id of ids) this.#keep.add(id);
  }

  // ---------------------------------------------------------------- Groups

  #collapsedFor(route: ViewRoute): Set<string> {
    const key = viewKey(route);
    let set = this.#collapsed.get(key);
    if (!set) {
      set = new Set(readJson<string[]>(`xlr8:collapsed:${key}`) ?? []);
      this.#collapsed.set(key, set);
    }
    return set;
  }

  toggleGroup(groupKey: string) {
    const route = this.view.get().route;
    const set = this.#collapsedFor(route);
    const open = set.has(groupKey);
    if (open) set.delete(groupKey);
    else set.add(groupKey);
    writeJson(`xlr8:collapsed:${viewKey(route)}`, [...set]);
    this.recompute();
    const rows = this.list.get().rows;
    const index = rows.findIndex((row) => row.kind === 'group' && row.key === groupKey);
    const head = rows[index];
    if (head?.kind === 'group' && head.count > 0) this.motion.set({ kind: 'toggle', key: groupKey, index, rows: head.count, open });
  }

  /** T: collapse/expand the focused issue's group. A second T right after expands it again. */
  toggleFocusedGroup() {
    const last = this.#lastToggled;
    if (last && last.focus === this.#focus && this.#collapsedFor(this.view.get().route).has(last.key)) {
      this.#lastToggled = null;
      this.toggleGroup(last.key);
      if (last.previous) this.#setFocus(last.previous);
      return;
    }
    const rows = this.list.get().rows;
    const index = this.#focus ? this.#rowIndex.get(this.#focus) : undefined;
    let groupKey: string | null = null;
    for (let i = index ?? -1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === 'group') {
        groupKey = row.key;
        break;
      }
    }
    if (!groupKey) {
      // No focus in a group: expand all collapsed groups.
      const route = this.view.get().route;
      const set = this.#collapsedFor(route);
      if (set.size === 0) return;
      set.clear();
      writeJson(`xlr8:collapsed:${viewKey(route)}`, []);
      this.recompute();
      return;
    }
    const previous = this.#focus;
    this.toggleGroup(groupKey);
    this.#lastToggled = { key: groupKey, focus: this.#focus, previous };
  }
  #lastToggled: { key: string; focus: IssueId | null; previous: IssueId | null } | null = null;

  // ---------------------------------------------------------------- Focus, selection

  #setFocus(id: IssueId | null, reveal = true) {
    const old = this.#focus;
    if (old === id) return;
    this.#autoFocus = false;
    this.#focus = id;
    if (id) {
      const index = this.#order.indexOf(id);
      if (index >= 0) this.#lastFocusIndex = index;
    }
    // Only change the focus flag instead of deriving the whole row again (date texts, labels …).
    if (old) this.#refreshFlags(old);
    if (id) this.#refreshFlags(id);
    if (reveal) this.revealFocus();
    this.app.detail.onFocus(id);
  }

  focus(id: IssueId | null, reveal = false) {
    this.#setFocus(id, reveal);
  }

  revealFocus() {
    const id = this.#focus;
    const board = this.board.get();
    if (board) {
      const pos = id ? this.#boardPos.get(id) : undefined;
      const column = pos ? board.columns[pos.col] : undefined;
      const scroller = column ? this.#columnScrollers.get(column.key) : undefined;
      if (pos && scroller) {
        const { el } = scroller;
        const reveal = () => {
          const { top, bottom } = scroller.span(pos.index);
          revealSpan(el, top, bottom);
        };
        reveal();
        el.parentElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        // A card that was not measured yet is taller or shorter than its estimate once it is drawn.
        if (!scroller.span(pos.index).measured) requestAnimationFrame(() => requestAnimationFrame(() => this.#focus === id && reveal()));
      }
      return;
    }
    const index = id ? this.#rowIndex.get(id) : undefined;
    // Do not leave open notices at the bottom right (about 48 px each plus gap) over the row.
    const toasts = this.app.toasts.list.get().length;
    if (this.#scroller && index !== undefined) revealIndex(this.#scroller, index, this.app.rowHeight(), 0, toasts ? 24 + 56 * toasts : 0);
  }

  moveFocus(delta: number) {
    if (this.#order.length === 0) return;
    this.#recentFocus = performance.now();
    const board = this.board.get();
    if (board) {
      // Board: J/K stay in the column.
      const pos = this.#focus ? this.#boardPos.get(this.#focus) : undefined;
      const column = pos ? board.columns[pos.col] : undefined;
      if (!pos || !column || column.collapsed) return this.#setFocus(this.#order[0]);
      return this.#setFocus(column.ids[Math.max(0, Math.min(column.ids.length - 1, pos.index + delta))]);
    }
    const index = this.#focus ? this.#order.indexOf(this.#focus) : -1;
    const next = Math.max(0, Math.min(this.#order.length - 1, index < 0 ? 0 : index + delta));
    this.#setFocus(this.#order[next]);
  }

  focusEdge(end: boolean) {
    if (this.#order.length) this.#setFocus(this.#order[end ? this.#order.length - 1 : 0]);
  }

  #setSelection(next: Set<IssueId>) {
    const changed = new Set([...this.#selection, ...next].filter((id) => this.#selection.has(id) !== next.has(id)));
    this.#selection = next;
    for (const id of changed) this.#refreshFlags(id);
    this.selectionCount.set(next.size);
  }

  select(ids: IssueId[]) {
    this.#setSelection(new Set(ids.filter((id) => this.#visibleSet.has(id))));
  }

  toggleSelect(id = this.#focus) {
    if (!id) return;
    const next = new Set(this.#selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.#anchor = id;
    this.#setSelection(next);
  }

  extendSelection(delta: number) {
    if (!this.#focus) return;
    const next = new Set(this.#selection);
    next.add(this.#focus);
    this.moveFocus(delta);
    if (this.#focus) next.add(this.#focus);
    this.#setSelection(next);
  }

  selectAll() {
    this.#setSelection(new Set(this.#order));
  }

  clearSelection() {
    this.#setSelection(new Set());
  }

  /** Click on a row: Shift selects a range, Ctrl/⌘ toggles, otherwise open. */
  clickRow(id: IssueId, mods: { shift?: boolean; mod?: boolean } = {}) {
    if (mods.mod) return this.toggleSelect(id);
    if (mods.shift) {
      const from = this.#order.indexOf(this.#anchor ?? this.#focus ?? id);
      const to = this.#order.indexOf(id);
      const [a, b] = from < to ? [from, to] : [to, from];
      this.#setSelection(new Set([...this.#selection, ...this.#order.slice(a, b + 1)]));
      return this.#setFocus(id, false);
    }
    this.#setFocus(id, false);
    // Split inbox: show on the right instead of a separate page.
    if (this.app.splitLayout() && !this.side) return this.app.detail.openSplit();
    this.app.openIssue(id);
  }

  /** The mouse moves the focus (only real movement, not rows passing under it while scrolling). */
  hoverRow(id: IssueId) {
    if (this.#focus === id) return;
    if (this.app.palette.state.get() || this.app.menu.state.get()) return;
    // Split inbox: the focus is the issue shown on the right; the mouse must not change it.
    if (this.app.splitLayout()) return;
    if (performance.now() - this.#recentFocus < 250) return;
    this.#setFocus(id, false);
  }

  // ---------------------------------------------------------------- Scrolling

  registerScroller(el: HTMLElement | null) {
    this.#scroller = el;
    // A new element starts at the top: only set it if there is something to restore (setting
    // scrollTop would otherwise force a layout right on the first render).
    if (el && (this.#scroll.get(viewKey(this.view.get().route)) ?? 0) > 0) this.#restoreScroll();
  }

  saveScroll(top: number) {
    this.#scroll.set(viewKey(this.view.get().route), top);
  }

  #restoreScroll() {
    if (!this.#scroller) return;
    this.#scroller.scrollTop = this.#scroll.get(viewKey(this.view.get().route)) ?? 0;
  }

  /** Neighbor in the list (paging in peek, detail ↑/↓). */
  neighbor(id: IssueId, delta: number): IssueId | null {
    const index = this.#order.indexOf(id);
    if (index < 0) return null;
    return this.#order[index + delta] ?? null;
  }

  /** All issues of the view (also in collapsed groups), e.g. for clearing the inbox. */
  visibleIds(): IssueId[] {
    return [...this.#visibleSet];
  }

  positionOf(id: IssueId): { index: number; total: number } | null {
    const index = this.#order.indexOf(id);
    return index < 0 ? null : { index, total: this.#order.length };
  }

  /** For measurement runs: reset the state without reloading. */
  reset() {
    this.#setSelection(new Set());
    this.view.set({ ...this.view.get(), quick: '', quickOpen: false, filters: emptyFilters() });
    this.recompute();
    this.#setFocus(this.#order[0] ?? null);
    if (this.#scroller) this.#scroller.scrollTop = 0;
  }
}

export type { Issue };
