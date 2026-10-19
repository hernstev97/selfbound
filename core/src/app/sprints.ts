// Sprints: active sprint, planning, completion, overview.
// The lists themselves are regular views (views.ts: sprint, plan, planned, close), so all
// shortcuts, peek, selection and undo work as everywhere else. This file holds only the header
// numbers, the decisions when completing a sprint and the sprint mutations.
import { api } from '@selfbound/backend/api';
import { msg, t, tn } from '../i18n.ts';
import { Slice } from '../observable.ts';
import type { Page } from '../route.ts';
import {
  budgetLabel,
  limitsOf,
  limitsSummary,
  closeSummary,
  defaultSprintRange,
  dropNeighbors,
  overBudget,
  priorityBudget,
  rangeLabel,
  remainingLabel,
  sprintStats,
  sprintTotals,
  type CloseSummary,
  type Outcome,
  type SprintItem,
  type SprintStats,
  type SprintTotals,
} from '../sprintlogic.ts';
import { overLimit } from '@selfbound/backend/shared/priorityLimits';
import type { Issue, IssueId, SprintDoc, SprintId, TeamBadge } from '../types.ts';
import { planSprint } from '../views.ts';
import { registerAction } from './actions.ts';
import type { App } from './index.ts';
import type { ListController } from './list.ts';
import { errorMessage } from './toasts.ts';

export interface SprintSummary {
  id: SprintId;
  number: number;
  name: string;
  goal: string;
  state: SprintDoc['state'];
  startDate: string;
  endDate: string;
  range: string;
  remaining: string;
  capacity: number | null;
  retro: string;
  totals: SprintTotals;
}

export interface PlanState {
  /** null: no sprint in planning (the page offers to create one) */
  sprint: SprintSummary | null;
  /** Suggestion from the last 3 Selfbound sprints */
  suggestion: { capacity: number | null; basis: string } | null;
  /** Is a sprint running? Then the planned one can only start after it is completed. */
  running: { name: string; number: number } | null;
  /** Other sprints in planning (to switch between) */
  others: { number: number; name: string }[];
  /** Priority limits per active team (count, and whether it is over the limit) */
  teams: { badge: TeamBadge; label: string; over: boolean; urgent: number; high: number; overUrgent: boolean; overHigh: boolean }[];
  /** The limits (null = none) and their description */
  limits: { urgent: number | null; high: number | null; title: string };
  /** Defaults for a new sprint; `after`: name of the open sprint it starts after (else next Monday) */
  defaults: { name: string; startDate: string; endDate: string; after: string | null };
}

export interface CloseState {
  sprint: SprintSummary | null;
  summary: CloseSummary;
  /** Target for "Next sprint": a sprint in planning or a new one */
  targets: { id: string; label: string }[];
  target: string;
}

export interface SprintRow {
  id: SprintId;
  number: number;
  name: string;
  goal: string;
  state: SprintDoc['state'];
  source: SprintDoc['source'];
  range: string;
  remaining: string;
  stats: SprintStats | null;
}

const EMPTY_TOTALS = sprintTotals([]);

export class SprintController {
  /** Active sprint (header of /sprint, sidebar) */
  readonly active = new Slice<SprintSummary | null>(null);
  readonly plan = new Slice<PlanState | null>(null);
  readonly closing = new Slice<CloseState | null>(null);
  /** /sprints */
  readonly rows = new Slice<SprintRow[] | null>(null);
  /** Edit form (name, dates, capacity) in the header of the active sprint is open. */
  readonly editing = new Slice(false);

  /** Retro text when completing (a field on the page, kept here for Ctrl+Enter) */
  retroDraft = '';
  #decisions = new Map<IssueId, Outcome>();
  #target: string | null = null;
  #page: 'sprint' | 'plan' | 'close' | 'sprints' | null = null;
  #suggestion: { slice: Slice<unknown>; release: () => void } | null = null;
  #list: { slice: Slice<unknown>; release: () => void; stop: () => void } | null = null;
  #items = new Map<string, { slice: Slice<unknown>; release: () => void; stop: () => void }>();

  constructor(private app: App) {}

  // ---------------------------------------------------------------- Pages

