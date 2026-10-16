// Issue detail (full page) and peek (floating card). Both show the same target issue: the open
// one on the detail page; in the list with peek open, the focused one or the preview from the
// command menu. Description, comments and history come from a detail subscription (loaded only
// when opened); the focused issue is prefetched.
import { api } from '@selfbound/backend/api';
import { workflowsOf } from '../workflow.ts';
import { CLOSED, PRIORITY_LABEL, actorName, dayLabel, dueLabel, fullDate, relativeTime, shortDate } from '../format.ts';
import { intlLocale, t } from '../i18n.ts';
import { Slice } from '../observable.ts';
import { contextLabel, issueModel, modelInfo, modelLabel, modelProblem, type ModelSource } from '../models.ts';
import { isOwnerKind, LEGACY_OWNER_KIND, OWNER_KIND, PATCH_FIELDS, type Actor, type DetailDoc, type Issue, type IssueId, type PatchField, type Priority, type PullRequestInfo, type Status, type TeamBadge } from '../types.ts';
import type { App } from './index.ts';
import { errorCode } from './toasts.ts';
import { inInbox, unread } from '../inbox.ts';
import { RELATION_LABEL, historyText } from './historyText.ts';
import { BodyEditSession, type BodyEdit } from '../bodyEdit.ts';

/**
 * Split view: how long an entry must stay on the right before it counts as read. Skimming past
 * it with J/K is not looking at it; and marking it (save, redraw row and count) does not land in
 * the same frame as the switch.
 */
const SPLIT_READ_MS = 250;

export interface ActivityItem {
  id: string;
  kind: 'event' | 'comment';
  at: number;
  ago: string;
  full: string;
  /** Actor kind with the legacy owner value already turned into `owner` */
  actor: Exclude<Actor['kind'], typeof LEGACY_OWNER_KIND>;
  actorName: string;
  /** Event text without the name ("changed the status …") */
  text?: string;
  body?: string;
  edited?: boolean;
  pending?: boolean;
  /** The owner may edit/delete it */
  mine?: boolean;
  /** Field change by someone else (e.g. an agent) that can be reverted */
  revert?: { field: PatchField; from: unknown; to: unknown };
}

export interface RelationGroup {
  label: string;
  items: { relationId: string; id: IssueId; key: string; title: string; status: Status; deleted: boolean }[];
}

export interface IssueBrief {
  id: IssueId;
  key: string;
  title: string;
  status: Status;
  priority: Priority;
}

export interface DetailState {
  id: IssueId;
  key: string;
  title: string;
  status: Status;
  statusLabel: string;
  /** custom status color (#rrggbb) or null */
  statusColor: string | null;
  priority: Priority;
  priorityLabel: string;
  team: TeamBadge;
  labels: { id: string; name: string; hue: number }[];
  project: { id: string; name: string } | null;
  sprint: { id: string; name: string; late: boolean; state: string } | null;
  estimate: number | null;
  /**
   * Desired model, own or inherited (`source` parent or team, shown dimmed with `from`): "Claude Opus 5.5 ·
   * xhigh", the context window as info, and a hint if the model is no longer enabled or in the catalog.
   */
  model: { label: string; context: string | null; source: ModelSource; from: string | null; problem: string | null; logo: string | null } | null;
  due: { day: string; label: string; long: string; overdue: boolean } | null;
  /** Snoozed until this day */
  snoozed: { day: string; long: string } | null;
  /** Open issues can be snoozed */
  snoozable: boolean;
  parent: IssueBrief | null;
  children: IssueBrief[];
  created: string;
  createdFull: string;
  createdBy: string;
  createdByKind: Actor['kind'];
  updated: string;
  /** Is in the inbox, and still unread there */
  inInbox: boolean;
  unread: boolean;
  deleted: boolean;
  pending: boolean;
  /** null = still loading */
  body: { markdown: string; version: number; updatedBy: string; updated: string } | null;
  activity: ActivityItem[] | null;
  relations: RelationGroup[];
  pullRequests: PullRequestInfo[];
  position: { index: number; total: number } | null;
  /** Older comments can be loaded */
  olderComments: 'more' | 'loading' | null;
}

