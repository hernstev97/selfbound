// Create dialog (C) with defaults from the context, "Create more", drafts that survive navigating
// away and closing the tab, and creating via URL (/new?…).
import { CLOSED, PRIORITY_KEYWORDS, PRIORITY_LABEL, STATUS_KEYWORDS, STATUS_LABEL, STATUS_ORDER, parseDueInput } from '../format.ts';
import { t, tc } from '../i18n.ts';
import { Slice } from '../observable.ts';
import { VIEWS } from '../views.ts';
import type { ModelChoice } from '../models.ts';
import type { IssueId, IssuePatch, NewIssue, Priority, StateId, Status } from '../types.ts';
import { defaultState, statusOfState } from '@selfbound/backend/shared/workflow';
import { workflowsOf } from '../workflow.ts';
import type { App } from './index.ts';

export interface Draft {
  id: string;
  teamId: string | null;
  title: string;
  description: string;
  /** Status type (applies when no team status is chosen) */
  status: Status;
  /** Chosen team status */
  stateId?: string | null;
  /** Status by name (group "+", filter, /new?status=…), resolved in the team on create */
  stateName?: string | null;
  priority: Priority;
  labelIds: string[];
  projectId: string | null;
  estimate: number | null;
  dueDate: string | null;
  parentId: string | null;
  sprintId: string | null;
  /** Desired model; missing in drafts saved before it existed */
  model?: ModelChoice | null;
  updatedAt: number;
}

export interface CreateState {
  open: boolean;
  draft: Draft;
  createMore: boolean;
  /** Increases when the title should get focus */
  focusTick: number;
  error: string | null;
}

const CURRENT = 'selfbound:draft:current';
const SAVED = 'selfbound:drafts';
const LAST_TEAM = 'selfbound:lastTeam';

/**
 * Status and priority names accepted in /new?status=…&priority=… in both UI languages, whatever
 * the active one is (multi-word names that the keyword lists cannot match as one word).
 */
const STATUS_NAMES: Record<Status, readonly string[]> = {
  triage: ['triage'],
  backlog: ['backlog'],
  todo: ['todo', 'to do'],
  in_progress: ['in progress', 'in arbeit'],
  in_review: ['in review'],
  done: ['done', 'erledigt'],
  canceled: ['canceled', 'cancelled', 'abgebrochen'],
  duplicate: ['duplicate', 'duplikat'],
};
const PRIORITY_NAMES: Record<Priority, readonly string[]> = {
  0: ['no priority', 'keine priorität'],
  1: ['urgent', 'dringend'],
  2: ['high', 'hoch'],
  3: ['medium', 'mittel'],
  4: ['low', 'niedrig'],
};

function emptyDraft(): Draft {
  return { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, teamId: null, title: '', description: '', status: 'backlog', priority: 0, labelIds: [], projectId: null, estimate: null, dueDate: null, parentId: null, sprintId: null, updatedAt: Date.now() };
}

