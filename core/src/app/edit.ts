// Issue changes with undo/redo. Every change is optimistic (store) and becomes an entry on the
// undo stack. Undo sends `issues.revert` with compare-and-set: if the value is no longer one's
// own, the server reports `conflict` and the app says who changed it in the meantime. Undo jumps
// back to where the action happened.
import { CLOSED, PRIORITY_LABEL, actorName, branchName, dayLabel } from '../format.ts';
import { t, tc, tn, translated } from '../i18n.ts';
import type { Page } from '../route.ts';
import { applyPatch, sameValue } from '../store.ts';
import { limitHits, limitsOf, type BudgetHit } from '../budget.ts';
import { inInbox } from '../inbox.ts';
import { isOwnerKind, type Filters, type Issue, type IssueId, type IssuePatch, type LabelId, type NewIssue, type PatchField, type Priority, type RelationType, type StateId, type Status } from '../types.ts';
import { workflowsOf } from '../workflow.ts';
import type { App } from './index.ts';
import { errorCode } from './toasts.ts';

interface UndoContext {
  page: Page;
  filters: Filters;
  quick: string;
  selection: IssueId[];
  focus: IssueId | null;
}

/** A relation; only the server knows `relationId`; `before` = status before "Duplicate of". */
export interface RelationItem {
  from: IssueId;
  to: IssueId;
  type: RelationType;
  relationId: string | null;
  before?: { stateId?: StateId; status: Status; priority: Priority };
  /** Issue whose detail view is updated optimistically (default: from) */
  at?: IssueId;
}

export type UndoEntry =
  | { kind: 'patch'; label: string; items: { id: IssueId; before: IssuePatch; after: IssuePatch }[]; ctx: UndoContext }
  | { kind: 'relation'; label: string; op: 'add' | 'remove'; items: RelationItem[]; ctx: UndoContext }
  | { kind: 'move'; label: string; items: { id: IssueId; from: string }[]; to: string; ctx: UndoContext }
  | { kind: 'remove' | 'restore' | 'create' | 'review'; label: string; ids: IssueId[]; ctx: UndoContext }
  | { kind: 'read'; read: boolean; label: string; ids: IssueId[]; ctx: UndoContext };

const FIELD_LABEL: Record<PatchField, string> = translated({
  title: 'Title',
  stateId: 'Status',
  status: 'Status',
  priority: 'Priority',
  labelIds: 'Labels',
  projectId: 'Project',
  estimate: 'Estimate',
  dueDate: 'Due date',
  snoozedUntil: 'Snoozed until',
  parentId: 'Parent',
  sprintId: 'Sprint',
  model: 'Model',
});

/** Current value of a field as a patch value (`null` = not set). */
function current(issue: Issue, field: PatchField): unknown {
  const value = (issue as unknown as Record<string, unknown>)[field];
  return value === undefined ? null : value;
}

/** Issues affected by an entry (the source for relations). */
function entryIds(entry: UndoEntry): IssueId[] {
  if (entry.kind === 'relation') return entry.items.map((i) => i.from);
  return entry.kind === 'patch' || entry.kind === 'move' ? entry.items.map((i) => i.id) : entry.ids;
}

export class Editor {
  #undo: UndoEntry[] = [];
  #redo: UndoEntry[] = [];
  /** Toast with "Undo" per entry: acts only on that entry and goes away with it. */
  #toastOf = new WeakMap<UndoEntry, number>();

  constructor(private app: App) {}

  get undoDepth() {
    return this.#undo.length;
  }

