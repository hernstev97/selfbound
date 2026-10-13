// App: wires the store and the controllers together. Framework-neutral; Svelte only renders what
// is in the slices and reports DOM events back.
//
//   nav      navigation, history, URL             list     view, filters, focus, selection
//   detail   detail page and peek                 edit     changes with undo/redo
//   palette  command menu, search, pickers        menu     context menu
//   create   create dialog and drafts             keys     keyboard
//   toasts   notices                              prefs    color scheme, font, sounds
//   cues     events for UI sounds
//   perf     measurement overlay                  sprints  sprint view, planning, completion
//
// Lists: `main` is the page's list; `side` the second column of sprint planning.
// `list` is the one in use (keyboard, targets), otherwise always `main`.
import type { ConvexClient } from 'convex/browser';
import { Auth } from '../auth.ts';
import { Slice } from '../observable.ts';
import type { Page } from '../route.ts';
import { IssueStore, type DebugHooks } from '../store.ts';
import { t } from '../i18n.ts';
import type { IssueId, TeamBadge } from '../types.ts';
import { INBOX_ROW_HEIGHT, ROW_HEIGHT, ROW_HEIGHT_MOBILE } from '../window.ts';
import { CreateController } from './create.ts';
import { DetailController } from './detail.ts';
import { Editor } from './edit.ts';
import { KeyController } from './keys.ts';
import { ListController } from './list.ts';
import { ContextMenuController } from './menu.ts';
import { Navigator } from './nav.ts';
import { PaletteController } from './palette.ts';
import { Perf } from './perf.ts';
import { Prefs, type SidebarTeamSize } from './prefs.ts';
import type { SprintController } from './sprints.ts';
import type { WikiController } from './wiki.ts';
import { Cues } from './cues.ts';
import { Toasts } from './toasts.ts';
import { budgetLabel, overBudget, priorityBudget } from '../budget.ts';

export interface ShellState {
  /** What the main area shows */
  page: Page['name'];
  /** Issue page: waiting for data, or the issue does not exist */
  issue: 'ok' | 'loading' | 'missing';
  peek: boolean;
  /** Inbox as split view: list on the left, issue on the right */
  split: boolean;
  mobile: boolean;
  sidebarHidden: boolean;
}

export interface SidebarTeam {
  id: string;
  key: string;
  badge: TeamBadge;
  dormant: boolean;
  triage: number;
  /** Wiki: 'on' next to the issues, 'only' wiki only, null none */
  wiki: 'on' | 'only' | null;
}

/** Numbers on a team card (App.teamStats). */
export interface TeamStats {
  /** Open issues by status type: not started (Todo and equivalents) and started */
  todo: number;
  started: number;
  /** Team issues in the active sprint (without canceled), and how many are done; 0 = none */
  sprintIssues: number;
  sprintDone: number;
}

/**
 * Team card numbers are recomputed at most this often: they do not answer an input. On load,
 * 10,000 issues arrive in about 150 batches; redrawing the sidebar after each one cost the start
 * 2–3 ms (P1) and 7–12 ms (P2) in a measurement run.
 */
const STATS_DELAY = 150;


/**
 * From this window width on, the inbox shows list and issue side by side. Below it (narrow windows,
 * phones) the issue opens as its own page, as in any other list.
 */
export const SPLIT_MIN_WIDTH = 1100;

export interface SidebarState {
  /** e.g. 'inbox', 'all', 'team:KIU:active', 'team:KIU:backlog', 'team:KIU:projects' */
  active: string;
  inbox: number;
  /** Snoozed issues; the entry shows only when there are some */
  snoozed: number;
  triage: number;
  drafts: number;
  /** Name of the active sprint */
  sprint: string | null;
  /** A sprint is being planned */
  planning: boolean;
  /** Current team (at the top, with navigation); null = no teams yet */
  current: SidebarTeam | null;
  /** Other active teams in fixed order, without the current one */
  teams: SidebarTeam[];
  /** Dormant teams, without the current one */
  dormant: SidebarTeam[];
  teamsCollapsed: boolean;
  dormantCollapsed: boolean;
  /** Other teams as small rows or large cards (Settings › General) */
  teamSize: SidebarTeamSize;
}

