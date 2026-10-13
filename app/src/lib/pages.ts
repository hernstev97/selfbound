// Pages as separate chunks (code splitting): small start bundle; the detail page is preloaded when
// idle so Enter opens it at once. A module loaded once returns the same promise (no flicker).
// Main areas mount through components/Lazy.svelte (notice and "Try again" on failure).
import { Slice } from '@xlr8/core';
import { app } from '../app-instance.ts';

type Overlays = typeof import('../components/overlays.ts');
/** Overlays once loaded (the shell mounts them only then, without triggering the import). */
export const overlaysLoaded = new Slice<Overlays | null>(null);

type Loader<T> = () => Promise<T>;

function once<T>(load: Loader<T>): Loader<T> {
  let promise: Promise<T> | null = null;
  // Failed (offline, new version): forget it so the next call loads again.
  return () =>
    (promise ??= load().catch((error: unknown) => {
      promise = null;
      throw error;
    }));
}

const issuePage = once(() => import('../pages/IssuePage.svelte'));

export const pages = {
  issue: issuePage,
  /** Issue page with the frame for a PR beside it; the PR view loads PrHost only when opened */
  issueHost: once(() => Promise.all([issuePage(), import('../components/pr/PrHost.svelte')]).then(([page, host]) => ({ Page: page.default, Host: host.default }))),
  pr: once(() => import('../pages/PrPage.svelte')),
  projects: once(() => import('../pages/ProjectsPage.svelte')),
  drafts: once(() => import('../pages/DraftsPage.svelte')),
  /** Wiki: page and core logic (app.loadWiki) as separate chunks */
  wiki: once(() => Promise.all([import('../pages/wiki/WikiPage.svelte'), app.loadWiki()]).then(([m]) => m)),
  /** Context menu, create dialog, display options, peek */
  overlays: once(() =>
    import('../components/overlays.ts').then((m) => {
      overlaysLoaded.set(m);
      return m;
    }),
  ),
  perf: once(() => import('../components/PerfOverlay.svelte')),
  /** Board: its own chunk, preloaded when idle */
  board: once(() => import('../components/board/BoardView.svelte')),
  mobileBar: once(() => import('../components/MobileBar.svelte')),
  settings: once(() => import('../pages/SettingsPage.svelte')),
  settingsNav: once(() => import('../pages/settings/SettingsNav.svelte')),
  /** Header of the active sprint (goal, progress) and buttons in the top bar */
  // Sprint pages need core's sprint logic (its own chunk, app.loadSprints).
  sprintHeader: once(() => withSprints(import('../pages/sprint/header.ts'))),
  plan: once(() => withSprints(import('../pages/sprint/PlanPage.svelte'))),
  close: once(() => withSprints(import('../pages/sprint/ClosePage.svelte'))),
  sprints: once(() => withSprints(import('../pages/sprint/SprintsPage.svelte'))),
};

function withSprints<T>(page: Promise<T>): Promise<T> {
  return Promise.all([page, app.loadSprints()]).then(([m]) => m);
}

/** Preload what is often needed, when idle. */
export function preloadPages() {
  void pages.issueHost();
  void pages.board();
  // Sprint header only while a sprint runs (otherwise no list needs it).
  if (app.store.meta.get()?.sprints.some((s) => s.state === 'active')) void pages.sprintHeader();
}