const hasContent = (d: Draft) => d.title.trim() !== '' || d.description.trim() !== '';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export class CreateController {
  readonly state: Slice<CreateState>;
  /** Saved drafts (Esc with content) */
  readonly drafts: Slice<Draft[]>;
  #persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App) {
    const current = read<Draft | null>(CURRENT, null);
    this.state = new Slice<CreateState>({ open: false, draft: current ?? emptyDraft(), createMore: false, focusTick: 0, error: null });
    this.drafts = new Slice<Draft[]>(read<Draft[]>(SAVED, []));
  }

  /** Drafts for the sidebar: saved ones plus the open one if it has content. */
  draftCount() {
    return this.drafts.get().length + (hasContent(this.state.get().draft) ? 1 : 0);
  }

  isOpen() {
    return this.state.get().open;
  }

  /** C: open the dialog. A leftover draft comes back, otherwise defaults from the context. */
  open(context: Partial<Draft> = {}) {
    const s = this.state.get();
    const keep = hasContent(s.draft) && Object.keys(context).length === 0;
    const draft = keep ? s.draft : this.#fresh(context);
    this.state.set({ ...s, open: true, draft, error: null, focusTick: s.focusTick + 1 });
    this.#persist();
  }

  /** New sub-issue under an issue. */
  openSubIssue(parentId: IssueId) {
    const parent = this.app.store.get(parentId);
    if (!parent) return;
    this.open({ parentId: parent._id, teamId: parent.teamId, projectId: parent.projectId ?? null, sprintId: parent.sprintId ?? null, status: 'todo' });
  }

  openDraft(id: string) {
    const saved = this.drafts.get();
    const draft = saved.find((d) => d.id === id);
    if (!draft) return;
    const s = this.state.get();
    // The open draft moves into the list; the chosen one becomes the open one.
    const rest = saved.filter((d) => d.id !== id);
    this.#saveList(hasContent(s.draft) ? [s.draft, ...rest] : rest);
    this.state.set({ ...s, open: true, draft, error: null, focusTick: s.focusTick + 1 });
    this.#persist();
  }

  deleteDraft(id: string) {
    this.#saveList(this.drafts.get().filter((d) => d.id !== id));
  }

  /** /new?title=…&priority=high&status=todo&team=ACME&label=Bug&project=…&estimate=3&due=tomorrow */
  openFromParams(params: Record<string, string>) {
    const meta = this.app.store.meta.get();
    const ctx: Partial<Draft> = {};
    if (params.title) ctx.title = params.title.slice(0, 500);
    if (params.description) ctx.description = params.description;
    const status = params.status?.toLowerCase();
    if (status) {
      const found = STATUS_ORDER.find((s) => s === status || STATUS_NAMES[s].includes(status) || STATUS_LABEL[s].toLowerCase() === status || STATUS_KEYWORDS[s].split(' ').includes(status));
      if (found) ctx.status = found;
      else ctx.stateName = status;
    }
    const priority = params.priority?.toLowerCase();
    if (priority) {
      const found = ([0, 1, 2, 3, 4] as Priority[]).find((p) => String(p) === priority || PRIORITY_NAMES[p].includes(priority) || PRIORITY_LABEL[p].toLowerCase() === priority || PRIORITY_KEYWORDS[p].split(' ').includes(priority));
      if (found !== undefined) ctx.priority = found;
    }
    if (params.team) {
      const key = this.app.store.currentTeamKey(params.team.toUpperCase());
      const team = meta?.teams.find((t) => t.key === key);
      if (team) ctx.teamId = team._id;
    }
    if (params.label) {
      const names = params.label.split(',').map((s) => s.trim().toLowerCase());
      ctx.labelIds = (meta?.labels ?? []).filter((l) => names.includes(l.name.toLowerCase()) || names.includes(l._id)).map((l) => l._id);
    }
    if (params.project) {
      const p = params.project.toLowerCase();
      const project = meta?.projects.find((x) => x._id === params.project || x.name.toLowerCase() === p);
      if (project) {
        ctx.projectId = project._id;
        ctx.teamId ??= project.teamId;
      }
    }
    if (params.estimate && !Number.isNaN(Number(params.estimate))) ctx.estimate = Number(params.estimate);
    if (params.due) ctx.dueDate = parseDueInput(params.due);
    // Metadata not there yet (cold start)? Then once more after loading.
    if (!meta) {
      const stop = this.app.store.meta.subscribe(() => {
        stop();
        this.openFromParams(params);
      });
    }
    const s = this.state.get();
    this.state.set({ ...s, open: true, draft: this.#fresh(ctx), error: null, focusTick: s.focusTick + 1 });
    this.#persist();
  }

  /** Defaults from the current view. */
  #fresh(context: Partial<Draft>): Draft {
    const draft = emptyDraft();
    const meta = this.app.store.meta.get();
    const page = this.app.nav.page.get();
    if (page.name === 'view') {
      const route = page.view;
      const list = this.app.list;
      const filters = list.view.get().filters;
      const ctx = list.context();
      const defaults = VIEWS[route.kind].createDefaults?.(route, ctx) ?? {};
      if (route.team) draft.teamId = meta?.teams.find((t) => t.key === route.team && t.wiki !== 'only')?._id ?? null;
      if (defaults.status) draft.status = defaults.status;
      if (defaults.projectId) {
        draft.projectId = defaults.projectId;
        draft.teamId ??= meta?.projects.find((p) => p._id === defaults.projectId)?.teamId ?? null;
      }
      if (defaults.sprintId) draft.sprintId = defaults.sprintId;
      // Filtered view: take over single filter values.
      if (filters.status.length === 1) {
        const value = filters.status[0];
        if ((STATUS_ORDER as string[]).includes(value)) draft.status = value as Status;
        else draft.stateName = value;
      }
      if (filters.priority.length === 1) draft.priority = filters.priority[0];
      if (filters.label.length) draft.labelIds = [...filters.label];
      if (filters.project.length === 1 && filters.project[0] !== 'none') draft.projectId = filters.project[0];
      if (filters.team.length === 1) draft.teamId = meta?.teams.find((t) => t.key === filters.team[0])?._id ?? draft.teamId;
    } else if (page.name === 'issue') {
      const issue = this.app.store.byKey(page.key);
      if (issue) draft.teamId = issue.teamId;
    }
    // A given status type replaces a status from the filter (e.g. sub-issue "todo").
    if (context.status !== undefined && context.stateName === undefined && context.stateId === undefined) {
      draft.stateName = null;
      draft.stateId = null;
    }
    Object.assign(draft, context);
    if (draft.teamId && meta?.teams.find((t) => t._id === draft.teamId)?.wiki === 'only') draft.teamId = null;
    if (!draft.teamId) {
      const last = read<string | null>(LAST_TEAM, null);
      // Wiki-only teams get no issues.
      const teams = (meta?.teams ?? []).filter((t) => t.wiki !== 'only');
      draft.teamId = teams.find((t) => t._id === last)?._id ?? teams.find((t) => !t.dormant)?._id ?? null;
    }
    // The project must belong to the team.
    if (draft.projectId && meta && meta.projects.find((p) => p._id === draft.projectId)?.teamId !== draft.teamId) draft.projectId = null;
    return draft;
  }

  update(patch: Partial<Draft>) {
    const s = this.state.get();
    const draft = { ...s.draft, ...patch, updatedAt: Date.now() };
    // Team change: project and team labels no longer fit, the status belongs to the old team.
    if (patch.teamId && patch.teamId !== s.draft.teamId) {
      const meta = this.app.store.meta.get();
      if (draft.stateId) {
        const old = workflowsOf(meta).byId.get(draft.stateId);
        draft.stateId = null;
        if (old) draft.stateName = old.name;
      }
      if (draft.projectId && meta?.projects.find((p) => p._id === draft.projectId)?.teamId !== draft.teamId) draft.projectId = null;
      draft.labelIds = draft.labelIds.filter((id) => {
        const label = meta?.labels.find((l) => l._id === id);
        return !label?.teamId || label.teamId === draft.teamId;
      });
    }
    this.state.set({ ...s, draft, error: null });
    this.#persistSoon();
  }

  /** Field value from a picker (same fields as when changing an issue). */
  setField(patch: IssuePatch) {
    const out: Partial<Draft> = {};
    for (const [field, value] of Object.entries(patch)) (out as Record<string, unknown>)[field] = value ?? null;
    if (patch.stateId) {
      const state = workflowsOf(this.app.store.meta.get()).byId.get(patch.stateId);
      if (state) out.status = statusOfState(state);
      out.stateName = null;
    } else if (patch.status) {
      out.stateId = null;
      out.stateName = null;
    }
    this.update(out);
  }

  /** What the create dialog shows as status (name, icon of the status type, color). */
  draftStateView(d: Draft = this.state.get().draft): { name: string; status: Status; color: string | null } {
    const workflows = workflowsOf(this.app.store.meta.get());
    const stateId = this.draftState(d);
    const view = stateId ? workflows.view(stateId) : null;
    if (view) return view;
    const state = d.teamId ? workflows.forStatus(d.teamId, d.status) : undefined;
    return state ? workflows.view(state._id)! : { name: STATUS_LABEL[d.status], status: d.status, color: null };
  }

  /** Draft status in the chosen team: chosen status, else by name, else null (status type applies). */
  draftState(d: Draft = this.state.get().draft): StateId | null {
    if (!d.teamId) return null;
    const workflows = workflowsOf(this.app.store.meta.get());
    const chosen = d.stateId ? workflows.byId.get(d.stateId) : undefined;
    if (chosen && chosen.teamId === d.teamId && chosen.archivedAt === undefined) return chosen._id;
    if (d.stateName) return workflows.byName(d.teamId, d.stateName)?._id ?? null;
    // Nothing chosen (status type "backlog" is the default): the team's default status.
    if (d.status === 'backlog') return defaultState(workflows.allOf(d.teamId), workflows.workflowOf(d.teamId))?._id ?? null;
    return null;
  }

  toggleLabel(labelId: string) {
    const meta = this.app.store.meta.get();
    const draft = this.state.get().draft;
    const label = meta?.labels.find((l) => l._id === labelId);
    const group = label?.groupId ? meta?.labelGroups.find((g) => g._id === label.groupId) : undefined;
    let next = draft.labelIds.filter((id) => id !== labelId);
    if (next.length === draft.labelIds.length) {
      if (group?.exclusive) next = next.filter((id) => meta?.labels.find((l) => l._id === id)?.groupId !== group._id);
      next.push(labelId);
    }
    this.update({ labelIds: next });
  }

  toggleCreateMore() {
    const s = this.state.get();
    this.state.set({ ...s, createMore: !s.createMore });
  }

  /** Ctrl Enter: create, following the "Create more" switch. `more` (Ctrl Shift Enter): the dialog stays open, properties stay. */
  submit(more = this.state.get().createMore) {
    const s = this.state.get();
    const d = s.draft;
    if (!d.title.trim()) {
      this.state.set({ ...s, error: t('Please enter a title.'), focusTick: s.focusTick + 1 });
      return;
    }
    if (!d.teamId) {
      this.state.set({ ...s, error: t('Please choose a team.') });
      return;
    }
    // A full hard priority limit: the dialog stays open with the reason, nothing is lost.
    const stateId = this.draftState(d);
    const type = stateId ? workflowsOf(this.app.store.meta.get()).view(stateId)?.type : undefined;
    const closed = stateId ? type === 'completed' || type === 'canceled' : CLOSED.has(d.status);
    const full = closed ? undefined : this.app.edit.limitHits([{ id: 'new:0' as IssueId, teamId: d.teamId, priority: d.priority }]).find((h) => h.hard);
    if (full) {
      const { text, detail } = this.app.edit.limitText(full);
      this.state.set({ ...s, error: `${text}. ${detail}` });
      return;
    }
    const item: NewIssue = {
      teamId: d.teamId as NewIssue['teamId'],
      title: d.title.trim(),
      ...(d.description.trim() ? { description: d.description } : {}),
      ...(this.draftState(d) ? { stateId: this.draftState(d)! } : { status: d.status }),
      priority: d.priority,
      ...(d.labelIds.length ? { labelIds: d.labelIds as NewIssue['labelIds'] } : {}),
      ...(d.projectId ? { projectId: d.projectId as NewIssue['projectId'] } : {}),
      ...(d.estimate !== null ? { estimate: d.estimate } : {}),
      ...(d.dueDate ? { dueDate: d.dueDate } : {}),
      ...(d.parentId ? { parentId: d.parentId as NewIssue['parentId'] } : {}),
      ...(d.sprintId ? { sprintId: d.sprintId as NewIssue['sprintId'] } : {}),
      ...(d.model ? { model: d.model } : {}),
    };
    write(LAST_TEAM, d.teamId);
    this.app.cues.emit('success');
    const draftCopy = { ...d };
    const [temp] = this.app.edit.create([item], (error) => {
      // Failed: draft back into the list, nothing is lost.
      this.#saveList([{ ...draftCopy, id: `${draftCopy.id}r` }, ...this.drafts.get()]);
      this.app.toasts.error(t('“{title}” not created, saved as draft', { title: item.title }), error, () => this.openDraft(`${draftCopy.id}r`));
    });
    // Refused locally (a full hard priority limit, the toast says why): the dialog stays as it is.
    if (!temp) return;
    // After the list is recomputed (store microtask): visible → focus and scroll to it, otherwise a
    // toast with "Open" (the result would be invisible).
    queueMicrotask(() => {
      const visible = this.app.nav.page.get().name === 'view' && this.app.list.isVisible(temp);
      if (visible) this.app.list.focus(temp, true);
      else this.app.toasts.show(t('“{title}” created', { title: item.title }), { label: tc('verb', 'Open'), run: () => this.app.openIssue(this.app.store.resolvedId(temp)) });
    });
    if (more) {
      const next = { ...d, id: emptyDraft().id, title: '', description: '', updatedAt: Date.now() };
      this.state.set({ ...s, open: true, draft: next, error: null, focusTick: s.focusTick + 1 });
    } else {
      this.state.set({ ...s, open: false, draft: emptyDraft(), error: null });
    }
    this.#persist();
  }

  /** Esc, ×, click outside: close. With content it becomes a saved draft (instead of a confirm). */
  close() {
    const s = this.state.get();
    if (!s.open) return;
    if (hasContent(s.draft)) {
      this.#saveList([s.draft, ...this.drafts.get().filter((d) => d.id !== s.draft.id)]);
      this.app.toasts.show(t('Saved as draft'), { label: tc('verb', 'Open'), run: () => this.openDraft(s.draft.id) });
    }
    this.state.set({ ...s, open: false, draft: emptyDraft(), error: null });
    this.#persist();
  }

  /** "Discard" (footer): close without a draft. With content, a toast with "Undo". */
  discard() {
    const s = this.state.get();
    const gone = s.draft;
    this.state.set({ ...s, open: false, draft: emptyDraft(), error: null });
    this.#persist();
    if (hasContent(gone)) this.app.toasts.show(t('Draft discarded'), { label: t('Undo'), run: () => this.#reopen(gone) });
  }

  /** Discarded draft back into the dialog; an open one with content moves into the list. */
  #reopen(draft: Draft) {
    const s = this.state.get();
    if (hasContent(s.draft) && s.draft.id !== draft.id) this.#saveList([s.draft, ...this.drafts.get().filter((d) => d.id !== s.draft.id)]);
    this.state.set({ ...s, open: true, draft, error: null, focusTick: s.focusTick + 1 });
    this.#persist();
  }

  /** Navigating away: hide the dialog, the draft stays the open one (C brings it back). */
  hide() {
    const s = this.state.get();
    if (s.open) this.state.set({ ...s, open: false });
  }

  #saveList(list: Draft[]) {
    this.drafts.set(list);
    write(SAVED, list);
  }

  #persistSoon() {
    if (this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persist();
    }, 250);
  }

  #persist() {
    const d = this.state.get().draft;
    write(CURRENT, hasContent(d) ? d : null);
  }

  /** Save right away when the tab closes. */
  flush() {
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#persistTimer = null;
    this.#persist();
  }
}