/** Description editing (bodyEdit.ts). */
export type DescEdit = BodyEdit;

/** The actor kind for display: data written before the rename says `steven` for the owner. */
const kindOf = (actor: Actor) => (actor.kind === LEGACY_OWNER_KIND ? OWNER_KIND : actor.kind);

/** Consecutive description edits by the same actor within this time = one row. */
const DESC_MERGE_MS = 10 * 60_000;

/**
 * Autosave writes one "changed the description" row per save. Directly consecutive rows of the
 * same actor (at most DESC_MERGE_MS apart) are merged into one showing the time of the last edit.
 */
export function mergeDescriptionEdits(items: ActivityItem[], descIds: ReadonlySet<string>): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    if (prev && descIds.has(item.id) && descIds.has(prev.id) && prev.actor === item.actor && prev.actorName === item.actorName && item.at - prev.at <= DESC_MERGE_MS) {
      out[out.length - 1] = { ...prev, id: item.id, at: item.at, ago: item.ago, full: item.full };
      continue;
    }
    out.push(item);
  }
  return out;
}

const draftKey = (id: string) => `selfbound:desc:${id}`;
const commentKey = (id: string) => `selfbound:comment:${id}`;

export class DetailController {
  readonly state = new Slice<DetailState | null>(null);
  readonly peekOpen = new Slice(false);
  /**
   * Split view: the focused issue shows on the right. In the wide inbox this is only the right
   * side (the list is always split); in other lists and on the board it is the split view itself.
   */
  readonly split = new Slice(false);
  /** Opened in the inbox: the inbox's right side does not carry over to other lists, nor back. */
  #splitInbox = false;
  #readTimer: ReturnType<typeof setTimeout> | null = null;
  #readFor: IssueId | null = null;
  /** Description editing (autosave, draft, conflict) */
  readonly #body: BodyEditSession;
  readonly desc: Slice<DescEdit>;
  /** Issue open on the detail page */
  #pageId: IssueId | null = null;
  /** Preview from the command menu or search */
  #previewId: IssueId | null = null;
  #target: IssueId | null = null;
  #unwatch: (() => void) | null = null;
  #prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Older comments loaded on demand, per issue */
  #older = new Map<IssueId, { comments: DetailDoc['comments']; hasMore: boolean; loading: boolean }>();

