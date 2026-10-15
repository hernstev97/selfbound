// Command menu (Ctrl K), search (/), shortcut help (?), filter (F) and ONE picker pattern for all
// properties: status, priority, labels, project, sprint, estimate, due date, parent, team,
// relations. The same items feed the context menu (submenus) and the second level of the
// command menu ("Status: In progress").
import {
  ESTIMATES,
  PRIORITY_KEYWORDS,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  STATUS_KEYWORDS,
  addDays,
  berlinToday,
  dayLabel,
  dayOf,
  parseDay,
  parseDueInput,
  today,
} from '../format.ts';
import { intlLocale, msg, t, tc, tn } from '../i18n.ts';
import { ICON, PRIORITY_ICON, statusIcon } from '../icons.ts';
import { STATE_TYPE_LABEL } from '@selfbound/backend/shared/workflow';
import { stateGroupKey, statusFilterValue, workflowsOf, type StateGroup } from '../workflow.ts';
import { formatShortcut } from '../keyboard.ts';
import { hasLoss, moveLines, movePlan } from '../move.ts';
import { Slice } from '../observable.ts';
import { IssueSearch, looksLikeIdentifier, scoreText } from '../search.ts';
import type { Issue, IssueId, IssuePatch, MenuItem, PaletteKind, PaletteState, Priority, StateId, Status } from '../types.ts';
import { api } from '@selfbound/backend/api';
import { ACTIONS, SECTION_LABEL, actionById, type Action } from './actions.ts';
import type { App } from './index.ts';

/** What a picker acts on: issues (list, detail) or the draft in the create dialog. */
export type PickerTarget = { kind: 'issues'; ids: IssueId[] } | { kind: 'draft' };

/** 'stay' = the menu stays open (multi-select, submenu). */
type Run = () => void | 'stay';

export interface ItemSet {
  items: MenuItem[];
  run: Map<string, Run>;
  multi: boolean;
  /** Hint below the list (e.g. statuses not allowed under a fixed order) */
  hint?: string;
}

const MAX_ITEMS = 50;
const RECENT = 'selfbound:recent';

export const PICKER_KINDS: PaletteKind[] = ['status', 'priority', 'labels', 'project', 'sprint', 'estimate', 'due', 'parent', 'team'];

/** Title and placeholder per palette kind (English; translated when the palette opens). */
const TITLES: Record<PaletteKind, [string, string]> = {
  command: [msg('Command menu'), msg('Command, value or issue …')],
  search: [msg('Issue search'), msg('Search issues: title, text or ID like ABC-123 …')],
  help: [msg('Keyboard shortcuts'), msg('Search shortcut or action …')],
  filter: [msg('Filter'), msg('Filter by …')],
  status: [msg('Status'), msg('Change status …')],
  priority: [msg('Priority'), msg('Set priority …')],
  labels: [msg('Labels'), msg('Labels …')],
  project: [msg('Project'), msg('Project …')],
  sprint: [msg('Sprint'), msg('Sprint …')],
  estimate: [msg('Estimate'), msg('Estimate …')],
  due: [msg('Due date'), msg('e.g. tomorrow, next week, 12.10. …')],
  snooze: [msg('Snooze until'), msg('e.g. tomorrow, next week, 12.10. …')],
  parent: [msg('Parent'), msg('Search parent issue …')],
  team: [msg('Team'), msg('Team …')],
  relation: [msg('Relation'), msg('Search issue …')],
  duplicate: [msg('Duplicate of'), msg('Search original issue …')],
  move: [msg('Accept'), msg('Status after triage …')],
  repeat: [msg('Repeat'), msg('e.g. monday, monthly 1 …')],
  downgrade: [msg('Downgrade'), msg('Which issue drops one level?')],
  switchTeam: [msg('Switch team'), msg('Team …')],
  article: [msg('Link wiki page'), msg('Search page (title or text) …')],
};

/** Weekday names Monday … Sunday in the given locale (2024-01-01 was a Monday). */
function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  return Array.from({ length: 7 }, (_, n) => format.format(new Date(2024, 0, 1 + n)));
}

/** Filter properties; `label` is English and translated when shown. */
const FILTER_FIELDS = [
  { id: 'status', label: msg('Status'), icon: ICON.active },
  { id: 'priority', label: msg('Priority'), icon: PRIORITY_ICON[2] },
  { id: 'team', label: msg('Team'), icon: ICON.team },
  { id: 'label', label: msg('Label'), icon: ICON.label },
  { id: 'project', label: msg('Project'), icon: ICON.projects },
  { id: 'sprint', label: msg('Sprint'), icon: ICON.sprint },
] as const;
type FilterField = (typeof FILTER_FIELDS)[number]['id'];

export class PaletteController {
  readonly state = new Slice<PaletteState | null>(null);
  #base: MenuItem[] = [];
  #run = new Map<string, Run>();
  #target: PickerTarget = { kind: 'issues', ids: [] };
  #search = new IssueSearch();
  #recent: IssueId[] = [];
  #serverTimer: ReturnType<typeof setTimeout> | null = null;
  #serverSeq = 0;
  #filterField: FilterField | null = null;
  #relation: { type: 'blocks' | 'related' | 'duplicate'; reverse: boolean; markDuplicate: boolean } | null = null;
  #calendarMonth: string | null = null;
  #downgrade: { teamId: string; priority: 1 | 2 } | null = null;
  #baseHint: string | null = null;
  /** The "move to team" confirmation is open (back returns to the team picker) */
  #moveConfirm: { ids: IssueId[]; anchor: PaletteState['anchor'] } | null = null;
  /** Anchor of the picker whose item is running (only during `choose`) */
  #anchor: PaletteState['anchor'] = null;

  constructor(private app: App) {
    try {
      this.#recent = JSON.parse(globalThis.localStorage?.getItem(RECENT) ?? '[]');
    } catch {
      this.#recent = [];
    }
  }

  // ---------------------------------------------------------------- Open / close

  #seq = 0;

  open(kind: PaletteKind, opts: { anchor?: PaletteState['anchor']; target?: PickerTarget; query?: string } = {}) {
    this.app.menu.close();
    this.#target = opts.target ?? this.#defaultTarget(kind);
    this.#moveConfirm = null;
    this.#articlePick = null;
    // The relation type applies only to the picker that openRelation opens right after.
    this.#relation = null;
    this.#filterField = null;
    this.#calendarMonth = null;
    const set = this.#items(kind, '');
    this.#base = set.items;
    this.#run = set.run;
    this.#baseHint = set.hint ?? null;
    const title = t(TITLES[kind][0]);
    const placeholder = t(TITLES[kind][1]);
    const items = kind === 'command' ? this.#commandTop() : set.items;
    const checked = items.findIndex((i) => i.checked && !i.checkbox);
    this.state.set({
      kind,
      title,
      placeholder,
      query: '',
      items: items.slice(0, kind === 'help' ? 200 : MAX_ITEMS * 4),
      active: Math.max(0, checked),
      targetLabel: this.#targetLabel(kind),
      multi: set.multi,
      anchor: opts.anchor ?? null,
      parent: null,
      calendar: kind === 'due' || kind === 'snooze' ? this.#calendar(kind) : null,
      hint: this.#baseHint,
      seq: ++this.#seq,
    });
    if (opts.query) this.setQuery(opts.query);
    this.#preview();
  }

