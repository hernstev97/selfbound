// Roadmap page of a team (/team/KEY/roadmap, SELF-113): release view and progress tracker. Its own
// chunk (app.loadRoadmap). The issues come from the store; this holds the public cards of the team
// (`roadmap.cards`) while the page is open, the filters and the folded categories per team (in the
// browser), the keyboard focus, and computes both views and the data of the image export
// (core/src/roadmap.ts).
import { api } from '@selfbound/backend/api';
import { msg, t } from '../i18n.ts';
import { Slice } from '../observable.ts';
import {
  computeAxis,
  computeProgress,
  computeRelease,
  dayOf,
  exportProgress,
  exportRoadmap,
  NO_FILTERS,
  ZOOM_DAYS,
  ZOOMS,
  type Axis,
  type ExportColumn,
  type ExportOptions,
  type ExportRow,
  type ProgressRow,
  type ProgressRows,
  type PublicCard,
  type ReleaseView,
  type RoadmapFilters,
  type RoadmapInput,
  type Stage,
  type Zoom,
} from '../roadmap.ts';
import type { Page, RoadmapTab } from '../route.ts';
import type { IssueId, TeamDoc } from '../types.ts';
import type { App } from './index.ts';
import { registerAction } from './actions.ts';

export interface RoadmapUi {
  /** Team key of the page; null = not on a roadmap page */
  team: string | null;
  tab: RoadmapTab;
  filters: RoadmapFilters;
  /** Folded categories: `<projectId>:<categoryKey>` */
  collapsed: string[];
  rows: ProgressRows;
  zoom: Zoom;
  /** Unfolded progress rows (their issues show) */
  expanded: string[];
  /** Card (issue id) or progress row/issue with the keyboard focus */
  focus: string | null;
  /** Public cards have arrived */
  loaded: boolean;
}

export interface ProgressView {
  rows: ProgressRow[];
  axis: Axis;
}

/** What the export dialog draws: branding plus the public-only data. */
export interface ExportData {
  title: string;
  subtitle: string | null;
  accent: string;
  /** Team logo for light and dark ground; null = none */
  logo: { light: string | null; dark: string | null };
  teamHue: number;
  columns: ExportColumn[];
  rows: ExportRow[];
  axis: Axis | null;
}

interface Saved {
  filters?: Partial<RoadmapFilters>;
  collapsed?: string[];
  rows?: ProgressRows;
  zoom?: Zoom;
}

const storageKey = (team: string) => `selfbound:roadmap:${team}`;

const INITIAL: RoadmapUi = { team: null, tab: 'release', filters: NO_FILTERS, collapsed: [], rows: 'projects', zoom: 'half', expanded: [], focus: null, loaded: false };