  constructor(private app: App) {
    this.#body = new BodyEditSession({
      draftKey,
      save: (id, text, base) => this.app.store.setDescription(id as IssueId, text, base),
      current: (id) => {
        const doc = this.app.store.detail(id as IssueId);
        return doc ? { markdown: doc.body.markdown, version: doc.body.version, by: actorName(doc.body.updatedBy, this.app.store.agents.get()) } : null;
      },
      errorCode,
      onError: (error, retry) => this.app.toasts.error(t('Description not saved'), error, retry),
      notify: (message) => this.app.toasts.show(message),
    });
    this.desc = this.#body.state;
  }

  target() {
    return this.#target;
  }

  pageId() {
    return this.#pageId;
  }

  /** Peek is visible (open, or as a preview from the menu). */
  peekVisible() {
    return this.#pageId === null && !this.splitShown() && (this.peekOpen.get() || this.#previewId !== null) && this.#target !== null;
  }

  /** The right side of the split view shows the focused issue. */
  splitShown() {
    return this.#pageId === null && this.split.get() && this.app.splitCapable();
  }

  /** Split view: show the focused issue on the right (click, J/K, space; ⇧ space in other lists). */
  openSplit() {
    if (!this.app.splitCapable() || !this.app.list.focusId()) return;
    // Otherwise an issue arriving at the top would take over the right side (and be read).
    this.app.list.pinFocus();
    if (!this.split.get()) {
      this.#splitInbox = this.#inInbox();
      this.peekOpen.set(false);
      this.split.set(true);
    }
    this.#retarget();
  }

  /** ⇧ space, the button in the view bar: open or close the split view (without focus: the first issue). */
  toggleSplit() {
    if (this.splitShown()) return this.closeSplit();
    if (!this.app.splitCapable()) return;
    if (!this.app.list.focusId()) this.app.list.focusEdge(false);
    this.openSplit();
  }

  #inInbox() {
    const page = this.app.nav.page.get();
    return page.name === 'view' && page.view.kind === 'inbox';
  }

  closeSplit() {
    if (!this.split.get()) return;
    this.split.set(false);
    this.#retarget();
  }

  /** Page or window width changed: without room for the split view the right side closes. */
  onLayout() {
    if (this.split.get() && !this.#keepSplit()) this.split.set(false);
    if (this.#wanted() !== this.#target) this.#retarget();
  }

  /**
   * It stays open when going into the issue (Enter) and back. The inbox's right side closes when
   * leaving the inbox; the split view of the other lists stays on for the session (other list,
   * settings and back), only not across into the inbox.
   */
  #keepSplit() {
    if (this.app.nav.page.get().name === 'issue') return true;
    if (!this.app.wide.get() || this.app.mobile.get()) return false;
    return this.#splitInbox ? this.app.splitCapable() && this.#inInbox() : !this.#inInbox();
  }

  // ---------------------------------------------------------------- Choosing the target

  openPage(id: IssueId) {
    this.peekOpen.set(false);
    this.#previewId = null;
    if (this.#pageId !== id) this.#endEdit(true);
    this.#pageId = id;
    this.#retarget();
  }

  closePage() {
    if (this.#pageId === null) return;
    this.#endEdit(true);
    this.#pageId = null;
    this.#retarget();
  }

  togglePeek() {
    // In the split inbox the issue is already on the right: space shows or closes that side.
    if (this.app.splitLayout()) return this.split.get() ? this.closeSplit() : this.openSplit();
    this.peekOpen.set(!this.peekOpen.get());
    if (this.peekOpen.get()) this.#markSeen(this.app.list.focusId());
    this.#retarget();
  }

  closePeek() {
    if (!this.peekOpen.get() && this.#previewId === null) return;
    this.peekOpen.set(false);
    this.#previewId = null;
    this.#retarget();
  }

  /** Preview while moving through the command menu. */
  preview(id: IssueId | null) {
    if (this.#previewId === id) return;
    this.#previewId = id;
    this.#retarget();
  }

  onFocus(id: IssueId | null) {
    if (this.splitShown()) this.#retarget();
    else if (this.peekOpen.get()) {
      this.#markSeen(id);
      this.#retarget();
    }
    // Prefetch the focused issue's description so peek and open show content right away.
    if (this.#prefetchTimer) clearTimeout(this.#prefetchTimer);
    if (id) this.#prefetchTimer = setTimeout(() => this.app.store.prefetchDetail(id), 120);
  }

  #markSeen(id: IssueId | null) {
    const issue = id ? this.app.store.get(id) : null;
    if (issue && unread(issue) && !issue.pending) this.app.edit.markRead([issue._id]);
  }

  /** Which issue to show: detail page, split view, preview, peek. */
  #wanted(): IssueId | null {
    if (this.#pageId) return this.#pageId;
    if (this.splitShown()) return this.app.list.focusId();
    return this.#previewId ?? (this.peekOpen.get() ? this.app.list.focusId() : null);
  }

  #retarget() {
    // Inbox became empty: close the right side, otherwise an entry arriving later would open itself.
    // Other lists keep the split view (an empty filter result shows the hint on the right).
    if (this.splitShown() && this.#splitInbox && !this.app.list.focusId()) this.split.set(false);
    const target = this.#wanted();
    const readFor = this.splitShown() ? target : null;
    if (readFor !== this.#readFor) {
      if (this.#readTimer) clearTimeout(this.#readTimer);
      this.#readTimer = null;
      this.#readFor = readFor;
      if (readFor) {
        this.#readTimer = setTimeout(() => {
          this.#readTimer = null;
          if (this.#target === readFor && this.splitShown()) this.#markSeen(readFor);
        }, SPLIT_READ_MS);
      }
    }
    if (target !== this.#target) {
      // Split view: switching while editing the description saves it first.
      if (this.desc.get().editing) this.#endEdit(true);
      this.#unwatch?.();
      this.#unwatch = null;
      this.#target = target;
      if (target) {
        this.app.store.watchAgents();
        this.#unwatch = this.app.store.watchDetail(target, () => this.refresh());
      }
    }
    this.refresh();
    this.app.updateShell();
  }

  /** Recompute only if the change affects the shown issue (itself, parent, sub-issues, position). */
  refreshIf(ids: ReadonlySet<IssueId>) {
    const id = this.#target;
    const st = this.state.get();
    if (!id || !st || st.id !== id || ids.has(id) || this.app.store.resolvedId(id) !== id) return this.refresh();
    if (st.parent && ids.has(st.parent.id)) return this.refresh();
    for (const child of st.children) if (ids.has(child.id)) return this.refresh();
    for (const changed of ids) if (this.app.store.get(changed)?.parentId === id) return this.refresh();
    const pos = this.app.list.positionOf(id);
    if (pos?.index !== st.position?.index || pos?.total !== st.position?.total) this.refresh();
  }

  /** Recompute (issue, detail subscription, metadata or agents changed). */
  refresh() {
    const id = this.#target;
    const issue = id ? this.app.store.get(id) : undefined;
    if (!id || !issue) {
      if (this.state.get() !== null) this.state.set(null);
      return;
    }
    const doc = this.app.store.detail(id);
    this.state.set(this.#compute(issue, doc ?? null));
    if (doc && (this.#pageId === id || this.splitShown())) this.#checkDescription(doc);
  }

  #compute(issue: Issue, doc: DetailDoc | null): DetailState {
    const store = this.app.store;
    const meta = store.meta.get();
    const agents = store.agents.get();
    const labels = new Map(meta?.labels.map((l) => [l._id as string, l]) ?? []);
    const project = issue.projectId ? meta?.projects.find((p) => p._id === issue.projectId) : undefined;
    const sprint = issue.sprintId ? meta?.sprints.find((s) => s._id === issue.sprintId) : undefined;
    const brief = (i: Issue): IssueBrief => ({ id: i._id, key: i.key, title: i.title, status: i.status, priority: i.priority });
    const parent = issue.parentId ? store.get(issue.parentId) : undefined;
    const children: IssueBrief[] = [];
    for (const other of store.childrenOf(issue._id)) if (other.deletedAt === undefined) children.push(brief(other));
    children.sort((a, b) => a.key.localeCompare(b.key, intlLocale(), { numeric: true }));
    const due = issue.dueDate ? dueLabel(issue.dueDate) : null;
    const state = workflowsOf(meta).of(issue);
    const model = issueModel(meta, issue, parent);
    return {
      id: issue._id,
      key: issue.key,
      title: issue.title,
      status: state.status,
      statusLabel: state.name,
      statusColor: state.color,
      priority: issue.priority,
      priorityLabel: PRIORITY_LABEL[issue.priority],
      team: this.app.list.teamBadge(issue.teamId),
      labels: issue.labelIds.map((id) => ({ id, name: labels.get(id)?.name ?? '…', hue: labels.get(id)?.hue ?? 0 })),
      project: project ? { id: project._id, name: project.name } : null,
      sprint: sprint ? { id: sprint._id, name: sprint.name, late: store.sprintKinds.get().get(issue._id) === 'late', state: sprint.state } : null,
      estimate: issue.estimate ?? null,
      model: model
        ? {
            label: modelLabel(meta, model.choice),
            context: contextLabel(modelInfo(meta, model.choice)),
            source: model.source,
            from: model.source === 'parent' ? (parent?.key ?? null) : model.source === 'team' ? (meta?.teams.find((x) => x._id === issue.teamId)?.name ?? null) : null,
            problem: modelProblem(meta, model.choice),
            logo: modelInfo(meta, model.choice)?.logo ?? null,
          }
        : null,
      due: issue.dueDate && due ? { day: issue.dueDate, label: due.label, long: dayLabel(issue.dueDate), overdue: due.overdue } : null,
      snoozed: issue.snoozedUntil ? { day: issue.snoozedUntil, long: dayLabel(issue.snoozedUntil) } : null,
      snoozable: !CLOSED.has(issue.status),
      parent: parent ? brief(parent) : null,
      children,
      created: shortDate(issue.createdAt),
      createdFull: fullDate(issue.createdAt),
      createdBy: actorName(issue.createdBy, agents),
      createdByKind: issue.createdBy.kind,
      updated: relativeTime(issue.updatedAt),
      inInbox: inInbox(issue),
      unread: unread(issue),
      deleted: issue.deletedAt !== undefined,
      pending: !!issue.pending,
      body: doc ? { markdown: doc.body.markdown, version: doc.body.version, updatedBy: actorName(doc.body.updatedBy, agents), updated: relativeTime(doc.body.updatedAt) } : issue.pending ? { markdown: '', version: 1, updatedBy: t('You'), updated: t('just now') } : null,
      activity: doc ? this.#activity(doc, agents) : issue.pending ? [] : null,
      relations: doc ? this.#relations(doc) : [],
      pullRequests: doc?.pullRequests ?? [],
      position: this.app.list.positionOf(issue._id),
      olderComments: doc ? this.#olderState(issue._id, doc) : null,
    };
  }

  #olderState(id: IssueId, doc: DetailDoc): DetailState['olderComments'] {
    const older = this.#older.get(id);
    if (older?.loading) return 'loading';
    return (older ? older.hasMore : doc.commentsHasMore) ? 'more' : null;
  }

  /** "Load older comments": the 100 before the oldest one loaded so far (comments.page). */
  async loadOlderComments() {
    const id = this.#target;
    const doc = id ? this.app.store.detail(id) : null;
    if (!id || !doc) return;
    const older = this.#older.get(id) ?? { comments: [], hasMore: !!doc.commentsHasMore, loading: false };
    const oldest = older.comments[0] ?? doc.comments.find((c) => !c.pending);
    if (!oldest || older.loading) return;
    older.loading = true;
    this.#older.set(id, older);
    this.refresh();
    try {
      const page = await this.app.store.client.query(api.comments.page, { issueId: id, before: oldest._id as never });
      older.comments = [...(page.comments as unknown as DetailDoc['comments']), ...older.comments];
      older.hasMore = page.hasMore;
    } catch (error) {
      this.app.toasts.error(t('Older comments not loaded'), error);
    } finally {
      older.loading = false;
      this.refresh();
    }
  }

  #activity(doc: DetailDoc, agents: ReadonlyMap<string, string>): ActivityItem[] {
    const items: ActivityItem[] = [];
    for (const h of doc.history) {
      const text = historyText(h, this.app.store);
      if (!text) continue;
      const field = (h.field === 'sprint' ? 'sprintId' : h.field) as PatchField;
      const revertable = !isOwnerKind(h.actor.kind) && PATCH_FIELDS.includes(field) && field !== 'title' && !(field === 'snoozedUntil' && h.actor.kind === 'system');
      items.push({ id: h._id, kind: 'event', at: h.at, ago: relativeTime(h.at), full: fullDate(h.at), actor: kindOf(h.actor), actorName: actorName(h.actor, agents), text, ...(revertable ? { revert: { field, from: h.from ?? null, to: h.to ?? null } } : {}) });
    }
    const older = this.#older.get(doc.id)?.comments ?? [];
    const seen = new Set(doc.comments.map((c) => String(c._id)));
    for (const c of [...older.filter((o) => !seen.has(String(o._id))), ...doc.comments]) {
      items.push({
        id: String(c._id),
        kind: 'comment',
        at: c.createdAt,
        ago: relativeTime(c.createdAt),
        full: fullDate(c.createdAt),
        actor: kindOf(c.author),
        actorName: actorName(c.author, agents, c.authorName),
        body: c.body,
        edited: c.editedAt !== undefined,
        pending: !!(c as { pending?: boolean }).pending,
        mine: isOwnerKind(c.author.kind),
      });
    }
    // Chronological, oldest first; the comment input sits below.
    items.sort((a, b) => a.at - b.at);
    return mergeDescriptionEdits(items, new Set(doc.history.filter((h) => h.field === 'description').map((h) => h._id)));
  }

  #relations(doc: DetailDoc): RelationGroup[] {
    const groups = new Map<string, RelationGroup>();
    for (const r of doc.relations) {
      const label = RELATION_LABEL[`${r.type}:${r.direction}`] ?? r.type;
      let group = groups.get(label);
      if (!group) groups.set(label, (group = { label, items: [] }));
      group.items.push({ relationId: r.id, id: r.other.id, key: r.other.identifier, title: r.other.title, status: r.other.status, deleted: r.other.deleted });
    }
    return [...groups.values()];
  }

  // ---------------------------------------------------------------- Description

  startEdit() {
    const s = this.state.get();
    if (!s || !s.body || s.pending) return;
    this.#body.start(s.id, { markdown: s.body.markdown, version: s.body.version, by: s.body.updatedBy });
  }

  input(text: string) {
    this.#body.input(text);
  }

  saveDescription() {
    return this.#body.save();
  }

  /** Someone else's change arrives while the owner types → notice instead of overwriting. */
  #checkDescription(doc: DetailDoc) {
    const id = this.#target;
    if (id) this.#body.check(id, { markdown: doc.body.markdown, version: doc.body.version, by: actorName(doc.body.updatedBy, this.app.store.agents.get()) });
  }

  /** Keep own version: save on top of the new version. */
  keepMine() {
    this.#body.keepMine();
  }

  /** Take the other version; one's own stays in the clipboard. */
  takeTheirs() {
    this.#body.takeTheirs();
  }

  finishEdit() {
    return this.#body.finish();
  }

  #endEdit(save: boolean) {
    this.#body.end(save);
  }

  // ---------------------------------------------------------------- Comments

  /** Unsent comment of an issue (survives navigating away and reloading, like the description). */
  commentDraft(id: string): string {
    try {
      return globalThis.localStorage?.getItem(commentKey(id)) ?? '';
    } catch {
      return '';
    }
  }

  setCommentDraft(id: string, text: string) {
    try {
      if (text.trim()) globalThis.localStorage?.setItem(commentKey(id), text);
      else globalThis.localStorage?.removeItem(commentKey(id));
    } catch {
      // ignore
    }
  }

  async addComment(body: string) {
    const id = this.#target;
    const text = body.trim();
    if (!id || !text) return false;
    try {
      await this.app.store.addComment(id, text);
      this.setCommentDraft(id, '');
      return true;
    } catch (error) {
      this.app.toasts.error(t('Comment not saved'), error, () => void this.addComment(text));
      return false;
    }
  }

  async editComment(commentId: string, body: string) {
    const id = this.#target;
    if (!id || !body.trim()) return;
    try {
      await this.app.store.editComment(id, commentId, body.trim());
    } catch (error) {
      this.app.toasts.error(t('Comment not updated'), error, () => void this.editComment(commentId, body));
    }
  }

  async removeComment(commentId: string) {
    const id = this.#target;
    if (!id) return;
    try {
      await this.app.store.removeComment(id, commentId);
    } catch (error) {
      this.app.toasts.error(t('Comment not deleted'), error, () => void this.removeComment(commentId));
    }
  }

  async removeRelation(relationId: string) {
    const id = this.#target;
    if (!id) return;
    const rel = this.app.store.detail(id)?.relations.find((r) => r.id === relationId);
    if (!rel) return;
    // Through the editor: undo recreates the relation; the editor reports errors.
    const [from, to] = rel.direction === 'out' ? [id, rel.other.id] : [rel.other.id, id];
    await this.app.edit.removeRelation({ from, to, type: rel.type, relationId, at: id }).catch(() => {});
  }

  /** On the detail page, step to the next issue of the list. */
  step(delta: number) {
    if (this.splitShown()) return this.app.list.moveFocus(delta);
    const id = this.#pageId;
    if (!id) return;
    const next = this.app.list.neighbor(id, delta);
    if (next) {
      this.app.list.focus(next);
      this.app.openIssue(next, { replace: true });
    }
  }
}