export interface AppOptions {
  client: ConvexClient;
  auth: Auth;
  /** Measurement and test hooks (globalThis.__xlr8, test switch): only DEV, ?perf=1 or test build */
  debug: boolean;
  perf: boolean;
  cacheName: string;
  /** Optional prefix for suggested git branch names, e.g. a user name; the app passes VITE_XLR8_BRANCH_PREFIX */
  branchPrefix?: string;
}

export class App {
  readonly store: IssueStore;
  readonly auth: Auth;
  readonly debug: boolean;
  /** Prefix for suggested git branch names (AppOptions.branchPrefix); undefined = none */
  readonly branchPrefix: string | undefined;
  readonly prefs: Prefs;
  /** Events for UI sounds; the UI listens */
  readonly cues = new Cues();
  readonly toasts = new Toasts(this.cues);
  readonly perf: Perf;
  readonly nav: Navigator;
  readonly main: ListController;
  readonly side: ListController;
  /** Which list is in use (sprint planning: backlog on the left, sprint on the right) */
  readonly pane = new Slice<'main' | 'side'>('main');
  readonly detail: DetailController;
  readonly edit: Editor;
  readonly palette: PaletteController;
  readonly menu: ContextMenuController;
  readonly create: CreateController;
  readonly keys: KeyController;
  readonly shell = new Slice<ShellState>({ page: 'home', issue: 'ok', peek: false, split: false, mobile: false, sidebarHidden: false });
  readonly sidebar = new Slice<SidebarState>({ active: '', inbox: 0, snoozed: 0, triage: 0, drafts: 0, sprint: null, planning: false, current: null, teams: [], dormant: [], teamsCollapsed: false, dormantCollapsed: false, teamSize: 'small' });
  /** Team card numbers by team key, recomputed in batches (STATS_DELAY) */
  readonly teamStats = new Slice<Readonly<Record<string, TeamStats>>>({});
  readonly displayOpen = new Slice(false);
  /** "Add team" dialog (sidebar, O N, command menu) */
  readonly newTeamOpen = new Slice(false);
  readonly mobileDrawer = new Slice(false);
  /** Pull request next to the open issue; null = closed. Only on the issue page. */
  readonly prSplit = new Slice<{ repo: string; number: number } | null>(null);
  readonly mobile = new Slice(false);
  /** Window wide enough for the inbox split view */
  readonly wide = new Slice(false);
  #override: IssueId[] | null = null;
  #disposers: (() => void)[] = [];
  #sidebarHidden = false;
  #statsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AppOptions) {
    this.debug = options.debug;
    this.branchPrefix = options.branchPrefix;
    const hooks: DebugHooks | null = options.debug ? (globalThis.__xlr8 ??= { saves: [] }) : null;
    this.store = new IssueStore(options.client, { cacheName: options.cacheName, hooks });
    this.auth = options.auth;
    this.prefs = new Prefs();
    this.perf = new Perf(options.perf);
    this.nav = new Navigator(this);
    this.main = new ListController(this);
    this.side = new ListController(this, { side: true });
    this.detail = new DetailController(this);
    this.edit = new Editor(this);
    this.palette = new PaletteController(this);
    this.menu = new ContextMenuController(this);
    this.create = new CreateController(this);
    this.keys = new KeyController(this);
    if (hooks) {
      hooks.app = this;
      // Test hook: which cues were emitted (whether they sound is up to app/src/lib/sound)
      const heard: string[] = ((hooks.cues as string[] | undefined) ??= []);
      this.cues.subscribe((event) => heard.push(event.cue));
    }
  }

  start() {
    const store = this.store;
    this.#disposers.push(
      store.onChange((ids) => {
        this.main.onIssues(ids);
        this.side.onIssues(ids);
        this.#sprints?.refresh();
        this.detail.refreshIf(ids);
        this.#updateSidebar();
        this.#checkIssuePage();
      }),
      store.meta.subscribe(() => {
        this.main.onMeta(store.meta.get());
        this.side.onMeta(store.meta.get());
        this.#sprints?.refresh();
        this.#wiki?.refresh();
        this.detail.refresh();
        this.#updateSidebar();
        this.#redirectWikiOnly(this.nav.page.get());
      }),
      store.agents.subscribe(() => {
        this.main.rows.refreshAll();
        this.side.rows.refreshAll();
        this.detail.refresh();
      }),
      store.sync.subscribe(() => this.#checkIssuePage()),
      this.prefs.dark.subscribe(() => {
        this.main.onTheme();
        this.side.onTheme();
        this.detail.refresh();
        this.#updateSidebar();
      }),
      this.prefs.state.subscribe(() => this.#updateSidebar()),
      this.create.drafts.subscribe(() => this.#updateSidebar()),
      this.create.state.subscribe(() => this.#updateSidebar()),
      // Back closes these overlays (nav.ts). Create behaves like navigating away: the draft stays
      // the open one, and C or the plus button brings it back with its content.
      this.#backCloses(this.palette.state, () => !!this.palette.state.get(), () => this.palette.close()),
      this.#backCloses(this.menu.state, () => !!this.menu.state.get(), () => this.menu.close()),
      this.#backCloses(this.create.state, () => this.create.isOpen(), () => this.create.hide()),
      this.#backCloses(this.displayOpen, () => this.displayOpen.get(), () => this.displayOpen.set(false)),
      this.#backCloses(this.newTeamOpen, () => this.newTeamOpen.get(), () => this.newTeamOpen.set(false)),
      this.#backCloses(this.mobileDrawer, () => this.mobileDrawer.get(), () => this.mobileDrawer.set(false)),
    );
    if (typeof window !== 'undefined') {
      this.#disposers.push(this.keys.attach(window));
      const onPointer = (e: PointerEvent) => this.perf.measure(e.timeStamp, t('Click'));
      const onUnload = () => this.create.flush();
      window.addEventListener('pointerdown', onPointer, true);
      window.addEventListener('pagehide', onUnload);
      this.#disposers.push(() => {
        window.removeEventListener('pointerdown', onPointer, true);
        window.removeEventListener('pagehide', onUnload);
      });
      if (typeof matchMedia !== 'undefined') {
        const media = matchMedia('(max-width: 768px)');
        const apply = () => {
          this.mobile.set(media.matches);
          if (!media.matches) this.mobileDrawer.set(false);
          this.detail.onLayout();
          this.updateShell();
        };
        media.addEventListener('change', apply);
        apply();
        const wide = matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
        const applyWide = () => {
          this.wide.set(wide.matches);
          this.detail.onLayout();
          this.updateShell();
        };
        wide.addEventListener('change', applyWide);
        applyWide();
      }
    }
    this.store.watchAgents();
    this.#disposers.push(this.#gateWrites());
    void this.store.start();
    const stopNav = this.nav.start();
    if (stopNav) this.#disposers.push(stopNav);
    this.#updateSidebar();
  }

  /** While `isOpen()` holds, the overlay is registered with the navigator: Back calls `close`. */
  #backCloses(slice: Pick<Slice<unknown>, 'subscribe'>, isOpen: () => boolean, close: () => void) {
    let release: (() => void) | null = null;
    const stop = slice.subscribe(() => {
      const open = isOpen();
      if (open && !release) release = this.nav.hold(close);
      else if (!open && release) {
        release();
        release = null;
      }
    });
    return () => {
      stop();
      release?.();
    };
  }

  dispose() {
    if (this.#statsTimer) clearTimeout(this.#statsTimer);
    for (const d of this.#disposers) d();
    this.store.stop();
  }

  /**
   * Started from the cache, sign-in not confirmed yet: changes wait until Clerk has signed in. If Clerk
   * is unreachable, they fail right away with a notice. Otherwise Convex would only seem to keep them:
   * after a lost connection it sends them without a token and the server rejects them.
   */
  #gateWrites() {
    let waiting: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
    const update = () => {
      const status = this.auth.status.get();
      if (status === 'cached' && !this.auth.unreachable.get()) {
        if (!waiting) {
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
          promise.catch(() => {});
          waiting = { promise, resolve, reject };
          this.store.setWriteGate(promise);
        }
        return;
      }
      const error =
        status === 'cached'
          ? new Error(t('Offline: you can make changes again once XLR8 is connected and signed in.'))
          : status === 'signed-out' || status === 'denied'
            ? new Error(t('Not signed in: the change was not saved.'))
            : null;
      if (error) waiting?.reject(error);
      else waiting?.resolve();
      waiting = null;
      if (!error) return this.store.setWriteGate(null);
      const refused = Promise.reject(error);
      refused.catch(() => {});
      this.store.setWriteGate(refused);
    };
    update();
    const stops = [this.auth.status.subscribe(update), this.auth.unreachable.subscribe(update)];
    return () => stops.forEach((stop) => stop());
  }

  #sprints: SprintController | null = null;
  #sprintsLoading: Promise<SprintController> | null = null;

  /** Sprints (planning, completion, overview); available after `loadSprints()` (own chunk). */
  get sprints(): SprintController {
    if (!this.#sprints) throw new Error('Sprints are not loaded yet (app.loadSprints())');
    return this.#sprints;
  }

  sprintsLoaded(): SprintController | null {
    return this.#sprints;
  }

  loadSprints(): Promise<SprintController> {
    this.#sprintsLoading ??= import('./sprints.ts').then(
      ({ SprintController }) => {
        this.#sprints = new SprintController(this);
        this.#sprints.onPage(this.nav.page.get());
        return this.#sprints;
      },
      (error: unknown) => {
        // Failed offline: load again next time.
        this.#sprintsLoading = null;
        throw error;
      },
    );
    return this.#sprintsLoading;
  }

  #wiki: WikiController | null = null;
  #wikiLoading: Promise<WikiController> | null = null;

  /** Wiki; available after `loadWiki()` (own chunk). */
  get wiki(): WikiController {
    if (!this.#wiki) throw new Error('Wiki is not loaded yet (app.loadWiki())');
    return this.#wiki;
  }

  wikiLoaded(): WikiController | null {
    return this.#wiki;
  }

  loadWiki(): Promise<WikiController> {
    this.#wikiLoading ??= import('./wiki.ts').then(
      ({ WikiController }) => {
        this.#wiki = new WikiController(this);
        this.#wiki.onPage(this.nav.page.get());
        return this.#wiki;
      },
      (error: unknown) => {
        this.#wikiLoading = null;
        throw error;
      },
    );
    return this.#wikiLoading;
  }

  /** The list in use. */
  get list(): ListController {
    return this.pane.get() === 'side' && !this.side.idle ? this.side : this.main;
  }

  /** Select a sprint planning column (click, mouse, Tab). */
  setPane(pane: 'main' | 'side') {
    if (pane === 'side' && this.side.idle) return;
    if (this.pane.get() === pane) return;
    this.pane.set(pane);
    this.main.refreshFocusRow();
    this.side.refreshFocusRow();
    this.detail.onFocus(this.list.focusId());
  }

  #budget: { version: number; labels: Map<string, { label: string; over: boolean }> } | null = null;

  /** Priority budget per team as text (for team groups), recomputed only after changes. */
  budgetLabels() {
    const version = this.store.version.get();
    if (this.#budget?.version !== version) {
      const labels = new Map<string, { label: string; over: boolean }>();
      for (const [teamId, b] of priorityBudget(this.store.all())) labels.set(teamId, { label: budgetLabel(b), over: overBudget(b) });
      this.#budget = { version, labels };
    }
    return this.#budget.labels;
  }

  /** Inbox as split view (wide window, inbox page)? */
  splitLayout() {
    const page = this.nav.page.get();
    return page.name === 'view' && page.view.kind === 'inbox' && this.wide.get() && !this.mobile.get();
  }

  rowHeight() {
    if (this.list.list.get().style === 'inbox') return INBOX_ROW_HEIGHT;
    return this.mobile.get() ? ROW_HEIGHT_MOBILE : ROW_HEIGHT;
  }

  // ---------------------------------------------------------------- Targets

  /** What actions apply to: menu target, open issue, otherwise selection or focus. */
  targets(): IssueId[] {
    if (this.#override) return this.#override;
    const menu = this.menu.state.get() ? this.menu.targets() : null;
    if (menu && menu.length) return menu;
    const page = this.detail.pageId();
    const name = this.nav.page.get().name;
    if (name === 'issue') return page ? [page] : [];
    // Wiki and PR pages: status and other issue shortcuts must not hit a (hidden) issue of the list.
    if (name === 'wiki' || name === 'article' || name === 'pr') return [];
    return this.list.targets();
  }

  withTargets(ids: IssueId[], run: () => void) {
    this.#override = ids;
    try {
      run();
    } finally {
      this.#override = null;
    }
  }

  /** Team in context (for G B: backlog of the current team). */
  contextTeam(): string | null {
    const page = this.nav.page.get();
    if (page.name === 'view') return page.view.team;
    if (page.name === 'wiki') return page.team;
    if (page.name === 'issue') {
      const issue = this.store.byKey(page.key);
      return issue ? this.store.teamKey(issue.teamId) : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- Pages

  openIssue(id: IssueId, opts: { replace?: boolean } = {}) {
    const issue = this.store.get(id);
    if (!issue) return;
    if (issue.pending) {
      this.toasts.show(t('Still saving, you can open it in a moment'));
      return;
    }
    // Only issues of the list get the focus; otherwise (e.g. from search) it stays where it was,
    // so after Esc the list is back with its focus.
    if (this.list.order().includes(id)) this.list.focus(id);
    this.palette.pushRecent(id);
    this.nav.go({ name: 'issue', key: issue.key }, opts);
  }

  closeIssue() {
    this.nav.back();
  }

  /**
   * Wiki-only team: its lists (issues, backlog, triage) do not exist, `/team/KEY` leads to the wiki.
   * Returns true if it redirected.
   */
  #redirectWikiOnly(page: Page): boolean {
    if (page.name !== 'view' || !page.view.team || page.view.kind === 'project') return false;
    const key = page.view.team;
    if (this.store.meta.get()?.teams.find((t) => t.key === key)?.wiki !== 'only') return false;
    this.nav.go({ name: 'wiki', team: key }, { replace: true });
    return true;
  }

  /** Called by the navigator after each page change. */
  onPage(page: Page) {
    if (this.#redirectWikiOnly(page)) return;
    // Do not leave focus on the clicked link/button, otherwise Enter/Space trigger it again
    // instead of the new page's shortcuts.
    if (typeof document !== 'undefined') {
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'A' || active.tagName === 'BUTTON')) active.blur();
    }
    this.create.hide();
    this.displayOpen.set(false);
    this.newTeamOpen.set(false);
    const planning = page.name === 'view' && page.view.kind === 'plan';
    if (!planning) {
      this.side.idle = true;
      this.pane.set('main');
    }
    // Sprint logic lives in its own chunk: load it on sprint pages, then report the page.
    const sprintPage = page.name === 'sprints' || (page.name === 'view' && ['sprint', 'plan', 'close'].includes(page.view.kind));
    if (this.#sprints) this.#sprints.onPage(page);
    else if (sprintPage) void this.loadSprints();
    // Same for the wiki: own chunk, loaded on wiki pages only.
    if (this.#wiki) this.#wiki.onPage(page);
    else if (page.name === 'wiki' || page.name === 'article') void this.loadWiki();
    this.mobileDrawer.set(false);
    if (page.name === 'issue') this.#checkIssuePage();
    else this.detail.closePage();
    if (page.name !== 'issue') this.prSplit.set(null);
    this.detail.onLayout();
    if (page.name === 'view') {
      // Back from an issue that is not (or no longer) in the list: put the focus back into the list.
      const focus = this.list.focusId();
      if (focus && !this.list.order().includes(focus)) this.list.focusEdge(false);
    }
    // Team page: the team becomes the sidebar's current team (issue pages do not change it).
    const team = page.name === 'projects' || page.name === 'wiki' ? page.team : page.name === 'view' ? page.view.team : null;
    if (team && team !== this.prefs.state.get().currentTeam) this.prefs.set({ currentTeam: team });
    this.#updateSidebar();
    const wasIssue = this.shell.get().page === 'issue';
    this.updateShell();
    // Back from the issue to the (still mounted) list: if ↑/↓ in the detail moved the focus, scroll it into view.
    if (wasIssue && page.name === 'view') queueMicrotask(() => this.list.revealFocus());
    if (typeof document !== 'undefined') document.title = this.#title(page);
  }

  #title(page: Page) {
    if (page.name === 'issue') {
      const issue = this.store.byKey(page.key);
      return issue ? `${issue.key} ${issue.title} · XLR8` : `${page.key} · XLR8`;
    }
    if (page.name === 'view') return `${this.list.header.get().title} · XLR8`;
    if (page.name === 'settings') return `${t('Settings')} · XLR8`;
    if (page.name === 'drafts') return `${t('Drafts')} · XLR8`;
    if (page.name === 'projects') return `${t('Projects')} · ${page.team} · XLR8`;
    if (page.name === 'wiki') return `${t('Knowledge')} · ${page.team} · XLR8`;
    if (page.name === 'article') return `${t('Knowledge')} · XLR8`;
    if (page.name === 'pr') return `${page.repo.split('/')[1] ?? page.repo}#${page.number} · XLR8`;
    if (page.name === 'sprints') return 'Sprints · XLR8';
    return 'XLR8';
  }

  #resolving: string | null = null;

  /** Issue page: resolve the ID once the data is there; old IDs through the server. */
  #checkIssuePage() {
    const page = this.nav.page.get();
    if (page.name !== 'issue') return;
    const issue = this.store.byKey(page.key);
    if (issue) {
      if (this.detail.pageId() !== issue._id) {
        this.detail.openPage(issue._id);
        if (this.list.order().includes(issue._id)) this.list.focus(issue._id);
        this.palette.pushRecent(issue._id);
        this.edit.markRead([issue._id]);
        if (typeof document !== 'undefined') document.title = this.#title(page);
      }
      this.updateShell();
      return;
    }
    this.updateShell();
    if (this.store.sync.get().phase !== 'live' || this.#resolving === page.key) return;
    this.#resolving = page.key;
    // Maybe an old ID (e.g. from an import): ask the server and redirect to the current one.
    this.store.resolve(page.key).then(
      (hit) => {
        const current = this.nav.page.get();
        if (current.name !== 'issue' || current.key !== page.key) return;
        const found = hit ? this.store.get(hit.id) : undefined;
        if (found) this.nav.go({ name: 'issue', key: found.key }, { replace: true });
        else this.updateShell();
      },
      () => this.updateShell(),
    );
  }

  updateShell() {
    const page = this.nav.page.get();
    let issue: ShellState['issue'] = 'ok';
    if (page.name === 'issue') {
      const found = this.store.byKey(page.key);
      issue = found ? 'ok' : this.store.sync.get().phase === 'live' && this.#resolving === page.key ? 'missing' : 'loading';
    }
    const next: ShellState = { page: page.name, issue, peek: page.name === 'view' && this.detail.peekVisible(), split: this.splitLayout(), mobile: this.mobile.get(), sidebarHidden: this.#sidebarHidden };
    const prev = this.shell.get();
    if (prev.page !== next.page || prev.issue !== next.issue || prev.peek !== next.peek || prev.split !== next.split || prev.mobile !== next.mobile || prev.sidebarHidden !== next.sidebarHidden) this.shell.set(next);
  }

  closeOverlays() {
    this.palette.close();
    this.menu.close();
    this.displayOpen.set(false);
  }

  /** Open the "Add team" dialog. */
  openNewTeam() {
    this.palette.close();
    this.menu.close();
    this.displayOpen.set(false);
    this.newTeamOpen.set(true);
  }

  /** Settings of the current team (name, logo, status, workflow). */
  openTeamSettings(key: string | null = this.currentTeam()) {
    if (key) this.nav.go({ name: 'settings', section: 'teams', sub: key });
    else this.nav.go({ name: 'settings', section: 'teams' });
  }

  toggleDisplay() {
    this.palette.close();
    this.displayOpen.set(!this.displayOpen.get());
  }

  toggleSidebar() {
    if (this.mobile.get()) {
      this.mobileDrawer.set(!this.mobileDrawer.get());
      return;
    }
    this.#sidebarHidden = !this.#sidebarHidden;
    this.updateShell();
  }

  async toggleRejectWrites() {
    const next = !this.store.meta.get()?.rejectWrites;
    try {
      await this.store.setRejectWrites(next);
      this.toasts.show(next ? t('Test switch on: the server rejects changes.') : t('Test switch off: changes are saved again.'));
    } catch (error) {
      this.toasts.error(t('Test switch not toggled'), error);
    }
  }

  // ---------------------------------------------------------------- Sidebar

  /**
   * Switch team (sidebar card, O T): the same team page of the other team, so backlog stays
   * backlog and projects stay projects, otherwise its issues.
   */
  switchTeam(key: string) {
    const page = this.nav.page.get();
    if (page.name === 'projects') {
      this.nav.go({ name: 'projects', team: key });
      return;
    }
    // From the wiki into the other team's wiki if it has one; wiki-only teams always go there.
    const wiki = this.store.meta.get()?.teams.find((t) => t.key === key)?.wiki;
    if (wiki === 'only' || ((page.name === 'wiki' || page.name === 'article') && wiki)) {
      this.nav.go({ name: 'wiki', team: key });
      return;
    }
    const kind = page.name === 'view' && page.view.team && page.view.kind === 'backlog' ? 'backlog' : 'active';
    this.nav.goView({ kind, team: key });
  }

  /** Key of the current team: last visited team page, otherwise the first active team. */
  currentTeam(): string | null {
    const teams = this.store.meta.get()?.teams ?? [];
    const key = this.prefs.state.get().currentTeam;
    if (key && teams.some((t) => t.key === key)) return key;
    return (teams.find((t) => !t.dormant) ?? teams[0])?.key ?? null;
  }

  #updateSidebar() {
    const meta = this.store.meta.get();
    const prefs = this.prefs.state.get();
    const { inbox, triage, triageByTeam, snoozed } = this.store.counts();
    const page = this.nav.page.get();
    let active: string = page.name;
    if (page.name === 'view') active = page.view.team ? `team:${page.view.team}:${page.view.kind === 'all' || page.view.kind === 'project' ? 'active' : page.view.kind}` : page.view.kind;
    if (page.name === 'projects') active = `team:${page.team}:projects`;
    if (page.name === 'wiki') active = `team:${page.team}:wiki`;
    if (page.name === 'view' && page.view.kind === 'project') active = `team:${page.view.team}:projects`;
    if (page.name === 'view' && (page.view.kind === 'plan' || page.view.kind === 'close')) active = 'sprint';
    if (page.name === 'sprints') active = 'sprint';
    const currentKey = this.currentTeam();
    if (page.name === 'article' && currentKey) active = `team:${currentKey}:wiki`;
    const sprint = meta?.sprints.find((s) => s.state === 'active') ?? null;
    const teams: SidebarTeam[] = (meta?.teams ?? []).map((t) => ({
      id: t._id,
      key: t.key,
      badge: this.list.teamBadge(t._id),
      dormant: t.dormant,
      triage: triageByTeam.get(t._id) ?? 0,
      wiki: t.wiki ?? null,
    }));
    const others = teams.filter((t) => t.key !== currentKey);
    const next: SidebarState = {
      active,
      inbox,
      snoozed,
      triage,
      drafts: this.create.draftCount(),
      sprint: sprint?.name ?? null,
      planning: meta?.sprints.some((s) => s.state === 'planning') ?? false,
      current: teams.find((t) => t.key === currentKey) ?? null,
      teams: others.filter((t) => !t.dormant),
      dormant: others.filter((t) => t.dormant),
      teamsCollapsed: prefs.teamsCollapsed,
      dormantCollapsed: prefs.dormantCollapsed,
      teamSize: prefs.sidebarTeams,
    };
    if (JSON.stringify(next) !== JSON.stringify(this.sidebar.get())) this.sidebar.set(next);
    this.#statsTimer ??= setTimeout(() => {
      this.#statsTimer = null;
      this.updateTeamStats();
    }, STATS_DELAY);
  }

  /** Recompute the team card numbers now (otherwise batched after STATS_DELAY). */
  updateTeamStats() {
    const meta = this.store.meta.get();
    const sprint = meta?.sprints.find((s) => s.state === 'active')?._id ?? null;
    const next: Record<string, TeamStats> = {};
    for (const t of meta?.teams ?? []) next[t.key] = this.store.teamCounts(t._id, sprint);
    if (JSON.stringify(next) !== JSON.stringify(this.teamStats.get())) this.teamStats.set(next);
  }
}