  #context(): UndoContext {
    const list = this.app.list;
    const view = list.view.get();
    return { page: this.app.nav.page.get(), filters: view.filters, quick: view.quick, selection: list.selection(), focus: list.focusId() };
  }

  #push(entry: UndoEntry) {
    this.#undo.push(entry);
    if (this.#undo.length > 100) this.#undo.shift();
    this.#redo = [];
  }

  /** Toast with "Undo", bound to exactly this entry. */
  #undoToast(entry: UndoEntry, text: string) {
    const id = this.app.toasts.show(text, { label: t('Undo'), run: () => this.undo(entry) });
    this.#toastOf.set(entry, id);
  }

  /**
   * Toast with "Undo" for the last own step (e.g. "ORB-12 is no longer in this view"), bound to
   * that entry. If the entry already has a toast, no second one.
   */
  toastForLast(text: string) {
    const entry = this.#undo.at(-1);
    if (!entry) return void this.app.toasts.show(text);
    if (this.#toastOf.has(entry)) return;
    this.#undoToast(entry, text);
  }

  #dropToast(entry: UndoEntry) {
    const id = this.#toastOf.get(entry);
    if (id !== undefined) this.app.toasts.dismiss(id);
    this.#toastOf.delete(entry);
  }

  /** "ORB-12" or "3 issues" */
  #what(ids: IssueId[]) {
    return ids.length === 1 ? (this.app.store.get(ids[0])?.key ?? t('Issue')) : tn(ids.length, '{count} issue', '{count} issues');
  }

  /**
   * Same patch for several issues. Only issues where something changes.
   * Bulk changes show a toast with "Undo"; single changes do not.
   */
  patch(ids: IssueId[], patch: IssuePatch, opts: { label?: string; quiet?: boolean; expected?: boolean } = {}) {
    this.patchEach(
      ids.map((id) => ({ id, patch })),
      opts,
    );
  }

  /**
   * Set status: `pick` returns the status of each issue's team (for a selection across teams,
   * e.g. by the same name). Issues without a matching status stay as they are.
   */
  setState(ids: IssueId[], pick: (issue: Issue) => StateId | undefined, opts: { label?: string; quiet?: boolean; expected?: boolean } = {}) {
    const items: { id: IssueId; patch: IssuePatch }[] = [];
    for (const id of ids) {
      const issue = this.app.store.get(id);
      const stateId = issue ? pick(issue) : undefined;
      if (stateId) items.push({ id, patch: { stateId } });
    }
    this.patchEach(items, opts);
  }

  /**
   * Map a status type (e.g. 'backlog' when accepting) to the team's status, so undo brings back
   * exactly the previous status. If the issue already has a status of that type, it stays there
   * (as in the backend).
   */
  #statePatch(issue: Issue, patch: IssuePatch): IssuePatch {
    if (patch.status === undefined || patch.stateId !== undefined) return patch;
    const { status, ...rest } = patch;
    if (issue.status === status && issue.stateId) return rest;
    const state = workflowsOf(this.app.store.meta.get()).forStatus(issue.teamId, status);
    return state ? { ...rest, stateId: state._id } : patch;
  }

  /** "Done" sound when the change puts an issue into a status of type "completed". */
  #doneCue(items: { after: IssuePatch }[]) {
    const workflows = workflowsOf(this.app.store.meta.get());
    if (items.some((i) => i.after.status === 'done' || (i.after.stateId && workflows.view(i.after.stateId)?.type === 'completed'))) this.app.cues.emit('success');
  }

  /** Own patch per issue (same fields), one undo step. */
  patchEach(list: { id: IssueId; patch: IssuePatch }[], opts: { label?: string; quiet?: boolean; expected?: boolean } = {}) {
    const first = list[0]?.patch ?? {};
    const firstField = (Object.keys(first) as PatchField[])[0];
    const items: { id: IssueId; before: IssuePatch; after: IssuePatch }[] = [];
    for (const { id, patch: raw } of list) {
      const issue = this.app.store.get(id);
      if (!issue || issue.deletedAt !== undefined) continue;
      const patch = this.#statePatch(issue, raw);
      const fields = Object.keys(patch) as PatchField[];
      const before: IssuePatch = {};
      const after: IssuePatch = {};
      for (const field of fields) {
        const next = patch[field] === undefined ? null : patch[field];
        const now = current(issue, field);
        if (sameValue(now, next) || (field === 'labelIds' && sameValue([...(now as string[])].sort(), [...(next as string[])].sort()))) continue;
        (before as Record<string, unknown>)[field] = now;
        (after as Record<string, unknown>)[field] = next;
      }
      // Done, canceled or duplicate clears the priority (backend): include it in the undo step so
      // undo brings both back together.
      // The same goes for the snooze: only open issues are snoozed.
      const local = applyPatch(issue as never, patch, 0, workflowsOf(this.app.store.meta.get()));
      if (Object.keys(after).length && local.priority !== issue.priority) {
        (before as Record<string, unknown>).priority = issue.priority;
        (after as Record<string, unknown>).priority = local.priority;
      }
      if (Object.keys(after).length && issue.snoozedUntil !== undefined && local.snoozedUntil === undefined && patch.snoozedUntil === undefined) {
        before.snoozedUntil = issue.snoozedUntil;
        after.snoozedUntil = null;
      }
      if (Object.keys(after).length) items.push({ id, before, after });
    }
    if (items.length === 0) return;
    if (this.#limits(items.filter((i) => i.after.priority !== undefined).map((i) => this.#incoming(i.id, i.after.priority as number)))) return;
    const label = opts.label ?? t('{field} changed', { field: FIELD_LABEL[firstField!] });
    const entry: UndoEntry = { kind: 'patch', label, items, ctx: this.#context() };
    this.#push(entry);
    this.#doneCue(items);
    // `expected`: the issue is meant to leave the view (e.g. planned into the sprint), no toast.
    // Bulk change: its toast with "Undo" is enough, no second "no longer in this view".
    const bulkToast = items.length > 1 && !opts.quiet;
    if (!opts.expected && !bulkToast) this.app.list.noteOwnChange(items.map((i) => i.id));
    this.#send(entry, false).catch(() => {});
    if (bulkToast) this.#undoToast(entry, tn(items.length, '{count} issue changed', '{count} issues changed'));
  }

  /**
   * Snooze until a day (`null` = unsnooze). The issues leave the lists, so the toast with "Undo"
   * says what happened instead of "no longer in this view". Closed issues are not snoozed.
   */
  snooze(ids: IssueId[], day: string | null) {
    const open = ids.filter((id) => {
      const issue = this.app.store.get(id);
      return issue && !CLOSED.has(issue.status) && (day !== null || issue.snoozedUntil !== undefined);
    });
    if (!open.length) return;
    const before = this.#undo.at(-1);
    this.patch(open, { snoozedUntil: day }, { label: day ? t('Snoozed') : t('Unsnoozed'), quiet: true, expected: true });
    if (this.#undo.at(-1) === before) return;
    const what = this.#what(open);
    this.toastForLast(day ? t('{what} snoozed until {day}', { what, day: dayLabel(day) }) : t('{what} is no longer snoozed', { what }));
  }

  /** An issue that would newly count toward `priority` in `teamId` (default: its own team), else null. */
  #incoming(id: IssueId, priority: number, teamId?: string) {
    const issue = this.app.store.get(id);
    if (!issue || (priority !== 1 && priority !== 2) || CLOSED.has(issue.status)) return null;
    const team = teamId ?? issue.teamId;
    if (issue.priority === priority && issue.teamId === team && issue.deletedAt === undefined) return null;
    return { id, teamId: team, priority };
  }

  /** Limits that `incoming` would go over (hard ones first). Computed on the state before the change. */
  limitHits(incoming: ({ id: IssueId; teamId: string; priority: number } | null)[], all: Iterable<Issue> = this.app.store.all()): BudgetHit[] {
    const list = incoming.filter((i) => i !== null);
    if (!list.length) return [];
    const limits = limitsOf(this.app.store.meta.get());
    const issues = [...all];
    const hits = ([1, 2] as const).flatMap((p) => limitHits(issues, list.filter((i) => i.priority === p), p, limits));
    return hits.sort((a, b) => Number(b.hard) - Number(a.hard));
  }

  /** Text for a full hard limit: what is full and what to do. */
  limitText(hit: BudgetHit) {
    const team = this.app.store.team(hit.teamId)?.name ?? t('Team');
    const priority = PRIORITY_LABEL[hit.priority];
    const names = hit.previous.slice(0, 3).map((i) => `${i.key} ${i.title}`);
    const rest = hit.previous.length - names.length;
    const list = rest > 0 ? t('{list} and {count} more', { list: names.join(' · '), count: rest }) : names.join(' · ');
    return {
      text: t('{team}: at most {max} × {priority} open', { team, max: hit.budget, priority }),
      detail: names.length ? t('Lower one of these first: {list}', { list }) : t('Choose another priority, or change the limit under Settings → Priorities.'),
    };
  }

  /**
   * Priority limits (XLR8-91). Over a hard limit: error toast with "Downgrade …", and true (the
   * caller drops the change; the server would reject it too). Over a soft one: the subtle hint
   * with the existing candidates, the change is saved anyway.
   */
  #limits(incoming: ({ id: IssueId; teamId: string; priority: number } | null)[], all?: Iterable<Issue>): boolean {
    const hits = this.limitHits(incoming, all);
    const hard = hits.filter((h) => h.hard);
    for (const hit of hard) {
      const { text, detail } = this.limitText(hit);
      const action = hit.previous.length
        ? { label: t('Downgrade …'), run: () => this.app.palette.openDowngrade(hit.teamId, hit.priority) }
        : { label: t('Settings'), run: () => this.app.nav.go({ name: 'settings', section: 'priorities' }) };
      this.app.toasts.show(text, action, 'error', detail);
    }
    if (hard.length) return true;
    for (const hit of hits) {
      this.app.cues.emit('warning');
      const team = this.app.store.team(hit.teamId);
      const names = hit.previous.slice(0, 3).map((i) => `${i.key} ${i.title}`);
      const list = names.join(' · ');
      const rest = hit.previous.length - 3;
      this.app.toasts.show(
        t('{team}: now {open} × {priority} open (limit {budget})', { team: team?.name ?? t('Team'), open: hit.open, priority: PRIORITY_LABEL[hit.priority], budget: hit.budget }),
        { label: t('Downgrade …'), run: () => this.app.palette.openDowngrade(hit.teamId, hit.priority) },
        'info',
        rest > 0 ? t('So far: {list} and {count} more', { list, count: rest }) : t('So far: {list}', { list }),
        9000,
      );
    }
    return false;
  }

  /**
   * Revert someone else's change (e.g. an agent's) from the activity: old value back, but only if
   * the value set back then is still there (compare-and-set). Goes onto the undo stack.
   */
  revertChange(id: IssueId, field: PatchField, from: unknown, to: unknown) {
    const before = { [field]: to ?? null } as IssuePatch;
    const after = { [field]: from ?? null } as IssuePatch;
    const entry: UndoEntry = { kind: 'patch', label: t('Change reverted'), items: [{ id, before, after }], ctx: this.#context() };
    this.#push(entry);
    this.app.store.revert([{ id, patch: after, expect: before }]).catch((error) => {
      this.#undo = this.#undo.filter((e) => e !== entry);
      void this.#undoFailed(entry, error);
    });
  }

  /** Same fields, but an own value per issue (e.g. toggling a label on a mixed selection). */
  #sendPatchItems(items: { id: IssueId; patch: IssuePatch }[]) {
    // Group by identical patch so bulk changes stay one call.
    const groups = new Map<string, { patch: IssuePatch; ids: IssueId[] }>();
    for (const item of items) {
      const key = JSON.stringify(item.patch);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { patch: item.patch, ids: [] }));
      group.ids.push(item.id);
    }
    return Promise.all([...groups.values()].map((g) => this.app.store.update(g.ids, g.patch)));
  }

  /** Label on/off. In exclusive groups the new label replaces the group's old one. */
  toggleLabel(ids: IssueId[], labelId: LabelId) {
    const meta = this.app.store.meta.get();
    const label = meta?.labels.find((l) => l._id === labelId);
    const group = label?.groupId ? meta?.labelGroups.find((g) => g._id === label.groupId) : undefined;
    const issues = ids.map((id) => this.app.store.get(id)).filter((i): i is Issue => !!i);
    const allHave = issues.length > 0 && issues.every((i) => i.labelIds.includes(labelId));
    const items: { id: IssueId; before: IssuePatch; after: IssuePatch }[] = [];
    for (const issue of issues) {
      let next = issue.labelIds.filter((l) => l !== labelId);
      if (!allHave) {
        if (group?.exclusive) next = next.filter((l) => meta?.labels.find((x) => x._id === l)?.groupId !== group._id);
        next = [...next, labelId];
      }
      if (sameValue([...next].sort(), [...issue.labelIds].sort())) continue;
      items.push({ id: issue._id, before: { labelIds: issue.labelIds }, after: { labelIds: next } });
    }
    if (!items.length) return;
    const entry: UndoEntry = { kind: 'patch', label: t('Labels changed'), items, ctx: this.#context() };
    this.#push(entry);
    if (items.length === 1) this.app.list.noteOwnChange(items.map((i) => i.id));
    this.#send(entry, false).catch(() => {});
    if (items.length > 1) this.#undoToast(entry, tn(items.length, '{count} issue changed', '{count} issues changed'));
  }

  remove(ids: IssueId[]) {
    const targets = ids.filter((id) => this.app.store.get(id)?.deletedAt === undefined);
    if (!targets.length) return;
    const entry: UndoEntry = { kind: 'remove', label: t('Deleted'), ids: targets, ctx: this.#context() };
    this.#push(entry);
    // Deleting can be undone: no confirm dialog, but a toast because the issue disappears.
    // No extra "no longer in this view" toast (no noteOwnChange): this one is enough.
    this.#undoToast(entry, t('{what} moved to the trash', { what: this.#what(targets) }));
    this.#send(entry, false).catch(() => {});
  }

  restore(ids: IssueId[]) {
    const targets = ids.filter((id) => this.app.store.get(id)?.deletedAt !== undefined);
    if (!targets.length) return;
    if (this.#limits(targets.map((id) => this.#incoming(id, this.app.store.get(id)!.priority)))) return;
    const entry: UndoEntry = { kind: 'restore', label: t('Restored'), ids: targets, ctx: this.#context() };
    this.#push(entry);
    this.#undoToast(entry, t('{what} restored', { what: this.#what(targets) }));
    this.#send(entry, false).catch(() => {});
  }

  /** Create; undo moves the new issues to the trash. Returns the temporary IDs. */
  create(items: NewIssue[], onFail?: (error: unknown) => void): IssueId[] {
    // The new issues do not exist yet: placeholders. Closed ones carry no priority (backend).
    const workflows = workflowsOf(this.app.store.meta.get());
    const closed = (i: NewIssue) => {
      const type = i.stateId ? workflows.view(i.stateId)?.type : undefined;
      return type ? type === 'completed' || type === 'canceled' : CLOSED.has(i.status ?? 'todo');
    };
    const incoming = items.map((i, n) => ((i.priority === 1 || i.priority === 2) && !closed(i) ? { id: `new:${n}` as IssueId, teamId: i.teamId as string, priority: i.priority } : null));
    if (this.#limits(incoming)) return [];
    const { temps, done } = this.app.store.create(items);
    const entry: UndoEntry = { kind: 'create', label: tc('undo', 'Created'), ids: temps, ctx: this.#context() };
    this.#push(entry);
    done.then(
      (ids) => {
        entry.ids = ids;
      },
      (error) => {
        this.#undo = this.#undo.filter((e) => e !== entry);
        if (onFail) onFail(error);
        else this.app.toasts.error(items.length === 1 ? t('“{title}” not created', { title: items[0].title }) : tn(items.length, '{count} issue not created', '{count} issues not created'), error, () => this.create(items));
      },
    );
    return temps;
  }

  /**
   * Move to another team. The ID changes (the old one stays as an alias), hence a toast with the
   * new ID. Undo moves it back (with yet another new number).
   */
  moveTeam(ids: IssueId[], teamId: string) {
    const items = ids.map((id) => this.app.store.get(id)).filter((i): i is Issue => !!i && i.teamId !== teamId && i.deletedAt === undefined).map((i) => ({ id: i._id, from: i.teamId as string }));
    if (!items.length) return;
    if (this.#limits(items.map((i) => this.#incoming(i.id, this.app.store.get(i.id)!.priority, teamId)))) return;
    const entry: UndoEntry = { kind: 'move', label: t('Team changed'), items, to: teamId, ctx: this.#context() };
    this.#push(entry);
    this.app.list.noteOwnChange(items.map((i) => i.id));
    this.#sendMove(entry, false).then(
      (result) => {
        const moved = (result as { moved?: { identifier: string; previous: string }[] } | undefined)?.moved ?? [];
        // Open detail page: switch to the new ID.
        const page = this.app.nav.page.get();
        const here = page.name === 'issue' ? moved.find((m) => m.previous === page.key) : undefined;
        if (here) this.app.nav.go({ name: 'issue', key: here.identifier }, { replace: true });
        if (moved.length === 1) this.#undoToast(entry, t('{old} is now {new}', { old: moved[0].previous, new: moved[0].identifier }));
        else if (moved.length > 1) this.#undoToast(entry, tn(moved.length, '{count} issue moved', '{count} issues moved'));
      },
      () => {},
    );
  }

  async #sendMove(entry: Extract<UndoEntry, { kind: 'move' }>, reverse: boolean) {
    try {
      if (!reverse) return await this.app.store.moveTeam(entry.items.map((i) => i.id), entry.to as never);
      const byTeam = new Map<string, IssueId[]>();
      for (const item of entry.items) byTeam.set(item.from, [...(byTeam.get(item.from) ?? []), item.id]);
      for (const [team, ids] of byTeam) await this.app.store.moveTeam(ids, team as never);
      return undefined;
    } catch (error) {
      if (!reverse) {
        this.#undo = this.#undo.filter((e) => e !== entry);
        this.app.toasts.error(t('{what}: team not changed', { what: this.#what(entry.items.map((i) => i.id)) }), error, () => this.moveTeam(entry.items.map((i) => i.id), entry.to));
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- Relations

  /**
   * Create relations (blocks, related, duplicate of), with undo. With `markDuplicate`, "duplicate
   * of" also sets the source's status to Duplicate (one server call per relation); undo removes
   * the relation and restores the old status (compare-and-set).
   */
  addRelations(items: { from: IssueId; to: IssueId; type: RelationType }[], opts: { markDuplicate?: boolean } = {}) {
    const store = this.app.store;
    const list: RelationItem[] = [];
    for (const item of items) {
      const source = store.get(item.from);
      if (item.from === item.to || !source || !store.get(item.to)) continue;
      const mark = opts.markDuplicate && item.type === 'duplicate' && source.status !== 'duplicate';
      list.push({ ...item, relationId: null, ...(mark ? { before: { stateId: source.stateId, status: source.status, priority: source.priority } } : {}) });
    }
    if (!list.length) return;
    const label = list[0].type === 'duplicate' ? t('Marked as duplicate') : t('Relation added');
    const entry: UndoEntry = { kind: 'relation', label, op: 'add', items: list, ctx: this.#context() };
    this.#push(entry);
    const marked = list.filter((i) => i.before).map((i) => i.from);
    if (marked.length) this.app.list.noteOwnChange(marked);
    void this.#sendRelations(entry, false, true).catch(() => {});
  }

  /** Remove a relation (detail page), with undo (recreates it). */
  removeRelation(item: { from: IssueId; to: IssueId; type: RelationType; relationId: string; at?: IssueId }) {
    const entry: UndoEntry = { kind: 'relation', label: t('Relation removed'), op: 'remove', items: [{ ...item }], ctx: this.#context() };
    this.#push(entry);
    return this.#sendRelations(entry, false, true);
  }

  /**
   * Sends a relation entry: forward (`reverse = false`) as created, backward = undo.
   * `first`: first run; for duplicates the server then sets the status in the same call.
   */
  async #sendRelations(entry: Extract<UndoEntry, { kind: 'relation' }>, reverse: boolean, first = false) {
    const store = this.app.store;
    const adding = (entry.op === 'add') !== reverse;
    try {
      for (const item of entry.items) {
        if (adding) {
          const result = (await store.addRelation(item.from, item.to, item.type, first && !!item.before)) as { relationId?: string } | undefined;
          item.relationId = result?.relationId ?? null;
        } else if (item.relationId) {
          await store.removeRelation(item.at ?? item.from, item.relationId);
          item.relationId = null;
        }
      }
      const marked = entry.items.filter((i) => i.before);
      if (marked.length && !first) {
        const workflows = workflowsOf(store.meta.get());
        await store.revert(
          marked.map((i) => {
            // "Duplicate" clears the priority; undo brings it back too.
            const lost = i.before!.priority !== 0;
            const before: IssuePatch = { ...(i.before!.stateId ? { stateId: i.before!.stateId } : { status: i.before!.status }), ...(lost ? { priority: i.before!.priority } : {}) };
            const teamId = store.get(i.from)?.teamId;
            const dup = teamId ? workflows.forStatus(teamId, 'duplicate') : undefined;
            const duplicate: IssuePatch = { ...(dup ? { stateId: dup._id } : { status: 'duplicate' }), ...(lost ? { priority: 0 } : {}) };
            return adding ? { id: i.from, patch: duplicate, expect: before } : { id: i.from, patch: before, expect: duplicate };
          }),
        );
      }
    } catch (error) {
      if (first) {
        this.#undo = this.#undo.filter((e) => e !== entry);
        this.app.toasts.error(adding ? t('Relation not saved') : t('Relation not removed'), error);
      }
      throw error;
    }
  }

  /**
   * Remove entries from the inbox. Only the mark on the entry; the issue stays as it is. Always
   * with a toast and undo: the entry disappears from the list.
   */
  removeFromInbox(ids: IssueId[], opts: { label?: string } = {}) {
    const targets = ids.filter((id) => {
      const issue = this.app.store.get(id);
      return issue !== undefined && inInbox(issue) && !issue.pending;
    });
    if (!targets.length) return;
    const entry: UndoEntry = { kind: 'review', label: t('Removed from inbox'), ids: targets, ctx: this.#context() };
    this.#push(entry);
    const key = targets.length === 1 ? this.app.store.get(targets[0])?.key : undefined;
    const text = key ? t('{key} removed from inbox', { key }) : targets.length === 1 ? t('Entry removed from inbox') : tn(targets.length, '{count} entry removed from inbox', '{count} entries removed from inbox');
    this.#undoToast(entry, opts.label ?? text);
    this.#send(entry, false).catch(() => {});
  }

  /**
   * Mark inbox entries as read or unread. Without `undo` as a side effect (viewing, triage), with
   * `undo` as its own step (U, Alt U, command menu).
   */
  markRead(ids: IssueId[], read = true, opts: { undo?: boolean } = {}) {
    const targets = ids.filter((id) => {
      const issue = this.app.store.get(id);
      return issue !== undefined && !issue.pending && inInbox(issue) && (issue.inbox!.readAt !== undefined) !== read;
    });
    if (!targets.length) return;
    // In the "Unread" filter a just-read issue stays for this visit.
    if (read) this.app.list.keep(targets);
    if (!opts.undo) {
      this.app.store.markRead(targets, read).catch((error) => this.app.toasts.error(read ? t('Not marked as read') : t('Not marked as unread'), error));
      return;
    }
    const label = read ? t('Marked as read') : t('Marked as unread');
    const entry: UndoEntry = { kind: 'read', read, label, ids: targets, ctx: this.#context() };
    this.#push(entry);
    if (targets.length > 1) this.#undoToast(entry, read ? tn(targets.length, '{count} entry marked as read', '{count} entries marked as read') : tn(targets.length, '{count} entry marked as unread', '{count} entries marked as unread'));
    this.#send(entry, false).catch(() => {});
  }

  /** Alt ↑/↓: move up/down in rank (only useful with manual ordering). */
  move(id: IssueId, delta: -1 | 1) {
    const order = this.app.list.order();
    const index = order.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const neighbor = order[target];
    // Afterwards the order is before, issue, after.
    const [beforeId, afterId] = delta < 0 ? [order[target - 1], neighbor] : [neighbor, order[target + 1]];
    this.app.store.reorder(id, beforeId, afterId).catch((error) => this.app.toasts.error(t('Order not saved'), error));
  }

  /** Sends an entry (forward or backward) and reports errors with the reason and "Try again". */
  async #send(entry: UndoEntry, reverse: boolean) {
    try {
      if (entry.kind === 'patch') {
        if (reverse) await this.app.store.revert(entry.items.map((i) => ({ id: i.id, patch: i.before, expect: i.after })));
        else await this.#sendPatchItems(entry.items.map((i) => ({ id: i.id, patch: i.after })));
      } else {
        if (entry.kind === 'move' || entry.kind === 'relation') return;
        if (entry.kind === 'review') {
          await (reverse ? this.app.store.markUnreviewed(entry.ids) : this.app.store.markReviewed(entry.ids));
          return;
        }
        if (entry.kind === 'read') {
          await this.app.store.markRead(entry.ids, reverse ? !entry.read : entry.read);
          return;
        }
        const forward = entry.kind === 'remove' ? 'remove' : entry.kind === 'restore' ? 'restore' : null;
        const op = reverse ? (entry.kind === 'restore' ? 'remove' : 'restore') : forward;
        if (op === 'remove') await this.app.store.remove(entry.ids);
        else if (op === 'restore') await this.app.store.restore(entry.ids);
      }
    } catch (error) {
      if (!reverse) {
        this.#undo = this.#undo.filter((e) => e !== entry);
        const ids = entryIds(entry);
        this.app.toasts.error(t('{what}: {action} – not saved', { what: this.#what(ids), action: entry.label }), error, () => {
          this.#push(entry);
          void this.#send(entry, false).catch(() => {});
        });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- Undo / Redo

  /**
   * Undo the last step. With `only` (click on "Undo" in a toast) exactly that entry; if it was
   * already undone, nothing happens.
   */
  undo(only?: UndoEntry) {
    let entry: UndoEntry | undefined;
    if (only) {
      const index = this.#undo.lastIndexOf(only);
      if (index < 0) return;
      entry = this.#undo.splice(index, 1)[0];
    } else entry = this.#undo.pop();
    if (!entry) return this.app.toasts.show(t('Nothing to undo'));
    this.#dropToast(entry);
    this.#restoreContext(entry);
    if (entry.kind === 'create' && entry.ids.some((id) => this.app.store.isPending(id))) {
      // Not confirmed yet: delete after the confirmation.
      void this.app.store.remove(entry.ids).then(() => this.#redo.push(entry)).catch((error) => this.app.toasts.error(t('Undo failed'), error));
      return;
    }
    const run =
      entry.kind === 'create' ? this.app.store.remove(entry.ids) : entry.kind === 'move' ? this.#sendMove(entry, true) : entry.kind === 'relation' ? this.#sendRelations(entry, true) : this.#send(entry, true);
    run.then(
      () => this.#redo.push(entry),
      (error) => void this.#undoFailed(entry, error),
    );
  }

  redo() {
    const entry = this.#redo.pop();
    if (!entry) return this.app.toasts.show(t('Nothing to redo'));
    this.#restoreContext(entry);
    let run: Promise<unknown>;
    if (entry.kind === 'move') run = this.#sendMove(entry, false);
    else if (entry.kind === 'relation') run = this.#sendRelations(entry, false);
    else if (entry.kind === 'patch') run = this.app.store.revert(entry.items.map((i) => ({ id: i.id, patch: i.after, expect: i.before })));
    else if (entry.kind === 'create') run = this.app.store.restore(entry.ids);
    else if (entry.kind === 'review') run = this.app.store.markReviewed(entry.ids);
    else if (entry.kind === 'read') run = this.app.store.markRead(entry.ids, entry.read);
    else run = entry.kind === 'remove' ? this.app.store.remove(entry.ids) : this.app.store.restore(entry.ids);
    run.then(
      () => this.#undo.push(entry),
      (error) => this.app.toasts.error(t('Redo failed'), error),
    );
  }

  /** Conflict on undo: who changed it in the meantime? (from the issue's history) */
  async #undoFailed(entry: UndoEntry, error: unknown) {
    if (errorCode(error) !== 'conflict') {
      this.app.toasts.error(t('Undo failed'), error);
      return;
    }
    const data = (error as { data?: { issueId?: IssueId; identifier?: string; field?: string } }).data ?? {};
    let who: string | null = null;
    let byOwner = false;
    if (data.issueId) {
      try {
        const doc = await this.app.store.fetchDetail(data.issueId);
        const row = doc?.history.find((h) => h.field === data.field || (data.field === 'sprintId' && h.field === 'sprint'));
        if (row) {
          this.app.store.watchAgents();
          who = actorName(row.actor, this.app.store.agents.get());
          byOwner = isOwnerKind(row.actor.kind);
        }
      } catch {
        // name stays unknown
      }
    }
    const field = data.field ? (FIELD_LABEL[data.field as PatchField] ?? data.field) : t('value');
    const key = data.identifier ?? t('Issue');
    // Only this sentence; the raw server message ("… please reload …") says the same again.
    const text = byOwner
      ? t('Not undone: {key} was changed by you in the meantime ({field}).', { key, field })
      : who
      ? t('Not undone: {key} was changed by {who} in the meantime ({field}).', { key, who, field })
      : t('Not undone: {key} was changed by someone else in the meantime ({field}).', { key, field });
    this.app.toasts.show(text, undefined, 'error');
    void entry;
  }

  // Undo jumps to where the action happened and selects the affected issues again.
  #restoreContext(entry: UndoEntry) {
    this.app.closeOverlays();
    const ctx = entry.ctx;
    const ids = entryIds(entry).map((id) => this.app.store.resolvedId(id));
    const page = this.app.nav.page.get();
    if (JSON.stringify(page) !== JSON.stringify(ctx.page)) {
      this.app.nav.go(ctx.page, { filters: ctx.filters, quick: ctx.quick });
    }
    if (ctx.page.name === 'view') {
      const focus = this.app.store.resolvedId(ctx.focus ?? ids[0]);
      if (ids.length > 1) this.app.list.select(ids);
      this.app.list.focus(focus, true);
      // If the issues had dropped out of the filter (e.g. priority changed under "Priority: none"),
      // they come back only with the undo update: restore selection and focus then.
      if (ids.some((id) => !this.app.list.isVisible(id))) this.#reselectWhenBack(ctx.page, ids, focus);
    }
  }

  #reselectWhenBack(page: Page, ids: IssueId[], focus: IssueId) {
    const list = this.app.list;
    const samePage = () => JSON.stringify(this.app.nav.page.get()) === JSON.stringify(page);
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
    };
    // Runs after the list (subscribed later), so it already sees the recomputed view.
    const off = this.app.store.onChange(() => {
      if (!samePage()) return stop();
      const visible = ids.filter((id) => list.isVisible(id));
      if (ids.length > 1 && visible.length > list.selection().length) list.select(ids);
      if (list.isVisible(focus) && list.focusId() !== focus) list.focus(focus, true);
      if (visible.length === ids.length) stop();
    });
    const timer = setTimeout(stop, 5000);
  }

  // ---------------------------------------------------------------- Copying

  /** Copies text; `what` is the translated name of the thing ("Link", "Branch name"). */
  async copy(text: string, what: string) {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      this.app.cues.emit('copy');
      this.app.toasts.show(t('{what} copied', { what }));
    } catch {
      this.app.toasts.show(`${what}: ${text}`);
    }
  }

  copyLink(id: IssueId) {
    const issue = this.app.store.get(id);
    if (!issue || issue.pending) return;
    void this.copy(`${globalThis.location?.origin ?? ''}/issue/${issue.key}`, t('Link'));
  }

  copyBranch(id: IssueId) {
    const issue = this.app.store.get(id);
    if (!issue || issue.pending) return;
    void this.copy(branchName(issue.key, issue.title, this.app.branchPrefix), t('Branch name'));
  }

  /** One identifier, or several one per line. */
  copyKeys(ids: IssueId[]) {
    const keys = ids.flatMap((id) => {
      const issue = this.app.store.get(id);
      return issue && !issue.pending ? [issue.key] : [];
    });
    if (keys.length) void this.copy(keys.join('\n'), keys.length === 1 ? t('ID') : tn(keys.length, '{count} ID', '{count} IDs'));
  }
}
