// Pull requests page (/pulls, SELF-100): the PRs linked to an issue, grouped by what comes next. Its
// own chunk (app.loadPulls). The server groups and sorts (`githubPr.list`, rules in
// backend/convex/shared/pullRequests.ts); this holds the subscription while the page is open, the
// keyboard focus, the collapsed "Done" group and one batched refresh per visit.
import { api } from '@selfbound/backend/api';
import type { Id } from '@selfbound/backend/dataModel';
import { PR_GROUPS, type PrGroup, type PrList, type PrListItem } from '@selfbound/backend/shared/pullRequests';
import { Slice } from '../observable.ts';
import type { Page } from '../route.ts';
import type { App } from './index.ts';

export interface PullsGroup {
  group: PrGroup;
  items: PrListItem[];
  /** Only "Done" collapses (closed by default, remembered in the browser) */
  collapsed: boolean;
}

export interface PullsState {
  /** false: the first result is still loading */
  loaded: boolean;
  /** GITHUB_TOKEN set: checks and reviews are fetched */
  configured: boolean;
  /** Groups with at least one PR, in PR_GROUPS order */
  groups: PullsGroup[];
  /** Row with the keyboard focus (J/K), null = none */
  focus: string | null;
}

const EMPTY: PullsState = { loaded: false, configured: false, groups: [], focus: null };
const DONE_OPEN_KEY = 'selfbound:pullsDoneOpen';
/** One refresh per visit for at most this many open PRs from the top (githubPr.refresh takes at most 10). */
export const REFRESH_COUNT = 10;
/** The reload button goes through the open PRs in batches of REFRESH_COUNT, at most this many (GitHub's rate limit). */
export const RELOAD_MAX = 50;
/** The server fetches only PRs fetched longer ago than this; webhooks keep them current otherwise. */
export const REFRESH_MAX_AGE_MS = 120_000;

export class PullsController {
  readonly state = new Slice<PullsState>(EMPTY);
  #watch: { slice: Slice<PrList | undefined>; release: () => void; stop: () => void } | null = null;
  #doneOpen: boolean;
  #focus: string | null = null;
  #refreshed = false;

  constructor(private app: App) {
    this.#doneOpen = globalThis.localStorage?.getItem(DONE_OPEN_KEY) === '1';
  }

  /** Called by the app after every page change. The PR page opened from the list keeps the subscription, so Back shows the list at once. */
  onPage(page: Page) {
    if (page.name === 'pulls') this.#start();
    else if (page.name !== 'pr') this.#stop();
  }

  #start() {
    if (this.#watch) return;
    this.#refreshed = false;
    const { slice, release } = this.app.store.watch(api.githubPr.list, {});
    const stop = slice.subscribe(() => this.#update());
    this.#watch = { slice, release, stop };
    this.#update();
  }

  #stop() {
    if (!this.#watch) return;
    this.#watch.stop();
    this.#watch.release();
    this.#watch = null;
    this.#focus = null;
    this.state.set(EMPTY);
  }

  #update() {
    const list = this.#watch?.slice.get();
    const groups: PullsGroup[] = [];
    for (const group of list ? PR_GROUPS : []) {
      const items = list!.items.filter((i) => i.group === group);
      if (items.length) groups.push({ group, items, collapsed: group === 'done' && !this.#doneOpen });
    }
    const visible = groups.flatMap((g) => (g.collapsed ? [] : g.items));
    if (this.#focus && !visible.some((i) => i.id === this.#focus)) this.#focus = null;
    this.state.set({ loaded: !!list, configured: list?.configured ?? false, groups, focus: this.#focus });
    if (list && !this.#refreshed) {
      this.#refreshed = true;
      this.refresh(list);
    }
  }

  /**
   * Fetch the open PRs at the top again: one call for up to REFRESH_COUNT PRs (GitHub's rate limit),
   * never one per row; the server skips those fetched within REFRESH_MAX_AGE_MS.
   */
  refresh(list = this.#watch?.slice.get()) {
    const prIds = this.#openIds(list).slice(0, REFRESH_COUNT);
    if (!prIds.length) return;
    this.app.store.act(api.githubPr.refresh, { prIds, maxAgeMs: REFRESH_MAX_AGE_MS }).catch(() => {});
  }

  /** The reload button: all open PRs now (up to RELOAD_MAX), batch after batch. Returns the first error. */
  async reload(): Promise<string | null> {
    const prIds = this.#openIds(this.#watch?.slice.get()).slice(0, RELOAD_MAX);
    let error: string | null = null;
    for (let i = 0; i < prIds.length; i += REFRESH_COUNT) {
      const result = await this.app.store.act(api.githubPr.refresh, { prIds: prIds.slice(i, i + REFRESH_COUNT), maxAgeMs: 0 });
      error ??= result.error ?? null;
    }
    return error;
  }

  /** Open and draft PRs in display order; none without a token (nothing can be fetched). */
  #openIds(list: PrList | undefined) {
    if (!list?.configured) return [];
    return list.items.filter((i) => i.group !== 'done').map((i) => i.id as Id<'pullRequests'>);
  }

  #visible() {
    return this.state.get().groups.flatMap((g) => (g.collapsed ? [] : g.items));
  }

  #find(id: string | null) {
    return id ? this.#visible().find((i) => i.id === id) : undefined;
  }

  #setFocus(id: string | null) {
    this.#focus = id;
    if (this.state.get().focus !== id) this.state.set({ ...this.state.get(), focus: id });
  }

  /** PR beside the list: a wide window, not on the phone (like the PR beside an issue). */
  canSplit() {
    return this.app.wide.get() && !this.app.mobile.get();
  }

  /** J/K: next or previous row; with a PR open beside the list it follows the focus. */
  step(delta: 1 | -1) {
    const visible = this.#visible();
    if (!visible.length) return;
    const at = visible.findIndex((i) => i.id === this.#focus);
    const next = at < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, at + delta));
    const item = visible[next]!;
    this.#setFocus(item.id);
    if (this.app.prSplit.get()) this.app.prSplit.set({ repo: item.repo, number: item.number });
  }

  /**
   * Click on a row: beside the list in a wide window (a second click closes it), otherwise as its own
   * page. Enter (`toggle: false`) on the PR already beside the list opens it full size.
   */
  open(id: string | null = this.#focus, opts: { toggle?: boolean } = {}) {
    const item = this.#find(id);
    if (!item) return;
    this.#setFocus(item.id);
    const shown = this.app.prSplit.get();
    const same = shown?.repo === item.repo && shown.number === item.number;
    if (!this.canSplit() || (same && opts.toggle === false)) {
      // The split closes by itself on a page change (App.onPage).
      this.app.nav.go({ name: 'pr', repo: item.repo, number: item.number });
      return;
    }
    this.app.prSplit.set(same ? null : { repo: item.repo, number: item.number });
  }

  /** Show or hide the merged and closed PRs of the last 14 days. */
  toggleDone() {
    this.#doneOpen = !this.#doneOpen;
    try {
      if (this.#doneOpen) globalThis.localStorage?.setItem(DONE_OPEN_KEY, '1');
      else globalThis.localStorage?.removeItem(DONE_OPEN_KEY);
    } catch {
      // storage full or blocked: only this session
    }
    this.#update();
  }
}