  close() {
    if (!this.state.get()) return;
    this.#moveConfirm = null;
    this.state.set(null);
    // #relation stays: choose() closes BEFORE running, and the item still needs the type.
    this.app.detail.preview(null);
    if (this.#serverTimer) clearTimeout(this.#serverTimer);
  }

  #defaultTarget(kind: PaletteKind): PickerTarget {
    if (this.app.create.isOpen() && (PICKER_KINDS.includes(kind) || kind === 'team')) return { kind: 'draft' };
    return { kind: 'issues', ids: this.app.targets() };
  }

  #targetLabel(kind: PaletteKind): string | null {
    if (kind === 'search' || kind === 'help' || kind === 'filter' || kind === 'switchTeam') return null;
    if (this.#target.kind === 'draft') return t('New issue');
    const ids = this.#target.ids;
    if (ids.length > 1) return tn(ids.length, '{count} issue', '{count} issues');
    if (ids.length === 1) return this.app.store.get(ids[0])?.key ?? null;
    return null;
  }

  // ---------------------------------------------------------------- Input

  setQuery(query: string) {
    const s = this.state.get();
    if (!s) return;
    let items: MenuItem[];
    let hint: string | null = this.#baseHint;
    const q = query.trim();
    if (s.kind === 'article') {
      // Wiki page for a link in the text: hits come from the server.
      items = s.items;
      this.#scheduleArticles(q);
    } else if (s.kind === 'search' || s.kind === 'parent' || s.kind === 'relation' || s.kind === 'duplicate') {
      items = this.#issueItems(s.kind, q);
      if (s.kind === 'search') this.#scheduleServer(q);
    } else if (s.kind === 'command' && !q) {
      items = this.#commandTop();
    } else if (s.kind === 'filter' && !this.#filterField && q) {
      // First level with a query: all values of all properties, flat ("Status: In progress").
      const flat = this.#filterValues(null);
      items = rank(flat.items, q);
      for (const [id, run] of flat.run) this.#run.set(id, run);
    } else {
      items = q ? rank(this.#base, q) : this.#base;
      if (s.kind === 'labels' && q && !items.some((i) => i.label.toLowerCase() === q.toLowerCase())) {
        // Create a new label and set it right away.
        const id = 'l:new';
        this.#run.set(id, () => this.#createLabel(q));
        items = [...items, { id, label: t('Create label “{name}”', { name: q }), icon: ICON.plus }];
      }
      if (s.kind === 'command' && q.length >= 2) items = [...items.slice(0, 40), ...this.#issueItems('command', q).slice(0, 8)];
      if (s.kind === 'estimate' && /^\d+(\.\d+)?$/.test(q)) {
        const n = Number(q);
        const id = `est:${n}`;
        this.#run.set(id, () => this.apply({ estimate: n }));
        items = [{ id, label: t('Estimate: {n} points', { n }), icon: ICON.estimate }, ...items.filter((i) => i.id !== id)];
      }
      if (s.kind === 'snooze') {
        // Only a day after today makes sense: "today" and past days are not offered.
        const base = berlinToday();
        const day = parseDueInput(q, undefined, base);
        if (day && day > base) {
          const id = `snooze:${day}`;
          hint = `${q} → ${dayLabel(day)}`;
          this.#run.set(id, () => this.app.edit.snooze(this.#snoozeIds(), day));
          items = [{ id, label: dayLabel(day), detail: q, icon: ICON.calendar }, ...items.filter((i) => i.id !== id)];
          this.#calendarMonth = day.slice(0, 7);
        }
      }
      if (s.kind === 'due') {
        const day = parseDueInput(q);
        if (day) {
          const id = `due:${day}`;
          hint = `${q} → ${dayLabel(day)}`;
          this.#run.set(id, () => this.apply({ dueDate: day }));
          items = [{ id, label: dayLabel(day), detail: q, icon: ICON.calendar }, ...items.filter((i) => i.id !== id)];
          this.#calendarMonth = day.slice(0, 7);
        }
      }
    }
    if (q) items = items.map((i) => (i.section ? { ...i, section: undefined } : i));
    this.state.set({ ...s, query, items: items.slice(0, s.kind === 'help' ? 200 : MAX_ITEMS), active: 0, hint, calendar: s.kind === 'due' || s.kind === 'snooze' ? this.#calendar(s.kind) : null });
    this.#preview();
  }

  move(delta: number) {
    const s = this.state.get();
    if (!s || s.items.length === 0) return;
    this.state.set({ ...s, active: (s.active + delta + s.items.length) % s.items.length });
    this.#preview();
  }

  hover(index: number) {
    const s = this.state.get();
    if (s && s.active !== index) {
      this.state.set({ ...s, active: index });
      this.#preview();
    }
  }

  /** Enter or click. */
  choose(index = this.state.get()?.active ?? 0) {
    const s = this.state.get();
    const item = s?.items[index];
    if (!s || !item) return;
    const run = this.#run.get(item.id);
    const keepOpen = s.multi || item.submenu;
    // Sound: toggle a checkmark, open a submenu, run a command or pick a value.
    const cue = item.danger ? 'destructive' : item.checkbox || s.multi ? (item.checked ? 'toggleOff' : 'toggleOn') : item.submenu ? 'chirp' : s.kind === 'command' || s.kind === 'search' ? 'command' : 'select';
    this.app.cues.emit(cue, cue === 'select' ? Math.min(index, 7) : undefined);
    if (!keepOpen) this.close();
    this.#anchor = s.anchor;
    let result: void | 'stay' | undefined;
    try {
      result = run?.();
    } finally {
      this.#anchor = null;
    }
    if (keepOpen && this.state.get()) {
      if (s.multi && s.query) {
        // After toggling, the query is cleared and the item stays active.
        this.state.set({ ...this.state.get()!, query: '' });
        this.#refresh(item.id);
      } else if (result === 'stay' || s.multi) this.#refresh(item.id);
    }
  }

  /**
   * Move to another team. If something gets lost (project, team labels), the UI shows that first
   * and asks; otherwise the move happens directly (with a hint and undo).
   */
  requestMove(ids: IssueId[], teamId: string) {
    const store = this.app.store;
    const meta = store.meta.get();
    const team = meta?.teams.find((t) => t._id === teamId);
    const issues = ids.map((id) => store.get(id)).filter((i): i is Issue => !!i);
    const plan = movePlan(meta, issues, teamId);
    if (!team || plan.count === 0) return;
    if (!hasLoss(plan)) return this.app.edit.moveTeam(ids, teamId);
    const anchor = this.#anchor;
    const moving = issues.filter((i) => i.teamId !== teamId);
    const hint = moveLines(plan, moving.map((i) => i.key), team).join('\n');
    const label = tn(moving.length, 'Move to {team}', 'Move {count} issues to {team}', { team: team.name });
    const items: MenuItem[] = [
      { id: 'mvc:ok', label, team: this.app.list.teamBadge(team._id), keywords: 'move confirm verschieben bestätigen' },
      { id: 'mvc:no', label: t('Cancel'), icon: ICON.close },
    ];
    this.#run = new Map<string, Run>([['mvc:ok', () => this.app.edit.moveTeam(ids, teamId)]]);
    this.#base = items;
    this.#baseHint = hint;
    this.#moveConfirm = { ids, anchor };
    this.#target = { kind: 'issues', ids };
    this.state.set({
      kind: 'team',
      title: t('Team'),
      placeholder: t('Enter moves, Esc goes back'),
      query: '',
      items,
      active: 0,
      targetLabel: this.#targetLabel('team'),
      multi: false,
      anchor,
      parent: t('Team'),
      calendar: null,
      hint,
      seq: ++this.#seq,
    });
  }

  /** Back to the first level (filter, confirmation), or close. */
  back(): boolean {
    const s = this.state.get();
    if (!s) return false;
    if (this.#moveConfirm) {
      const { ids, anchor } = this.#moveConfirm;
      this.open('team', { target: { kind: 'issues', ids }, anchor: anchor ?? undefined });
      return true;
    }
    if (s.kind === 'filter' && this.#filterField) {
      this.#filterField = null;
      const set = this.#items('filter', '');
      this.#base = set.items;
      this.#run = set.run;
      this.state.set({ ...s, query: '', items: set.items, active: 0, parent: null, multi: false });
      return true;
    }
    this.close();
    return true;
  }

  /** After a multi-select toggle, recompute the checkmarks and keep the position. */
  #refresh(activeId: string) {
    const s = this.state.get();
    if (!s) return;
    const set = this.#filterField ? this.#filterValues(this.#filterField) : this.#items(s.kind, s.query);
    this.#base = set.items;
    for (const [id, run] of set.run) this.#run.set(id, run);
    const items = s.query.trim() ? rank(set.items, s.query) : set.items;
    const active = Math.max(0, items.findIndex((i) => i.id === activeId));
    this.state.set({ ...s, items: items.slice(0, MAX_ITEMS), active, multi: set.multi, parent: this.#filterField ? t(FILTER_FIELDS.find((f) => f.id === this.#filterField)!.label) : s.parent });
  }

  #preview() {
    const s = this.state.get();
    const item = s?.items[s.active];
    const previewable = s && (s.kind === 'search' || s.kind === 'command') && !s.anchor;
    this.app.detail.preview(previewable && item?.preview ? item.preview : null);
  }

  // ---------------------------------------------------------------- Effects

  /** Set a value: on issues (with undo) or in the draft. */
  apply(patch: IssuePatch, target = this.#target) {
    if (target.kind === 'draft') this.app.create.setField(patch);
    else this.app.edit.patch(target.ids, patch);
  }

  /** Pick a status: per issue, the status of its team with this name and type. */
  #setState(group: StateGroup, target = this.#target) {
    if (target.kind === 'draft') {
      const teamId = this.app.create.state.get().draft.teamId;
      const stateId = teamId ? group.byTeam.get(teamId) : undefined;
      this.app.create.setField(stateId ? { stateId: stateId as StateId } : { status: group.status });
      return;
    }
    this.app.edit.setState(target.ids, (issue) => group.byTeam.get(issue.teamId) as StateId | undefined);
  }

  /** Create a new label (no group, all teams) and set it on the targets. The picker stays open. */
  #createLabel(name: string): 'stay' {
    const target = this.#target;
    const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    this.app.store
      .call(api.labels.create, { name, hue })
      .then(({ labelId }) => {
        this.#toggleLabel(labelId, target);
        // Show the checkmark as soon as the label has arrived in the metadata.
        const meta = this.app.store.meta;
        const show = () => {
          if (!meta.get()?.labels.some((l) => l._id === labelId)) return false;
          if (this.state.get()?.kind === 'labels') this.#refresh(`l:${labelId}`);
          return true;
        };
        if (!show()) {
          const stop = meta.subscribe(() => {
            if (show()) stop();
          });
        }
      })
      .catch((error) => this.app.toasts.error(t('Label “{name}” not created', { name }), error));
    return 'stay';
  }

  #toggleLabel(labelId: string, target = this.#target) {
    if (target.kind === 'draft') this.app.create.toggleLabel(labelId);
    else this.app.edit.toggleLabel(target.ids, labelId as never);
  }

  // ---------------------------------------------------------------- Items

  #items(kind: PaletteKind, query: string): ItemSet {
    switch (kind) {
      case 'command':
        return this.#commandItems();
      case 'search':
        return { items: this.#issueItems('search', query), run: this.#run, multi: false };
      case 'help':
        return this.#helpItems();
      case 'filter':
        return this.#filterTop();
      case 'parent':
      case 'relation':
      case 'duplicate':
        return { items: this.#issueItems(kind, query), run: this.#run, multi: false };
      case 'move':
        return this.#moveItems();
      case 'downgrade':
        return this.#downgradeItems();
      case 'switchTeam':
        return this.#switchTeamItems();
      case 'article':
        return { items: [], run: new Map(), multi: false, hint: t('Type a title or text') };
      default:
        return this.pickerItems(kind, this.#target, '', true);
    }
  }

  /** Values of a property, for pickers, context submenus and the command menu. `inPicker`: the picker itself (with calendar) shows them. */
  pickerItems(kind: PaletteKind, target: PickerTarget, prefix = '', inPicker = false): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    const store = this.app.store;
    const meta = store.meta.get();
    const issues = target.kind === 'issues' ? target.ids.map((id) => store.get(id)).filter((i): i is Issue => !!i) : [];
    const draft = target.kind === 'draft' ? this.app.create.state.get().draft : null;
    const values = <T>(get: (i: Issue) => T, fromDraft: () => T): T[] => (draft ? [fromDraft()] : issues.map(get));
    const all = <T>(list: T[], value: T) => list.length > 0 && list.every((v) => v === value);
    const add = (item: MenuItem, fn: Run) => {
      items.push(prefix ? { ...item, label: `${prefix}${item.label}`, section: undefined } : item);
      run.set(item.id, fn);
    };
    const teamIds = new Set(draft ? [draft.teamId] : issues.map((i) => i.teamId));
    const oneTeam = teamIds.size === 1 ? [...teamIds][0] : null;
    let multi = false;
    let hint: string | undefined;
    switch (kind) {
      case 'status': {
        // Statuses of the affected teams; with several teams, those present in all (same name and type).
        const workflows = workflowsOf(meta);
        const teams = [...teamIds].filter((t): t is string => !!t);
        const groups = teams.length ? workflows.groups(teams).filter((g) => teams.every((t) => g.byTeam.has(t))) : [];
        const draftKey = () => {
          const stateId = this.app.create.draftState(draft!);
          const state = stateId ? workflows.byId.get(stateId) : draft!.teamId ? workflows.forStatus(draft!.teamId, draft!.status) : undefined;
          return state ? stateGroupKey(state) : '';
        };
        const current = values((i) => stateGroupKey(workflows.of(i)), draftKey);
        // Fixed order: only targets allowed for all affected issues.
        const permits = (g: StateGroup) =>
          draft
            ? !draft.teamId || (workflows.allowed(draft.teamId, null)?.has(g.byTeam.get(draft.teamId)!) ?? true)
            : issues.every((i) => {
                const target = g.byTeam.get(i.teamId);
                const allowed = workflows.allowed(i.teamId, i.stateId ?? null);
                return !allowed || target === i.stateId || (target !== undefined && allowed.has(target));
              });
        const blocked = groups.filter((g) => !permits(g));
        if (blocked.length) hint = t('Fixed order: {names} not allowed right now', { names: blocked.map((g) => g.name).join(', ') });
        groups.filter(permits).forEach((g, n) =>
          add(
            { id: `s:${g.key}`, label: g.name, icon: statusIcon(g.status, g.color), checked: all(current, g.key), keywords: stateKeywords(g), shortcut: prefix || n >= 9 ? undefined : String(n + 1) },
            () => this.#setState(g, target),
          ),
        );
        break;
      }
      case 'priority': {
        const current = values((i) => i.priority, () => draft!.priority);
        PRIORITY_ORDER.forEach((p) =>
          add({ id: `p:${p}`, label: PRIORITY_LABEL[p], icon: PRIORITY_ICON[p], checked: all(current, p), keywords: `prio ${PRIORITY_KEYWORDS[p]}`, shortcut: prefix ? undefined : String(p) }, () => this.apply({ priority: p }, target)),
        );
        break;
      }
      case 'labels': {
        multi = true;
        const labelSets = draft ? [new Set(draft.labelIds)] : issues.map((i) => new Set<string>(i.labelIds));
        const groups = new Map(meta?.labelGroups.map((g) => [g._id as string, g]) ?? []);
        const usable = (meta?.labels ?? []).filter((l) => !l.archived && (!l.teamId || l.teamId === oneTeam));
        // Groups first (one section per group), then labels without a group.
        const ungrouped = t('Labels');
        const sorted = [...usable].sort((a, b) => (a.groupId ? 0 : 1) - (b.groupId ? 0 : 1) || String(a.groupId ?? '').localeCompare(String(b.groupId ?? '')));
        for (const label of sorted) {
          const group = label.groupId ? groups.get(label.groupId) : undefined;
          const has = labelSets.length > 0 && labelSets.every((s) => s.has(label._id));
          add(
            { id: `l:${label._id}`, label: label.name, dot: label.hue, checkbox: true, checked: has, section: group ? (group.exclusive ? t('{group} · one', { group: group.name }) : group.name) : ungrouped, detail: prefix && group ? group.name : undefined },
            () => {
              this.#toggleLabel(label._id, target);
              return 'stay';
            },
          );
        }
        break;
      }
      case 'project': {
        const current = values((i) => i.projectId ?? null, () => draft!.projectId);
        add({ id: 'pr:none', label: t('No project'), icon: ICON.projects, checked: all(current, null) }, () => this.apply({ projectId: null }, target));
        if (oneTeam) {
          for (const project of meta?.projects.filter((p) => p.teamId === oneTeam) ?? []) {
            add({ id: `pr:${project._id}`, label: project.name, icon: ICON.projects, checked: all(current, project._id as string | null), detail: project.state === 'active' ? undefined : projectState(project.state) }, () => this.apply({ projectId: project._id }, target));
          }
        } else {
          items.push({ id: 'pr:hint', label: t('Projects belong to one team: select issues of a single team'), icon: ICON.warning });
        }
        break;
      }
      case 'sprint': {
        const current = values((i) => i.sprintId ?? null, () => draft!.sprintId);
        add({ id: 'sp:none', label: t('No sprint'), icon: ICON.sprint, checked: all(current, null) }, () => this.apply({ sprintId: null }, target));
        for (const sprint of (meta?.sprints ?? []).filter((s) => s.state !== 'closed').sort((a, b) => a.number - b.number)) {
          add({ id: `sp:${sprint._id}`, label: sprint.name, icon: ICON.sprint, checked: all(current, sprint._id as string | null), detail: sprintState(sprint.state) }, () => this.apply({ sprintId: sprint._id }, target));
        }
        break;
      }
      case 'estimate': {
        const current = values((i) => i.estimate ?? null, () => draft!.estimate);
        add({ id: 'e:none', label: t('No estimate'), icon: ICON.estimate, checked: all(current, null) }, () => this.apply({ estimate: null }, target));
        for (const n of ESTIMATES) add({ id: `e:${n}`, label: tn(n, '{count} point', '{count} points'), icon: ICON.estimate, checked: all(current, n as number | null), keywords: String(n) }, () => this.apply({ estimate: n }, target));
        break;
      }
      case 'due': {
        const current = values((i) => i.dueDate ?? null, () => draft!.dueDate);
        const now = today();
        const weekday = parseDay(now).getDay();
        const friday = addDays(now, ((5 - weekday + 7) % 7) || 7);
        const monday = addDays(now, ((1 - weekday + 7) % 7) || 7);
        // Ids stay German: they are stable item ids, not text.
        const options: [string, string, string][] = [
          ['heute', t('Today'), now],
          ['morgen', t('Tomorrow'), addDays(now, 1)],
          ['fr', t('End of week'), friday],
          ['mo', t('Next week'), monday],
          ['2w', t('In two weeks'), addDays(now, 14)],
        ];
        for (const [id, label, day] of options) add({ id: `d:${id}`, label, detail: dayLabel(day), icon: ICON.calendar, checked: all(current, day as string | null) }, () => this.apply({ dueDate: day }, target));
        add({ id: 'd:none', label: t('No due date'), icon: ICON.close, checked: all(current, null) }, () => this.apply({ dueDate: null }, target));
        break;
      }
      case 'snooze': {
        const current = values((i) => i.snoozedUntil ?? null, () => null);
        // The server counts days in Europe/Berlin.
        const now = berlinToday();
        const monday = addDays(now, ((1 - parseDay(now).getDay() + 7) % 7) || 7);
        const month = parseDay(now);
        month.setMonth(month.getMonth() + 1);
        const options: [string, string, string][] = [
          ['1', t('Tomorrow'), addDays(now, 1)],
          ['mo', t('Next week'), monday],
          ['2w', t('In two weeks'), addDays(now, 14)],
          ['1m', t('In a month'), dayOf(month)],
        ];
        const target_ = target.kind === 'issues' ? target.ids : [];
        for (const [id, label, day] of options) add({ id: `sn:${id}`, label, detail: dayLabel(day), icon: ICON.snooze, checked: all(current, day as string | null) }, () => this.app.edit.snooze(target_, day));
        // The calendar is part of the picker itself; in a context submenu this item opens it.
        if (!prefix && !inPicker) add({ id: 'sn:pick', label: t('Pick a date …'), icon: ICON.calendar }, () => this.open('snooze', { target, anchor: this.#anchor }));
        if (current.some((day) => day !== null)) add({ id: 'sn:none', label: t('Unsnooze'), icon: ICON.close }, () => this.app.edit.snooze(target_, null));
        break;
      }
      case 'team': {
        const current = draft ? draft.teamId : oneTeam;
        // Wiki-only teams take no issues.
        for (const team of [...(meta?.teams ?? [])].filter((x) => x.wiki !== 'only').sort((a, b) => Number(a.dormant) - Number(b.dormant))) {
          add({ id: `t:${team._id}`, label: team.name, detail: team.key, team: this.app.list.teamBadge(team._id), checked: current === team._id, keywords: team.key }, () => {
            if (target.kind === 'draft') this.app.create.update({ teamId: team._id });
            else this.requestMove(target.ids, team._id);
          });
        }
        break;
      }
      case 'parent': {
        add({ id: 'pa:none', label: t('No parent'), icon: ICON.close }, () => this.apply({ parentId: null }, target));
        break;
      }
      case 'repeat': {
        // Template from the issue: weekly on a weekday or monthly on a day (1–28).
        const id = target.kind === 'issues' && target.ids.length === 1 ? target.ids[0] : null;
        if (!id) break;
        const names = weekdayNames(intlLocale());
        // Keywords carry English and German day names in both languages (search data).
        const en = weekdayNames('en-US');
        const de = weekdayNames('de-DE');
        const weekly = t('Weekly');
        const monthly = t('Monthly');
        names.forEach((day, n) =>
          add({ id: `r:w${n + 1}`, label: t('Every week on {day}', { day }), icon: ICON.restore, keywords: `weekly wöchentlich ${en[n]} ${de[n]}`, section: weekly }, () => void import('./repeat.ts').then((m) => m.repeatIssue(this.app, id, 'weekly', n + 1))),
        );
        for (let d = 1; d <= 28; d++) add({ id: `r:m${d}`, label: t('Every month on day {day}', { day: d }), icon: ICON.restore, keywords: `monthly monatlich ${d}`, section: monthly }, () => void import('./repeat.ts').then((m) => m.repeatIssue(this.app, id, 'monthly', d)));
        break;
      }
      default:
        break;
    }
    return { items, run, multi, ...(hint ? { hint } : {}) };
  }

  /** Teams as in the sidebar: active, then dormant; the current one checked. */
  #switchTeamItems(): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    const current = this.app.currentTeam();
    for (const team of [...(this.app.store.meta.get()?.teams ?? [])].sort((a, b) => Number(a.dormant) - Number(b.dormant))) {
      const id = `st:${team._id}`;
      items.push({ id, label: team.name, detail: team.dormant ? t('{key} · dormant', { key: team.key }) : team.key, team: this.app.list.teamBadge(team._id), checked: team.key === current, keywords: team.key });
      run.set(id, () => this.app.switchTeam(team.key));
    }
    return { items, run, multi: false };
  }

  /** Priority budget exceeded: the team's candidates; picking one lowers it by one level. */
  openDowngrade(teamId: string, priority: 1 | 2) {
    this.#downgrade = { teamId, priority };
    this.open('downgrade', { target: { kind: 'issues', ids: [] } });
    const team = this.app.store.team(teamId);
    const s = this.state.get();
    if (s) this.state.set({ ...s, title: t('{team}: downgrade {priority}', { team: team?.name ?? t('Team'), priority: PRIORITY_LABEL[priority] }), targetLabel: team ? `${team.key} · ${PRIORITY_LABEL[priority]}` : null });
  }

  #downgradeItems(): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    const dg = this.#downgrade;
    if (!dg) return { items, run, multi: false };
    const lower = (dg.priority + 1) as Priority;
    const open = new Set<Status>(['triage', 'backlog', 'todo', 'in_progress', 'in_review']);
    const candidates = this.app.store
      .all()
      .filter((i) => i.teamId === dg.teamId && i.priority === dg.priority && open.has(i.status) && i.deletedAt === undefined && !i.pending)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const issue of candidates) {
      const id = `dg:${issue._id}`;
      items.push({ id, label: issue.title, detail: `${issue.key} → ${PRIORITY_LABEL[lower]}`, icon: PRIORITY_ICON[dg.priority], team: this.app.main.teamBadge(issue.teamId), preview: issue._id });
      run.set(id, () => this.app.edit.patch([issue._id], { priority: lower }, { label: t('Downgraded') }));
    }
    return { items, run, multi: false };
  }

  /** Accept from triage: pick a status (or another team) and mark as read at the same time. */
  #moveItems(): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    const target = this.#target;
    if (target.kind !== 'issues') return { items, run, multi: false };
    const issues = target.ids.map((id) => this.app.store.get(id)).filter((i): i is Issue => !!i);
    // Accept into a backlog, unstarted or started status of the teams (shared names).
    const acceptAs = t('Accept as');
    const workflows = workflowsOf(this.app.store.meta.get());
    const teams = [...new Set(issues.map((i) => i.teamId as string))];
    const accept = workflows
      .groups(teams)
      .filter((g) => (g.type === 'backlog' || g.type === 'unstarted' || g.type === 'started') && teams.every((t) => g.byTeam.has(t)))
      // Fixed order: only what is allowed from the current status (triage).
      .filter((g) => issues.every((i) => {
        const allowed = workflows.allowed(i.teamId, i.stateId ?? null);
        return !allowed || allowed.has(g.byTeam.get(i.teamId)!);
      }));
    for (const g of accept) {
      const id = `mv:${g.key}`;
      items.push({ id, label: g.name, icon: statusIcon(g.status, g.color), keywords: stateKeywords(g), section: acceptAs });
      run.set(id, () => {
        this.app.edit.setState(target.ids, (issue) => g.byTeam.get(issue.teamId) as StateId | undefined, { label: t('Accepted') });
        this.app.edit.markRead(target.ids);
      });
    }
    // Accept into another team (status backlog).
    const otherTeam = t('Into another team');
    for (const team of (this.app.store.meta.get()?.teams ?? []).filter((t) => !t.dormant && t.wiki !== 'only' && !issues.every((i) => i.teamId === t._id))) {
      items.push({ id: `mt:${team._id}`, label: t('Accept into {team}', { team: team.name }), detail: team.key, team: this.app.list.teamBadge(team._id), keywords: `team ${team.key}`, section: otherTeam });
      run.set(`mt:${team._id}`, () => {
        this.app.edit.patch(target.ids, { status: 'backlog' }, { label: t('Accepted'), quiet: true });
        this.app.edit.moveTeam(target.ids, team._id);
        this.app.edit.markRead(target.ids);
      });
    }
    return { items, run, multi: false };
  }

  // ---------------------------------------------------------------- Command menu

  #available(action: Action) {
    return !action.when || action.when(this.app);
  }

