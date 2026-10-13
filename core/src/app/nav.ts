// Navigation: current page, browser history and URL. The list holds filters and display; the
// navigator writes them into the URL.
import { Slice } from '../observable.ts';
import { labelIdsFrom, pagePath, readLocation, samePage, writeLocation, type Location, type Page } from '../route.ts';
import type { Filters, Grouping, Ordering, ViewRoute } from '../types.ts';
import { VIEWS } from '../views.ts';
import type { App } from './index.ts';

const LAST_VIEW = 'xlr8:lastView';
/** URL of the last list including filters: Back after a reload lands there. */
const LAST_VIEW_URL = 'xlr8:lastViewUrl';
/** Marker in history.state: history entry of an open overlay. */
const OVERLAY = 'xlr8Overlay';
const OVERLAY_STATE = { [OVERLAY]: true };

function isOverlayState(state: unknown) {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[OVERLAY] === true;
}

export interface GoOptions {
  replace?: boolean;
  filters?: Filters;
  quick?: string;
  group?: Grouping | null;
  order?: Ordering | null;
  layout?: 'board' | null;
}

export class Navigator {
  readonly page = new Slice<Page>({ name: 'home' });
  #lastView: ViewRoute;
  /** How many entries we pushed onto the history ourselves (so Back goes back instead of to a new page). */
  #depth = 0;

  constructor(
    private app: App,
    private win: Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener'> | null = typeof window !== 'undefined' ? window : null,
  ) {
    let last: ViewRoute | null = null;
    try {
      last = JSON.parse(globalThis.localStorage?.getItem(LAST_VIEW) ?? 'null');
    } catch {
      last = null;
    }
    this.#lastView = last && VIEWS[last.kind] ? last : { kind: 'inbox', team: null };
  }

  lastView(): ViewRoute {
    return this.#lastView;
  }

  /** First page from the URL (after start). */
  start() {
    if (!this.win) return;
    const onPop = () => {
      if (this.#onOverlayPop()) return;
      this.#apply(readLocation(new URL(this.win!.location.href)), true);
    };
    this.win.addEventListener('popstate', onPop);
    // Reloaded on an overlay entry: the overlay is closed, so leave the entry.
    if (isOverlayState(this.win.history.state)) this.#leaveOverlayEntry();
    this.#apply(readLocation(new URL(this.win.location.href)), false);
    return () => this.win?.removeEventListener('popstate', onPop);
  }

  #apply(loc: Location, fromHistory: boolean) {
    const page = loc.page;
    if (page.name === 'home') {
      this.#goLastView(true);
      return;
    }
    if (page.name === 'new') {
      this.go({ name: 'view', view: this.#lastView }, { replace: true });
      this.app.create.openFromParams(loc.params);
      return;
    }
    if (fromHistory) this.#depth = Math.max(0, this.#depth - 1);
    this.#show(page, { filters: this.#labelIds(loc.filters), quick: loc.quick, group: loc.group, order: loc.order, layout: loc.layout });
    if (!fromHistory) this.syncUrl('replace');
  }

  /**
   * Labels appear in the URL by name (or old ID). If meta has not arrived yet, the names stay and
   * are resolved once it does.
   */
  #labelIds(filters: Filters): Filters {
    if (!filters.label.length) return filters;
    const meta = this.app.store.meta.get();
    if (!meta) {
      this.#resolveLabelsLater();
      return filters;
    }
    const label = labelIdsFrom(filters.label, meta.labels);
    return label.every((id, n) => id === filters.label[n]) ? filters : { ...filters, label };
  }

  #waitingForLabels = false;
  #resolveLabelsLater() {
    if (this.#waitingForLabels) return;
    this.#waitingForLabels = true;
    const stop = this.app.store.meta.subscribe(() => {
      const meta = this.app.store.meta.get();
      if (!meta) return;
      stop();
      this.#waitingForLabels = false;
      const page = this.page.get();
      const view = this.app.main.view.get();
      if (page.name !== 'view' || !view.filters.label.length) return;
      const filters = this.#labelIds(view.filters);
      if (filters !== view.filters) this.go(page, { replace: true, filters, quick: view.quick });
    });
  }

  #show(page: Page, opts: GoOptions = {}) {
    this.app.closeOverlays();
    if (page.name === 'view') {
      this.app.main.setRoute(page.view, opts);
      if (page.view.kind === 'plan') this.app.side.setRoute({ kind: 'planned', team: null, sprint: page.view.sprint ?? null });
      this.#lastView = page.view;
      try {
        globalThis.localStorage?.setItem(LAST_VIEW, JSON.stringify(page.view));
      } catch {
        // ignore
      }
    }
    this.page.set(page);
    this.app.onPage(page);
  }