  onPage(page: Page) {
    const kind = page.name === 'view' ? page.view.kind : null;
    const next = page.name === 'sprints' ? 'sprints' : kind === 'sprint' ? 'sprint' : kind === 'plan' ? 'plan' : kind === 'close' ? 'close' : null;
    if (next === this.#page) return this.refresh();
    if (this.#page === 'close') {
      this.#decisions.clear();
      this.#target = null;
    }
    this.#page = next;
    if (next !== 'sprint') this.editing.set(false);
    if (next === 'plan' && !this.#suggestion) {
      this.#suggestion = this.app.store.watch(api.sprints.capacitySuggestion, {});
      this.#suggestion.slice.subscribe(() => this.refresh());
    } else if (next !== 'plan' && this.#suggestion) {
      this.#suggestion.release();
      this.#suggestion = null;
    }
    if (next === 'sprints') this.#watchList();
    else this.#unwatchList();
    this.refresh();
  }

  /** After changes to issues, metadata or subscriptions: only the numbers of the current page. */
  refresh() {
    const meta = this.app.store.meta.get();
    const activeDoc = meta?.sprints.find((s) => s.state === 'active') ?? null;
    if (this.#page === 'sprint' || this.#page === 'close') this.active.set(activeDoc ? this.#summary(activeDoc) : null);
    if (this.#page === 'plan') this.plan.set(this.#planState());
    if (this.#page === 'close') this.closing.set(this.#closeState(activeDoc));
    if (this.#page === 'sprints') this.rows.set(this.#rows());
  }

  #issuesOf(sprintId: string): Issue[] {
    const out: Issue[] = [];
    for (const issue of this.app.store.all()) if (issue.sprintId === sprintId && issue.deletedAt === undefined && !issue.pending) out.push(issue);
    return out;
  }

  #summary(doc: SprintDoc): SprintSummary {
    const issues = this.#issuesOf(doc._id);
    const kinds = doc.state === 'active' ? this.app.store.sprintKinds.get() : new Map();
    const prev = (doc.state === 'active' ? this.active.get() : this.plan.get()?.sprint) ?? null;
    const next: SprintSummary = {
      id: doc._id,
      number: doc.number,
      name: doc.name,
      goal: doc.goal,
      state: doc.state,
      startDate: doc.startDate,
      endDate: doc.endDate,
      range: rangeLabel(doc.startDate, doc.endDate),
      remaining: remainingLabel(doc),
      capacity: doc.capacity ?? null,
      retro: doc.retro ?? '',
      totals: issues.length ? sprintTotals(issues, kinds) : EMPTY_TOTALS,
    };
    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  }

  #planState(): PlanState {
    const meta = this.app.store.meta.get();
    const route = this.app.main.view.get().route;
    const doc = planSprint(route, meta);
    const suggestion = this.#suggestion?.slice.get() as { capacity: number | null; basis: { name: string; donePoints: number }[] } | undefined;
    const running = meta?.sprints.find((s) => s.state === 'active');
    const budget = priorityBudget(this.app.store.all());
    const limits = limitsOf(meta);
    const { startDate, endDate, follows } = defaultSprintRange(undefined, (meta?.sprints ?? []).filter((s) => s.state === 'active' || s.state === 'planning'));
    const nextNumber = Math.max(0, ...(meta?.sprints.map((s) => s.number) ?? [0])) + 1;
    const next: PlanState = {
      sprint: doc ? this.#summary(doc) : null,
      suggestion: suggestion
        ? { capacity: suggestion.capacity, basis: suggestion.basis.length ? suggestion.basis.map((b) => `${b.name}: ${b.donePoints}`).join(' · ') : t('No completed Selfbound sprints yet') }
        : null,
      running: running ? { name: running.name, number: running.number } : null,
      others: (meta?.sprints ?? []).filter((s) => s.state === 'planning').sort((a, b) => a.number - b.number).map((s) => ({ number: s.number, name: s.name })),
      teams: (meta?.teams ?? [])
        .filter((t) => !t.dormant && t.wiki !== 'only')
        .map((t) => {
          const b = budget.get(t._id);
          const urgent = b?.urgent ?? 0;
          const high = b?.high ?? 0;
          return {
            badge: this.app.main.teamBadge(t._id),
            label: budgetLabel(b, limits),
            over: overBudget(b, limits),
            urgent,
            high,
            overUrgent: overLimit(limits.urgent, urgent),
            overHigh: overLimit(limits.high, high),
          };
        }),
      limits: { urgent: limits.urgent.max, high: limits.high.max, title: limitsSummary(limits) },
      defaults: { name: `Sprint ${nextNumber}`, startDate, endDate, after: follows?.name ?? null },
    };
    const prev = this.plan.get();
    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  }

  #closeState(doc: SprintDoc | null): CloseState {
    const meta = this.app.store.meta.get();
    const planning = (meta?.sprints ?? []).filter((s) => s.state === 'planning').sort((a, b) => a.number - b.number);
    const targets = [...planning.map((s) => ({ id: s._id as string, label: s.name })), { id: 'new', label: t('New sprint (will be created)') }];
    // Without an explicit choice: the next sprint in planning, otherwise a new one.
    if (!this.#target || !targets.some((t) => t.id === this.#target)) this.#target = null;
    const target = this.#target ?? targets[0].id;
    const issues = doc ? this.#issuesOf(doc._id) : [];
    const next: CloseState = { sprint: doc ? this.#summary(doc) : null, summary: closeSummary(issues, this.#decisions), targets, target };
    const prev = this.closing.get();
    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  }

  // ---------------------------------------------------------------- Overview /sprints

  #watchList() {
    if (this.#list) return;
    const watch = this.app.store.watch(api.sprints.list, {});
    const stop = watch.slice.subscribe(() => {
      const docs = (watch.slice.get() as SprintDoc[] | undefined) ?? [];
      // Entries per sprint (small), at most the last 40.
      const wanted = new Set(docs.slice(0, 40).map((d) => d._id as string));
      for (const [id, entry] of this.#items) {
        if (!wanted.has(id)) {
          entry.stop();
          entry.release();
          this.#items.delete(id);
        }
      }
      for (const id of wanted) {
        if (this.#items.has(id)) continue;
        const w = this.app.store.watch(api.sprints.items, { sprintId: id as SprintId });
        const s = w.slice.subscribe(() => this.refresh());
        this.#items.set(id, { slice: w.slice, release: w.release, stop: s });
      }
      this.refresh();
    });
    this.#list = { slice: watch.slice, release: watch.release, stop };
  }

  #unwatchList() {
    if (!this.#list) return;
    this.#list.stop();
    this.#list.release();
    this.#list = null;
    for (const entry of this.#items.values()) {
      entry.stop();
      entry.release();
    }
    this.#items.clear();
    this.rows.set(null);
  }

  #rows(): SprintRow[] | null {
    const docs = this.#list?.slice.get() as SprintDoc[] | undefined;
    if (!docs) return null;
    const get = (id: IssueId) => this.app.store.get(id);
    const order = { active: 0, planning: 1, closed: 2 } as const;
    return [...docs]
      .sort((a, b) => order[a.state] - order[b.state] || (a.state === 'planning' ? a.number - b.number : b.number - a.number))
      .map((d) => {
        const items = this.#items.get(d._id)?.slice.get() as SprintItem[] | undefined;
        return {
          id: d._id,
          number: d.number,
          name: d.name,
          goal: d.goal,
          state: d.state,
          source: d.source,
          range: rangeLabel(d.startDate, d.endDate),
          remaining: remainingLabel(d),
          stats: items ? sprintStats(items, get) : null,
        };
      });
  }

  // ---------------------------------------------------------------- Completion: decisions

  decision(id: IssueId): Outcome | undefined {
    return this.#decisions.get(id);
  }

  /** 1/2/3 on the selection or focus; without a selection the focus moves on (as in triage). */
  decide(outcome: Outcome | null) {
    const list = this.app.main;
    const ids = this.app.targets();
    if (!ids.length) return;
    for (const id of ids) {
      if (outcome) this.#decisions.set(id, outcome);
      else this.#decisions.delete(id);
      list.rows.refresh(id);
    }
    if (list.selectionCount.get() > 0) list.clearSelection();
    else if (ids.length === 1) list.moveFocus(1);
    this.refresh();
  }

  setTarget(id: string) {
    this.#target = id;
    this.refresh();
  }

  async close(retro: string) {
    const state = this.closing.get();
    const sprint = state?.sprint;
    if (!state || !sprint) return;
    const decisions = this.#issuesOf(sprint.id)
      .filter((i) => this.#decisions.has(i._id) && ['triage', 'backlog', 'todo', 'in_progress', 'in_review'].includes(i.status))
      .map((i) => ({ issueId: i._id, outcome: this.#decisions.get(i._id)! }));
    try {
      if (retro.trim() && retro.trim() !== sprint.retro) await this.app.store.call(api.sprints.update, { sprintId: sprint.id, retro: retro.trim() });
      const result = await this.app.store.call(api.sprints.close, { sprintId: sprint.id, decisions, ...(state.target !== 'new' ? { nextSprintId: state.target as SprintId } : {}) });
      const c = result.counts;
      this.#decisions.clear();
      // Completed before the planned end: the server sets the end date to today.
      const early = result.endedEarly ? t('End date set to today') : undefined;
      this.app.toasts.show(
        t('{name} completed: {done} done, {next} carried over, {backlog} back to the backlog, {canceled} canceled', { name: sprint.name, done: c.done, next: c.next, backlog: c.backlog, canceled: c.canceled }),
        { label: t('All sprints'), run: () => this.app.nav.go({ name: 'sprints' }) },
        'info',
        early,
        early ? 7000 : 4000,
      );
      this.app.nav.goView({ kind: 'plan', team: null, sprint: null });
    } catch (error) {
      this.app.toasts.error(t('{name} not completed', { name: sprint.name }), error);
    }
  }

  // ---------------------------------------------------------------- Planning

  async create(fields: { name?: string; goal?: string; startDate?: string; endDate?: string; capacity?: number }) {
    try {
      const { number } = await this.app.store.call(api.sprints.create, fields);
      this.app.nav.goView({ kind: 'plan', team: null, sprint: String(number) }, { replace: true });
      return true;
    } catch (error) {
      this.app.toasts.error(t('Sprint not created'), error);
      return false;
    }
  }

  /** Changes name, goal, date range, capacity (optimistic in `meta.get`). */
  update(sprintId: SprintId, patch: { name?: string; goal?: string; startDate?: string; endDate?: string; capacity?: number | null; retro?: string }) {
    const now = Date.now();
    this.app.store
      .call(api.sprints.update, { sprintId, ...patch }, (store) => {
        const meta = store.getQuery(api.meta.get, {});
        if (!meta) return;
        store.setQuery(api.meta.get, {}, {
          ...meta,
          sprints: meta.sprints.map((s) => {
            if (s._id !== sprintId) return s;
            const next = { ...s, ...patch, updatedAt: now } as Record<string, unknown>;
            if (patch.capacity === null) delete next.capacity;
            return next as typeof s;
          }),
        });
      })
      .catch((error) => this.app.toasts.error(t('Sprint not updated'), error));
  }

  /** Capacity from a text field: empty clears it, a comma works as decimal separator, invalid input is ignored. */
  setCapacity(sprintId: SprintId, value: string) {
    const n = value.trim() === '' ? null : Number(value.replace(',', '.'));
    if (n !== null && (!Number.isFinite(n) || n < 0)) return;
    const current = this.app.store.meta.get()?.sprints.find((s) => s._id === sprintId)?.capacity ?? null;
    if (n !== current) this.update(sprintId, { capacity: n });
  }

  async start(sprintId: SprintId) {
    const meta = this.app.store.meta.get();
    const sprint = meta?.sprints.find((s) => s._id === sprintId);
    try {
      const result = await this.app.store.call(api.sprints.start, { sprintId });
      // Started before the planned start: the server moves the date range forward to today.
      const name = sprint?.name ?? t('Sprint');
      const text = result.moved
        ? t('{name} is running · start moved to today, now {range}', { name, range: rangeLabel(result.moved.startDate, result.moved.endDate) })
        : t('{name} is running', { name });
      this.app.toasts.show(text, undefined, 'info', undefined, result.moved ? 7000 : 4000);
      this.app.nav.goView({ kind: 'sprint', team: null });
    } catch (error) {
      this.app.toasts.error(t('{name} not started', { name: sprint?.name ?? t('Sprint') }), error);
    }
  }

  /** Planned sprint of the current planning page (or the next one in planning). */
  planSprintId(): SprintId | null {
    const page = this.app.nav.page.get();
    const route = page.name === 'view' && (page.view.kind === 'plan' || page.view.kind === 'planned') ? page.view : { kind: 'plan' as const, team: null };
    return planSprint(route, this.app.store.meta.get())?._id ?? null;
  }

  /** Into a sprint or out of it (undo like any change). */
  move(ids: IssueId[], sprintId: SprintId | null) {
    if (!ids.length) return;
    const meta = this.app.store.meta.get();
    const name = sprintId ? (meta?.sprints.find((s) => s._id === sprintId)?.name ?? t('Sprint')) : t('Backlog');
    this.app.edit.patch(ids, { sprintId }, { label: sprintId ? t('Planned into {name}', { name }) : t('Removed from the sprint'), quiet: true, expected: true });
    if (ids.length > 1) {
      const text = sprintId
        ? tn(ids.length, '{count} issue planned into {name}', '{count} issues planned into {name}', { name })
        : tn(ids.length, '{count} issue back to the backlog', '{count} issues back to the backlog');
      this.app.toasts.show(text, { label: t('Undo'), run: () => this.app.edit.undo() });
    }
  }

  /** Planning: → moves the selection/focus on the left into the sprint, ← returns it from the right. */
  shift(direction: 'in' | 'out') {
    const sprintId = this.planSprintId();
    if (!sprintId) return this.app.toasts.show(t('Create a sprint first'));
    const from = direction === 'in' ? this.app.main : this.app.side;
    if (this.app.list !== from) return;
    const ids = from.targets();
    if (!ids.length) return;
    this.move(ids, direction === 'in' ? sprintId : null);
    if (from.selectionCount.get() > 0) from.clearSelection();
  }

  /**
   * Drag and drop in planning: reorder within the same list (rank); between the lists plan in or
   * out and place at the drop position.
   */
  drop(ids: IssueId[], target: ListController, index: number) {
    if (!ids.length) return;
    const sprintId = this.planSprintId();
    const toSprint = target === this.app.side;
    const issues = ids.map((id) => this.app.store.get(id)).filter((i): i is Issue => !!i);
    const moving = issues.filter((i) => (toSprint ? i.sprintId !== sprintId : !!i.sprintId)).map((i) => i._id);
    if (moving.length) {
      if (toSprint && !sprintId) return this.app.toasts.show(t('Create a sprint first'));
      this.move(moving, toSprint ? sprintId : null);
    }
    // Placing only makes sense with manual ordering.
    if (target.view.get().display.ordering !== 'rank') return;
    const order = target.order();
    const { beforeId, afterId } = dropNeighbors(order, ids, index);
    if (!beforeId && !afterId) return;
    // Several: each one after the previous.
    let before = beforeId;
    for (const id of ids) {
      this.app.store.reorder(id, before, before === beforeId ? afterId : undefined).catch((error) => this.app.toasts.show(t('Order not saved'), undefined, 'error', errorMessage(error)));
      before = id;
    }
  }
}

// ---------------------------------------------------------------- Sprint page keyboard
// Registered only with this chunk (extension point registerAction): they work only on the
// planning and completion pages, where the chunk is always loaded.

const kind = (a: App) => (a.nav.page.get().name === 'view' ? a.main.view.get().route.kind : null);
const planPage = (a: App) => kind(a) === 'plan';
const hasTarget = (a: App) => a.targets().length > 0;
const closePage = (a: App) => kind(a) === 'close' && hasTarget(a);
for (const action of [
  { id: 'plan.in', label: msg('Move into sprint'), section: 'Sprint', keys: ['arrowright'], icon: 'chevronRight', when: (a) => planPage(a) && a.list === a.main && hasTarget(a), run: (a) => a.sprints.shift('in') },
  { id: 'plan.out', label: msg('Back to backlog'), section: 'Sprint', keys: ['arrowleft'], icon: 'chevronLeft', when: (a) => planPage(a) && a.list === a.side && hasTarget(a), run: (a) => a.sprints.shift('out') },
  { id: 'plan.pane', label: msg('Switch column (backlog / sprint)'), section: 'Sprint', keys: ['tab', 'shift+tab'], when: planPage, run: (a) => a.setPane(a.list === a.side ? 'main' : 'side') },
  { id: 'close.next', label: msg('Decision: next sprint'), section: 'Sprint', keys: ['1'], icon: 'chevronRight', when: closePage, run: (a) => a.sprints.decide('next') },
  { id: 'close.backlog', label: msg('Decision: back to backlog'), section: 'Sprint', keys: ['2'], icon: 'backlog', when: closePage, run: (a) => a.sprints.decide('backlog') },
  { id: 'close.cancel', label: msg('Decision: cancel'), section: 'Sprint', keys: ['3'], icon: 'close', when: closePage, run: (a) => a.sprints.decide('canceled') },
  { id: 'close.clear', label: msg('Clear decision'), section: 'Sprint', keys: ['0', 'backspace'], icon: 'undo', when: closePage, run: (a) => a.sprints.decide(null) },
  { id: 'close.submit', label: msg('Close sprint now'), section: 'Sprint', keys: ['mod+enter'], icon: 'check', when: (a) => kind(a) === 'close' && a.sprints.closing.get()?.summary.missing === 0, run: (a) => void a.sprints.close(a.sprints.retroDraft) },
] as Parameters<typeof registerAction>[0][]) registerAction(action);