  #actionItem(action: Action): MenuItem {
    return { id: `a:${action.id}`, label: action.label, shortcut: action.keys ? formatShortcut(action.keys[0]) : undefined, keywords: action.keywords, icon: action.icon ? ICON[action.icon] : undefined, section: SECTION_LABEL[action.section], submenu: false };
  }

  #commandTop(): MenuItem[] {
    return this.#base.filter((i) => i.id.startsWith('a:') && actionById(i.id.slice(2))?.top);
  }

  #commandItems(): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    for (const action of ACTIONS) {
      if (action.id === 'palette.open' || action.hidden || !this.#available(action)) continue;
      const item = this.#actionItem(action);
      items.push(item);
      run.set(item.id, () => action.run(this.app));
    }
    // Second level: values directly ("Status: In progress"), acting on the selection or focus.
    if (this.#target.kind === 'issues' && this.#target.ids.length > 0) {
      const second: [PaletteKind, string][] = [
        ['status', t('Status')],
        ['priority', t('Priority')],
        ['labels', t('Label')],
        ['project', t('Project')],
        ['sprint', t('Sprint')],
        ['estimate', t('Estimate')],
        ['due', t('Due date')],
        ['snooze', t('Snooze')],
      ];
      for (const [kind, field] of second) {
        const set = this.pickerItems(kind, this.#target, `${field}: `);
        for (const item of set.items) {
          if (item.id.endsWith(':hint')) continue;
          const id = `v:${item.id}`;
          items.push({ ...item, id, shortcut: undefined, checkbox: false, section: undefined });
          const fn = set.run.get(item.id);
          if (fn) run.set(id, () => void fn());
        }
      }
    }
    // Navigation to teams and views
    for (const team of this.app.store.meta.get()?.teams ?? []) {
      const id = `t:${team.key}`;
      items.push({ id, label: t('Go to team: {team}', { team: team.name }), detail: team.key, keywords: team.key, team: this.app.list.teamBadge(team._id) });
      run.set(id, () => this.app.nav.goView({ kind: 'active', team: team.key }));
    }
    return { items, run, multi: false };
  }

  #helpItems(): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    for (const action of ACTIONS) {
      if (!action.keys || action.hidden) continue;
      const item = { ...this.#actionItem(action), shortcut: action.keys.map(formatShortcut).join(' / ') };
      items.push(item);
      run.set(item.id, () => {
        if (this.#available(action)) action.run(this.app);
      });
    }
    // Fixed shortcuts inside dialogs
    const fixed: [string, string][] = [
      [msg('Create (in dialog)'), 'mod+enter'],
      [msg('Create and add another'), 'mod+shift+enter'],
      [msg('Send comment'), 'mod+enter'],
      [msg('Close, clear selection'), 'escape'],
    ];
    const dialogs = t('Dialogs');
    for (const [label, key] of fixed) items.push({ id: `fx:${label}`, label: t(label), shortcut: formatShortcut(key), section: dialogs });
    return { items, run, multi: false };
  }

  // ---------------------------------------------------------------- Filter

  #filterTop(): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    const filters = this.app.list.view.get().filters;
    for (const field of FILTER_FIELDS) {
      const count = (filters[field.id] as unknown[]).length;
      const label = t(field.label);
      items.push({ id: `ff:${field.id}`, label, icon: field.icon, submenu: true, detail: count ? tn(count, '{count} selected', '{count} selected') : undefined });
      run.set(`ff:${field.id}`, () => {
        this.#filterField = field.id;
        const set = this.#filterValues(field.id);
        this.#base = set.items;
        for (const [id, fn] of set.run) this.#run.set(id, fn);
        const s = this.state.get();
        if (s) this.state.set({ ...s, query: '', items: set.items, active: 0, parent: label, multi: true });
        return 'stay';
      });
    }
    items.push({ id: 'ff:unreviewed', label: t('Unread (in inbox)'), icon: ICON.agent, checkbox: true, checked: filters.unreviewed });
    run.set('ff:unreviewed', () => this.app.list.toggleUnreviewed());
    items.push({ id: 'ff:snoozed', label: t('Include snoozed'), icon: ICON.snooze, checkbox: true, checked: filters.snoozed });
    run.set('ff:snoozed', () => this.app.list.toggleSnoozed());
    return { items, run, multi: false };
  }

  /** Values for the filter; `field = null` = all properties, flat, with a prefix. */
  #filterValues(field: FilterField | null): ItemSet {
    const run = new Map<string, Run>();
    const items: MenuItem[] = [];
    const list = this.app.list;
    const f = list.view.get().filters;
    const meta = this.app.store.meta.get();
    const flat = field === null;
    const pre = (label: string) => (flat ? `${t(label)}: ` : '');
    const add = (item: MenuItem, fn: Run) => {
      items.push({ ...item, checkbox: true });
      run.set(item.id, fn);
    };
    if (flat || field === 'status') {
      // Statuses of all teams in the view (merged by name across teams).
      const route = list.view.get().route;
      const team = route.team ? meta?.teams.find((t) => t.key === route.team) : undefined;
      for (const g of workflowsOf(meta).groups(team ? [team._id] : undefined)) {
        const value = statusFilterValue(g);
        add({ id: `fs:${g.key}`, label: `${pre(msg('Status'))}${g.name}`, icon: statusIcon(g.status, g.color), checked: f.status.includes(value), keywords: stateKeywords(g) }, () => list.toggleFilter('status', value));
      }
    }
    if (flat || field === 'priority') for (const p of PRIORITY_ORDER) add({ id: `fp:${p}`, label: `${pre(msg('Priority'))}${PRIORITY_LABEL[p]}`, icon: PRIORITY_ICON[p], checked: f.priority.includes(p as Priority), keywords: `prio ${PRIORITY_KEYWORDS[p]}` }, () => list.toggleFilter('priority', p));
    if (flat || field === 'team') for (const tm of meta?.teams ?? []) add({ id: `ft:${tm.key}`, label: `${pre(msg('Team'))}${tm.name}`, detail: tm.key, team: list.teamBadge(tm._id), checked: f.team.includes(tm.key), keywords: tm.key }, () => list.toggleFilter('team', tm.key));
    if (flat || field === 'label') for (const l of meta?.labels ?? []) add({ id: `fl:${l._id}`, label: `${pre(msg('Label'))}${l.name}`, dot: l.hue, checked: f.label.includes(l._id) }, () => list.toggleFilter('label', l._id));
    if (flat || field === 'project') {
      add({ id: 'fpr:none', label: `${pre(msg('Project'))}${t('No project')}`, icon: ICON.projects, checked: f.project.includes('none') }, () => list.toggleFilter('project', 'none'));
      for (const p of meta?.projects ?? []) add({ id: `fpr:${p._id}`, label: `${pre(msg('Project'))}${p.name}`, icon: ICON.projects, checked: f.project.includes(p._id) }, () => list.toggleFilter('project', p._id));
    }
    if (flat || field === 'sprint') {
      add({ id: 'fsp:none', label: `${pre(msg('Sprint'))}${t('No sprint')}`, icon: ICON.sprint, checked: f.sprint.includes('none') }, () => list.toggleFilter('sprint', 'none'));
      for (const s of meta?.sprints ?? []) add({ id: `fsp:${s._id}`, label: `${pre(msg('Sprint'))}${s.name}`, icon: ICON.sprint, detail: sprintState(s.state), checked: f.sprint.includes(s._id) }, () => list.toggleFilter('sprint', s._id));
    }
    return { items, run, multi: !flat };
  }

  // ---------------------------------------------------------------- Issue search

  pushRecent(id: IssueId) {
    this.#recent = [id, ...this.#recent.filter((r) => r !== id)].slice(0, 12);
    try {
      globalThis.localStorage?.setItem(RECENT, JSON.stringify(this.#recent));
    } catch {
      // ignore (storage full or blocked)
    }
  }

  recent(): Issue[] {
    return this.#recent.map((id) => this.app.store.get(id)).filter((i): i is Issue => !!i && i.deletedAt === undefined);
  }

  #issueItem(issue: Issue, prefix = 'i'): MenuItem {
    const state = workflowsOf(this.app.store.meta.get()).of(issue);
    return { id: `${prefix}:${issue._id}`, label: issue.title, detail: issue.key, icon: statusIcon(state.status, state.color), team: this.app.list.teamBadge(issue.teamId), preview: issue._id };
  }

  #issueItems(kind: PaletteKind, query: string): MenuItem[] {
    const store = this.app.store;
    this.#search.prepare(store.version.get(), store.all());
    // Pickers leave out the issue they act on; search and the command menu find every issue (also the focused one).
    const exclude = new Set(this.#target.kind === 'issues' && kind !== 'search' && kind !== 'command' ? this.#target.ids : []);
    const hits = query ? this.#search.search(query, MAX_ITEMS) : kind === 'search' ? this.recent() : this.recent().filter((i) => !exclude.has(i._id));
    const items: MenuItem[] = [];
    // "No parent" on top only without a query; with a query the first hit is active (Enter sets it).
    const none: MenuItem = { id: 'pa:none', label: t('No parent'), icon: ICON.close, keywords: 'remove none entfernen ohne' };
    if (kind === 'parent') this.#run.set('pa:none', () => this.apply({ parentId: null }));
    if (kind === 'parent' && !query) items.push(none);
    const seen = new Set<IssueId>();
    const push = (issue: Issue, section?: string) => {
      if (exclude.has(issue._id) || seen.has(issue._id)) return;
      seen.add(issue._id);
      const item = this.#issueItem(issue);
      if (section) item.section = section;
      items.push(item);
      this.#run.set(item.id, () => this.#chooseIssue(kind, issue._id));
    };
    // Without a query: for duplicate/relation, similar titles first, then recently opened.
    if (!query && (kind === 'duplicate' || kind === 'relation') && this.#target.kind === 'issues' && this.#target.ids.length === 1) {
      const source = store.get(this.#target.ids[0]);
      if (source) {
        const similar = t('Similar titles');
        for (const issue of this.#search.similar(source, 8)) push(issue, similar);
      }
    }
    const recentSection = !query && kind !== 'command' ? t('Recently opened') : undefined;
    for (const issue of hits) push(issue, recentSection);
    if (kind === 'parent' && query && scoreText(`${none.label} ${none.keywords}`, query) > 0) items.push(none);
    return items;
  }

  #chooseIssue(kind: PaletteKind, id: IssueId) {
    const target = this.#target;
    if (kind === 'search' || kind === 'command') return this.app.openIssue(id);
    if (kind === 'parent') return this.apply({ parentId: id }, target);
    if (target.kind !== 'issues') return;
    // No fallback to "duplicate of": without a known type nothing is created.
    const relation = kind === 'duplicate' ? { type: 'duplicate' as const, reverse: false, markDuplicate: true } : this.#relation;
    if (!relation) return;
    const items = target.ids.map((source) => {
      const [from, to] = relation.reverse ? [id, source] : [source, id];
      return { from, to, type: relation.type };
    });
    // Through the editor: undo removes the relation (and resets the status for a duplicate).
    this.app.edit.addRelations(items, { markDuplicate: relation.markDuplicate && !relation.reverse });
    if (kind === 'duplicate') this.app.edit.markRead(target.ids);
  }

  /** Create a relation: remember the type, then pick an issue. */
  openRelation(type: 'blocks' | 'related' | 'duplicate', reverse = false) {
    this.open(type === 'duplicate' ? 'duplicate' : 'relation');
    this.#relation = { type, reverse, markDuplicate: type === 'duplicate' };
    const s = this.state.get();
    const titles: Record<string, string> = { 'blocks:false': msg('Blocks …'), 'blocks:true': msg('Blocked by …'), 'related:false': msg('Related to …'), 'duplicate:false': msg('Duplicate of …') };
    const title = titles[`${type}:${reverse}`];
    if (s) this.state.set({ ...s, title: title ? t(title) : s.title });
  }

  #articlePick: ((page: { id: string; title: string }) => void) | null = null;

  /** Pick a wiki page (link in the text): `onPick` gets id and title, Esc cancels. */
  pickArticle(onPick: (page: { id: string; title: string }) => void) {
    this.open('article');
    this.#articlePick = onPick;
  }

  #scheduleArticles(query: string) {
    if (this.#serverTimer) clearTimeout(this.#serverTimer);
    const seq = ++this.#serverSeq;
    if (query.length < 2) return;
    this.#serverTimer = setTimeout(async () => {
      let hits: Awaited<ReturnType<typeof this.app.store.searchWiki>> = [];
      try {
        hits = await this.app.store.searchWiki(query, 20);
      } catch {
        return;
      }
      const s = this.state.get();
      if (!s || s.kind !== 'article' || seq !== this.#serverSeq) return;
      const run = new Map<string, Run>();
      const items: MenuItem[] = hits.map((hit) => {
        const id = `w:${hit.id}`;
        run.set(id, () => this.#articlePick?.({ id: hit.id, title: hit.title }));
        return { id, label: hit.title, detail: this.app.store.team(hit.teamId)?.key, icon: ICON.page, snippet: hit.snippet };
      });
      this.#run = run;
      this.state.set({ ...s, items, active: 0, hint: items.length ? null : t('No page found') });
    }, 120);
  }

  /** The server adds full-text hits and old IDs; local hits show immediately. */
  #scheduleServer(query: string) {
    if (this.#serverTimer) clearTimeout(this.#serverTimer);
    const seq = ++this.#serverSeq;
    if (query.length < 2) return;
    this.#serverTimer = setTimeout(async () => {
      const store = this.app.store;
      const add: MenuItem[] = [];
      const wiki: MenuItem[] = [];
      // Wiki search in parallel to the issue search, only if a team has a wiki.
      const wikiSearch = store.meta.get()?.teams.some((x) => x.wiki) ? store.searchWiki(query, 8).catch(() => []) : Promise.resolve([]);
      try {
        if (looksLikeIdentifier(query) && !this.#search.exact(query)) {
          const hit = await store.resolve(query);
          const issue = hit ? store.get(hit.id) : undefined;
          if (issue && issue.deletedAt === undefined) add.push({ ...this.#issueItem(issue), detail: t('{key} · formerly {old}', { key: issue.key, old: query.toUpperCase() }) });
        }
        if (query.length >= 3) {
          for (const hit of await store.searchText(query, 20)) {
            if (hit.match === 'title') continue;
            const issue = store.get(hit.id);
            if (!issue) continue;
            add.push({ ...this.#issueItem(issue, 'f'), snippet: hit.snippet, section: hit.match === 'description' ? t('In descriptions') : t('In comments') });
          }
        }
        for (const hit of await wikiSearch) {
          const team = store.team(hit.teamId);
          wiki.push({ id: `w:${hit.id}`, label: hit.title, detail: team?.key, icon: ICON.page, snippet: hit.snippet, section: SECTION_LABEL.Wiki, keywords: 'wiki page wissen seite' });
        }
      } catch {
        return; // server unreachable: local hits are enough
      }
      const s = this.state.get();
      if (!s || s.kind !== 'search' || seq !== this.#serverSeq || (add.length === 0 && wiki.length === 0)) return;
      const present = new Set(s.items.map((i) => i.preview).filter(Boolean));
      const fresh = add.filter((i) => !present.has(i.preview));
      for (const item of fresh) this.#run.set(item.id, () => this.app.openIssue(item.preview!));
      for (const item of wiki) this.#run.set(item.id, () => this.app.nav.go({ name: 'article', id: item.id.slice(2) }));
      const ids = fresh.filter((i) => i.id.startsWith('i:'));
      const text = fresh.filter((i) => i.id.startsWith('f:'));
      this.state.set({ ...s, items: [...ids, ...s.items, ...text, ...wiki].slice(0, MAX_ITEMS + 30), active: ids.length ? 0 : s.active });
    }, 160);
  }

  // ---------------------------------------------------------------- Calendar (due date)

  #calendar(kind: PaletteKind): PaletteState['calendar'] {
    let selected: string | null = null;
    if (this.#target.kind === 'draft') selected = this.app.create.state.get().draft.dueDate;
    else {
      const days = this.#target.ids.map((id) => (kind === 'snooze' ? this.app.store.get(id)?.snoozedUntil : this.app.store.get(id)?.dueDate) ?? null);
      selected = days.length && days.every((d) => d === days[0]) ? days[0] : null;
    }
    const month = this.#calendarMonth ?? (selected ?? today()).slice(0, 7);
    return kind === 'snooze' ? { month, selected, min: addDays(berlinToday(), 1) } : { month, selected };
  }

  shiftMonth(delta: number) {
    const s = this.state.get();
    if (!s?.calendar) return;
    const [y, m] = s.calendar.month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.#calendarMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    this.state.set({ ...s, calendar: this.#calendar(s.kind) });
  }

  pickDay(day: string) {
    const target = this.#target;
    const snooze = this.state.get()?.kind === 'snooze';
    if (snooze && day <= berlinToday()) return;
    this.close();
    if (snooze) this.app.edit.snooze(target.kind === 'issues' ? target.ids : [], day);
    else this.apply({ dueDate: day }, target);
  }

  #snoozeIds() {
    return this.#target.kind === 'issues' ? this.#target.ids : [];
  }
}

function projectState(state: string) {
  switch (state) {
    case 'planned':
      return tc('project state', 'planned');
    case 'paused':
      return tc('project state', 'paused');
    case 'done':
      return tc('project state', 'done');
    case 'canceled':
      return tc('project state', 'canceled');
    default:
      return state;
  }
}

function sprintState(state: string) {
  if (state === 'active') return tc('sprint state', 'active');
  if (state === 'planning') return tc('sprint state', 'planning');
  return tc('sprint state', 'completed');
}

/** Sorts items by match quality; items without a match are dropped. */
export function rank(items: MenuItem[], query: string): MenuItem[] {
  return items
    .map((item, order) => ({ item, order, score: scoreText(`${item.label} ${item.keywords ?? ''} ${item.detail ?? ''}`, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((s) => s.item);
}

/** Search words of a status: its type, for standard statuses also the English names ("prog" → In progress). */
function stateKeywords(g: StateGroup) {
  return `${STATE_TYPE_LABEL[g.type].toLowerCase()} ${g.type}${g.standard ? ` ${STATUS_KEYWORDS[g.status]}` : ''}`;
}