  /** Go to a page (new history entry, unless `replace`). */
  go(page: Page, opts: GoOptions = {}) {
    const current = this.page.get();
    const changed = !samePage(current, page);
    this.#show(page, opts);
    if (changed && !opts.replace) this.#depth++;
    let mode: 'replace' | 'push' = opts.replace || !changed ? 'replace' : 'push';
    // From within an overlay (command menu result): the new page takes over its entry.
    if (mode === 'push' && this.#marked) {
      this.#marked = false;
      mode = 'replace';
    }
    this.syncUrl(mode);
  }

  goView(view: ViewRoute, opts: GoOptions = {}) {
    this.go({ name: 'view', view }, opts);
  }

  /** Back: browser history if we came from one of our pages, otherwise to the last list (with filters). */
  back() {
    if (this.#depth > 0 && this.win) {
      // If an overlay entry is still on top, it goes too.
      if (this.#marked) {
        this.#marked = false;
        this.win.history.go(-2);
        return;
      }
      this.win.history.back();
      return;
    }
    this.#goLastView(false);
  }

  /**
   * Open an app URL like a link, with filters from the URL (e.g. tapping a notification). New
   * history entry, so Back leads to the previous page.
   */
  open(href: string) {
    const loc = readLocation(new URL(href, 'https://app.invalid'));
    if (loc.page.name === 'home') return this.#goLastView(false);
    if (loc.page.name === 'new') return this.app.create.openFromParams(loc.params);
    this.go(loc.page, { filters: this.#labelIds(loc.filters), quick: loc.quick, group: loc.group, order: loc.order, layout: loc.layout });
  }

  /** To the last list (with filters), e.g. "Back to app" from settings. */
  toLastView() {
    this.#goLastView(false);
  }

  #goLastView(replace: boolean) {
    let saved: string | null = null;
    try {
      saved = globalThis.localStorage?.getItem(LAST_VIEW_URL) ?? null;
    } catch {
      saved = null;
    }
    if (saved && this.win) {
      const loc = readLocation(new URL(saved, this.win.location.origin));
      if (loc.page.name === 'view') {
        this.go(loc.page, { replace, filters: this.#labelIds(loc.filters), quick: loc.quick, group: loc.group, order: loc.order, layout: loc.layout });
        return;
      }
    }
    this.go({ name: 'view', view: this.#lastView }, { replace });
  }

  /** Write the URL from the current state. */
  syncUrl(mode: 'replace' | 'push') {
    if (!this.win) return;
    const page = this.page.get();
    if (page.name === 'home' || page.name === 'new') return;
    const view = this.app.main.view.get();
    const def = page.name === 'view' ? VIEWS[page.view.kind].display(page.view) : null;
    const url = writeLocation(new URL(this.win.location.href), {
      page,
      filters: view.filters,
      quick: view.quick,
      group: def && view.display.grouping !== def.grouping ? view.display.grouping : null,
      order: def && view.display.ordering !== def.ordering ? view.display.ordering : null,
      layout: view.display.layout === 'board' ? 'board' : null,
    }, this.app.store.meta.get()?.labels ?? []);
    if (page.name === 'view') {
      try {
        globalThis.localStorage?.setItem(LAST_VIEW_URL, url.pathname + url.search);
      } catch {
        // ignore
      }
    }
    if (url.href === this.win.location.href) return;
    // One of our own Backs (overlay closed) is still in flight: it would hit the new entry otherwise.
    // The entry is pushed once its popstate arrives (#onOverlayPop).
    if (mode === 'push' && this.#skipPops > 0) {
      this.#pushAfterPop = true;
      return;
    }
    if (mode === 'push') this.win.history.pushState(null, '', url);
    else this.win.history.replaceState(this.#marked ? OVERLAY_STATE : null, '', url);
  }

  href(page: Page) {
    return pagePath(page);
  }

  // ---------------------------------------------------------------- Overlays and Back
  //
  // Back (Android gesture, browser, mouse button) first closes the topmost overlay (command menu,
  // picker, context menu, create, display, dialogs, phone drawer) instead of changing the page below
  // or leaving the installed app. For that, the first open overlay pushes a history entry with the
  // same URL (OVERLAY). Back leaves it, and popstate then closes the topmost overlay instead of
  // showing a page; if others are still open, a new entry is pushed. If the last one closes another
  // way (Esc, click, choice), history.back() removes the entry and its popstate is skipped. If the
  // app navigates while the entry is on top, the new page takes it over (go), so no dead entry stays
  // in the history.
  //
  // Syncing happens in a microtask: closing and navigating right after (picking a result), or
  // closing and opening the next one (context menu → picker), costs no entry.

  #overlays: { close: () => void }[] = [];
  /** The overlay entry is on top of the history. */
  #marked = false;
  /** URL of the entry below: a single Back lands there. */
  #baseUrl = '';
  /** Our own history.back() calls whose popstate is skipped. */
  #skipPops = 0;
  /** A new page waits with its entry for our own Back. */
  #pushAfterPop = false;
  #syncQueued = false;

  /** An overlay is open; Back closes it with `close`. Returns the release function (call it on close). */
  hold(close: () => void): () => void {
    const entry = { close };
    this.#overlays.push(entry);
    this.#queueOverlaySync();
    return () => {
      const index = this.#overlays.indexOf(entry);
      if (index < 0) return;
      this.#overlays.splice(index, 1);
      this.#queueOverlaySync();
    };
  }

  #queueOverlaySync() {
    if (this.#syncQueued || !this.win) return;
    this.#syncQueued = true;
    queueMicrotask(() => {
      this.#syncQueued = false;
      this.#syncOverlayEntry();
    });
  }

  #syncOverlayEntry() {
    // One of our own Backs is in flight: wait for its popstate first, otherwise it would hit the new entry.
    if (!this.win || this.#skipPops > 0) return;
    const open = this.#overlays.length > 0;
    if (open && !this.#marked) {
      this.#baseUrl = this.win.location.href;
      this.win.history.pushState(OVERLAY_STATE, '', this.#baseUrl);
      this.#marked = true;
    } else if (!open && this.#marked) {
      this.#marked = false;
      this.#leaveOverlayEntry();
    }
  }

  #leaveOverlayEntry() {
    this.#skipPops++;
    this.win!.history.back();
  }

  /** popstate comes here first: true if it was meant for the overlays and there is no page to show. */
  #onOverlayPop(): boolean {
    if (this.#skipPops > 0) {
      this.#skipPops--;
      // While the entry was on top, the URL may have changed (display, filters), or a new page came
      // whose entry waited for this popstate.
      const push = this.#pushAfterPop && this.#skipPops === 0;
      if (push) this.#pushAfterPop = false;
      this.syncUrl(push ? 'push' : 'replace');
      this.#syncOverlayEntry();
      return true;
    }
    if (this.#marked) {
      this.#marked = false;
      // Several steps back (history menu, long press): a real navigation, close everything.
      if (this.win!.location.href !== this.#baseUrl) {
        for (const entry of this.#overlays.splice(0).reverse()) entry.close();
        return false;
      }
      this.syncUrl('replace');
      // Release right away: dialogs with a fade-out release only after 90 ms and would count as open until then.
      this.#overlays.pop()?.close();
      this.#queueOverlaySync();
      return true;
    }
    // Forward onto an old overlay entry: nothing to show, go back right away.
    if (isOverlayState(this.win!.history.state)) {
      this.#leaveOverlayEntry();
      return true;
    }
    return false;
  }
}