/** OKLCH hue → a hex color for the export accent when the team sets none (canvas needs sRGB). */
export function hueColor(hue: number): string {
  // OKLCH(0.62 0.14 h) → linear sRGB → sRGB, clamped.
  const L = 0.62;
  const C = 0.14;
  const h = (hue * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const hex = rgb.map((v) => {
    const c = Math.max(0, Math.min(1, v));
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  });
  return `#${hex.join('')}`;
}

export class RoadmapController {
  readonly ui = new Slice<RoadmapUi>(INITIAL);
  readonly release = new Slice<ReleaseView | null>(null);
  readonly progress = new Slice<ProgressView | null>(null);
  #cards = new Map<string, PublicCard>();
  #watch: { teamId: string; release: () => void; stop: () => void } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App) {}

  // ---------------------------------------------------------------- Page

  /** Called by the app after every page change. The issue page opened from here keeps the data. */
  onPage(page: Page) {
    if (page.name === 'roadmap') this.#enter(page.team, page.tab);
    else if (page.name !== 'issue') this.#leave();
  }

  team(): TeamDoc | null {
    const key = this.ui.get().team;
    return this.app.store.meta.get()?.teams.find((t) => t.key === key) ?? null;
  }

  #enter(key: string, tab: RoadmapTab) {
    const ui = this.ui.get();
    if (ui.team !== key) {
      const saved = this.#read(key);
      this.ui.set({
        ...INITIAL,
        team: key,
        tab,
        filters: { ...NO_FILTERS, ...saved.filters },
        collapsed: saved.collapsed ?? [],
        rows: saved.rows ?? 'projects',
        zoom: saved.zoom && ZOOMS.includes(saved.zoom) ? saved.zoom : 'half',
      });
    } else if (ui.tab !== tab) this.ui.set({ ...ui, tab, focus: null });
    this.#subscribe();
    this.#recompute();
  }

  #leave() {
    this.#stopWatch();
    this.exportOpen.set(false);
    if (this.ui.get().team !== null) this.ui.set(INITIAL);
    this.release.set(null);
    this.progress.set(null);
  }

  #subscribe() {
    const team = this.team();
    if (!team || this.#watch?.teamId === team._id) return;
    this.#stopWatch();
    this.#cards = new Map();
    const { slice, release } = this.app.store.watch(api.roadmap.cards, { teamId: team._id });
    const update = () => {
      const rows = slice.get();
      if (!rows) return;
      this.#cards = new Map(rows.map((r) => [r.issueId as string, { title: r.title, summary: r.summary, image: r.image }]));
      if (!this.ui.get().loaded) this.ui.set({ ...this.ui.get(), loaded: true });
      this.#recompute();
    };
    const stop = slice.subscribe(update);
    this.#watch = { teamId: team._id, release, stop };
    update();
  }

  #stopWatch() {
    if (!this.#watch) return;
    this.#watch.stop();
    this.#watch.release();
    this.#watch = null;
  }

  /** Issues changed: recompute once for the batch if one of them is in this team. */
  onIssues(ids: ReadonlySet<IssueId>) {
    const team = this.team();
    if (!team || this.app.nav.page.get().name !== 'roadmap') return;
    for (const id of ids) {
      const issue = this.app.store.get(id);
      if (!issue || issue.teamId === team._id) return this.#schedule();
    }
  }

  onMeta() {
    if (this.ui.get().team === null) return;
    this.#subscribe();
    this.#schedule();
  }

  #schedule() {
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      this.#recompute();
    }, 0);
  }

  #input(): RoadmapInput | null {
    const meta = this.app.store.meta.get();
    const team = this.team();
    if (!meta || !team) return null;
    return { meta, team, issues: this.app.store.all(), cards: this.#cards };
  }

  #recompute() {
    const input = this.#input();
    const ui = this.ui.get();
    if (!input) {
      this.release.set(null);
      this.progress.set(null);
      return;
    }
    const none = t('No category');
    this.release.set(computeRelease(input, ui.filters, none));
    const rows = computeProgress(input, ui.filters, ui.rows, none);
    this.progress.set({ rows, axis: computeAxis(rows, dayOf(Date.now()), ZOOM_DAYS[ui.zoom]) });
    // A focused card that went away (filter, moved): no focus.
    if (ui.focus && !this.#order().includes(ui.focus)) this.ui.set({ ...this.ui.get(), focus: null });
  }

  // ---------------------------------------------------------------- Settings of the view

  #read(team: string): Saved {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(storageKey(team)) ?? '{}') as Saved;
    } catch {
      return {};
    }
  }

  #save() {
    const ui = this.ui.get();
    if (!ui.team) return;
    const saved: Saved = { filters: ui.filters, collapsed: ui.collapsed, rows: ui.rows, zoom: ui.zoom };
    try {
      globalThis.localStorage?.setItem(storageKey(ui.team), JSON.stringify(saved));
    } catch {
      // Storage full or blocked: the view works, it is just not remembered.
    }
  }

  #update(patch: Partial<RoadmapUi>, recompute = true) {
    this.ui.set({ ...this.ui.get(), ...patch });
    this.#save();
    if (recompute) this.#recompute();
  }

  setTab(tab: RoadmapTab) {
    const team = this.ui.get().team;
    if (team) this.app.nav.go({ name: 'roadmap', team, tab }, { replace: true });
  }

  setFilters(patch: Partial<RoadmapFilters>) {
    this.#update({ filters: { ...this.ui.get().filters, ...patch } });
  }

  togglePublicOnly() {
    this.setFilters({ publicOnly: !this.ui.get().filters.publicOnly });
  }

  toggleCategoryFilter(key: string) {
    const list = this.ui.get().filters.categories;
    this.setFilters({ categories: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] });
  }

  toggleStageFilter(stage: Stage) {
    const list = this.ui.get().filters.stages;
    this.setFilters({ stages: list.includes(stage) ? list.filter((s) => s !== stage) : [...list, stage] });
  }

  clearFilters() {
    this.setFilters({ ...NO_FILTERS, publicOnly: this.ui.get().filters.publicOnly });
  }

  // ---------------------------------------------------------------- Folding (release view)

  isCollapsed(projectId: string, category: string) {
    return this.ui.get().collapsed.includes(`${projectId}:${category}`);
  }

  toggleCategory(projectId: string, category: string) {
    const key = `${projectId}:${category}`;
    const list = this.ui.get().collapsed;
    this.#update({ collapsed: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] }, false);
    this.#dropHiddenFocus();
  }

  /** Every category of every column, folded or unfolded at once. */
  allKeys() {
    return (this.release.get()?.columns ?? []).flatMap((c) => c.groups.map((g) => `${c.id}:${g.key}`));
  }

  allCollapsed() {
    const keys = this.allKeys();
    const collapsed = new Set(this.ui.get().collapsed);
    return keys.length > 0 && keys.every((k) => collapsed.has(k));
  }

  setAllCollapsed(collapsed: boolean) {
    this.#update({ collapsed: collapsed ? this.allKeys() : [] }, false);
    this.#dropHiddenFocus();
  }

  toggleAll() {
    if (this.ui.get().tab === 'progress') return this.setAllExpanded(this.ui.get().expanded.length === 0);
    this.setAllCollapsed(!this.allCollapsed());
  }

  // ---------------------------------------------------------------- Progress view

  setRows(rows: ProgressRows) {
    this.#update({ rows, expanded: [], focus: null });
  }

  setZoom(zoom: Zoom) {
    this.#update({ zoom });
  }

  zoomBy(step: 1 | -1) {
    const i = ZOOMS.indexOf(this.ui.get().zoom);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + step))]!;
    if (next !== this.ui.get().zoom) this.setZoom(next);
  }

  /** The image export dialog is open. */
  readonly exportOpen = new Slice(false);

  /** Asks the progress view to scroll to today (the view listens). */
  readonly jumpToday = new Slice(0);
  today() {
    this.jumpToday.set(this.jumpToday.get() + 1);
  }

  toggleRow(key: string) {
    const list = this.ui.get().expanded;
    this.#update({ expanded: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] }, false);
    this.#dropHiddenFocus();
  }

  setAllExpanded(expanded: boolean) {
    this.#update({ expanded: expanded ? (this.progress.get()?.rows ?? []).map((r) => r.key) : [] }, false);
    this.#dropHiddenFocus();
  }

  // ---------------------------------------------------------------- Keyboard focus

  focusId(): IssueId | null {
    const focus = this.ui.get().focus;
    return focus && this.app.store.get(focus as IssueId) ? (focus as IssueId) : null;
  }

  /** Focusable things in reading order: release = cards column by column; progress = rows and their unfolded issues. */
  #order(): string[] {
    const ui = this.ui.get();
    if (ui.tab === 'release') return this.#columns().flat();
    const out: string[] = [];
    for (const row of this.progress.get()?.rows ?? []) {
      out.push(`row:${row.key}`);
      if (ui.expanded.includes(row.key)) out.push(...row.issues.map((i) => i.id as string));
    }
    return out;
  }

  /** Visible cards per column (folded categories left out). */
  #columns(): string[][] {
    const collapsed = new Set(this.ui.get().collapsed);
    return (this.release.get()?.columns ?? []).map((c) => c.groups.filter((g) => !collapsed.has(`${c.id}:${g.key}`)).flatMap((g) => g.cards.map((card) => card.id as string)));
  }

  #dropHiddenFocus() {
    const focus = this.ui.get().focus;
    if (focus && !this.#order().includes(focus)) this.ui.set({ ...this.ui.get(), focus: null });
  }

  /** `follow`: the issue beside the page follows the focus (J/K, ←/→), as in a split list. */
  focus(id: string | null, follow = false) {
    if (this.ui.get().focus !== id) this.ui.set({ ...this.ui.get(), focus: id });
    if (follow && id && this.app.detail.besideShown() && this.app.store.get(id as IssueId)) this.app.detail.showBeside(id as IssueId);
  }

  /** J/K: next or previous card in the column (release) or row (progress). */
  step(delta: 1 | -1) {
    this.app.cues.emit('tap');
    const ui = this.ui.get();
    if (ui.tab === 'release') {
      const columns = this.#columns();
      const at = columns.findIndex((c) => ui.focus !== null && c.includes(ui.focus));
      if (at < 0) {
        const first = columns.find((c) => c.length > 0);
        return this.focus(first ? (delta > 0 ? first[0]! : first.at(-1)!) : null, true);
      }
      const col = columns[at]!;
      const i = col.indexOf(ui.focus!);
      return this.focus(col[Math.max(0, Math.min(col.length - 1, i + delta))]!, true);
    }
    const order = this.#order();
    const i = ui.focus ? order.indexOf(ui.focus) : -1;
    const next = i < 0 ? (delta > 0 ? order[0] : order.at(-1)) : order[Math.max(0, Math.min(order.length - 1, i + delta))];
    this.focus(next ?? null, true);
  }

  /** ←/→ in the release view: the card at the same height in the next column with cards. */
  stepColumn(delta: 1 | -1) {
    const ui = this.ui.get();
    if (ui.tab !== 'release') return;
    this.app.cues.emit('tap');
    const columns = this.#columns();
    let at = columns.findIndex((c) => ui.focus !== null && c.includes(ui.focus));
    const row = at < 0 ? 0 : columns[at]!.indexOf(ui.focus!);
    for (let i = at + delta; i >= 0 && i < columns.length; i += delta) {
      if (columns[i]!.length === 0) continue;
      at = i;
      return this.focus(columns[i]![Math.min(row, columns[i]!.length - 1)]!, true);
    }
  }

  /** Enter: open the focused card (or unfold the focused progress row). */
  activate() {
    const focus = this.ui.get().focus;
    if (!focus) return;
    if (focus.startsWith('row:')) return this.toggleRow(focus.slice(4));
    this.open(focus as IssueId);
  }

  /**
   * Opens an issue: beside the roadmap in a wide window, as its own page otherwise. Clicking the
   * card that is already beside closes it (`toggle`); Enter on it opens its page.
   */
  open(id: IssueId, opts: { toggle?: boolean } = {}) {
    this.focus(id);
    const wide = this.app.wide.get() && !this.app.mobile.get();
    if (!wide) return this.app.openIssue(id);
    if (this.app.detail.beside.get() === id) return opts.toggle ? this.app.detail.showBeside(null) : this.app.openIssue(id);
    this.app.detail.showBeside(id);
  }

  // ---------------------------------------------------------------- Export

  /** Branding and the public-only data for the image export. */
  exportData(options: ExportOptions): ExportData | null {
    const input = this.#input();
    if (!input) return null;
    const { team } = input;
    const none = t('No category');
    const rows = exportProgress(input, options, this.ui.get().rows, none);
    // The axis is built from the exported rows only, so its span says nothing about other issues.
    const axis = rows.length ? computeAxis(rows, dayOf(Date.now()), ZOOM_DAYS[this.ui.get().zoom]) : null;
    return {
      title: team.roadmap?.title ?? team.name,
      subtitle: team.roadmap?.subtitle ?? null,
      accent: team.roadmap?.accent ?? hueColor(team.hue),
      logo: { light: team.logoUrl ?? team.logoDarkUrl, dark: team.logoDarkUrl ?? team.logoUrl },
      teamHue: team.hue,
      columns: exportRoadmap(input, options, none),
      rows,
      axis,
    };
  }
}

// ---------------------------------------------------------------- Roadmap page keyboard
// Registered only with this chunk (extension point registerAction), like the sprint pages: they work
// only on the roadmap page, where the chunk is always loaded. "Go to: Roadmap" and the public switch
// stay in actions.ts (available everywhere).

const roadmapPage = (a: App) => a.nav.page.get().name === 'roadmap' && !!a.roadmapLoaded();
const roadmapTab = (a: App, tab: RoadmapTab) => roadmapPage(a) && a.roadmap.ui.get().tab === tab;
for (const action of [
  { id: 'roadmap.down', label: msg('Next card'), section: 'Roadmap', keys: ['j', 'arrowdown'], hidden: true, when: roadmapPage, run: (a) => a.roadmap.step(1) },
  { id: 'roadmap.up', label: msg('Previous card'), section: 'Roadmap', keys: ['k', 'arrowup'], hidden: true, when: roadmapPage, run: (a) => a.roadmap.step(-1) },
  { id: 'roadmap.left', label: msg('Column left'), section: 'Roadmap', keys: ['arrowleft'], hidden: true, when: (a) => roadmapTab(a, 'release'), run: (a) => a.roadmap.stepColumn(-1) },
  { id: 'roadmap.right', label: msg('Column right'), section: 'Roadmap', keys: ['arrowright'], hidden: true, when: (a) => roadmapTab(a, 'release'), run: (a) => a.roadmap.stepColumn(1) },
  { id: 'roadmap.open', label: msg('Open card'), section: 'Roadmap', keys: ['enter'], hidden: true, when: (a) => roadmapPage(a) && a.roadmap.ui.get().focus !== null, run: (a) => a.roadmap.activate() },
  { id: 'roadmap.release', label: msg('Roadmap: release view'), section: 'Roadmap', keys: ['1'], icon: 'roadmap', keywords: 'roadmap release columns spalten etappen', when: roadmapPage, run: (a) => a.roadmap.setTab('release') },
  { id: 'roadmap.progress', label: msg('Roadmap: progress'), section: 'Roadmap', keys: ['2'], icon: 'progress', keywords: 'fortschritt timeline zeitachse tracker', when: roadmapPage, run: (a) => a.roadmap.setTab('progress') },
  { id: 'roadmap.toggleAll', label: msg('Expand or collapse all'), section: 'Roadmap', keys: ['z'], icon: 'chevronDown', keywords: 'expand collapse all alle auf zu aufklappen zuklappen fold', when: roadmapPage, run: (a) => a.roadmap.toggleAll() },
  { id: 'roadmap.public', label: msg('Roadmap: only public issues'), section: 'Roadmap', icon: 'eye', keywords: 'public öffentlich filter export discord', when: roadmapPage, run: (a) => a.roadmap.togglePublicOnly() },
  { id: 'roadmap.export', label: msg('Export roadmap as image …'), section: 'Roadmap', keys: ['shift+x'], icon: 'image', keywords: 'export image picture png discord share bild teilen exportieren', when: roadmapPage, run: (a) => a.roadmap.exportOpen.set(true) },
  { id: 'roadmap.today', label: msg('Progress: jump to today'), section: 'Roadmap', keys: ['n'], icon: 'calendar', keywords: 'today now heute jetzt', when: (a) => roadmapTab(a, 'progress'), run: (a) => a.roadmap.today() },
  { id: 'roadmap.zoomIn', label: msg('Progress: zoom in'), section: 'Roadmap', keys: ['+', '='], icon: 'plus', keywords: 'zoom in näher quarter quartal', when: (a) => roadmapTab(a, 'progress'), run: (a) => a.roadmap.zoomBy(-1) },
  { id: 'roadmap.zoomOut', label: msg('Progress: zoom out'), section: 'Roadmap', keys: ['-'], icon: 'minus', keywords: 'zoom out weiter year jahr', when: (a) => roadmapTab(a, 'progress'), run: (a) => a.roadmap.zoomBy(1) },
  { id: 'roadmap.rows', label: msg('Progress: rows by project or category'), section: 'Roadmap', keys: ['r'], icon: 'display', keywords: 'rows zeilen projects categories kategorien projekte', when: (a) => roadmapTab(a, 'progress'), run: (a) => a.roadmap.setRows(a.roadmap.ui.get().rows === 'projects' ? 'categories' : 'projects') },
] as Parameters<typeof registerAction>[0][]) registerAction(action);
