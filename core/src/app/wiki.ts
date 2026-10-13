// Wiki: pages per team as a tree, a page with text (like an issue description), trash. Its own
// chunk (app.loadWiki): start and sidebar load nothing of it. Data comes via subscriptions while a
// wiki page is open (`wiki.list` of the team, `wiki.get` of the page).
import { api } from '@xlr8/backend/api';
import type { FunctionReturnType } from 'convex/server';
import { BodyEditSession, type BodyEdit } from '../bodyEdit.ts';
import { actorName, fullDate, relativeTime } from '../format.ts';
import { intlLocale, t, tn } from '../i18n.ts';
import { Slice } from '../observable.ts';
import type { Page } from '../route.ts';
import type { TeamBadge } from '../types.ts';
import { ancestors, dropTarget, visibleRows, type DropPlace, type TreeRow } from '../wikiTree.ts';
import type { App } from './index.ts';
import { errorCode } from './toasts.ts';

/** A source when creating or changing it (as in the backend, lib/validators.ts). */
export interface SourceInput {
  url?: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  accessedAt?: string;
  note?: string;
}
export type SourcePatch = { [K in keyof SourceInput]?: K extends 'accessedAt' ? string : string | null };

type ListResult = FunctionReturnType<typeof api.wiki.list>;
type DetailResult = FunctionReturnType<typeof api.wiki.get>;
export type ArticleDoc = ListResult['articles'][number];
export type TrashEntry = FunctionReturnType<typeof api.wiki.trash>[number];

export interface ArticleView {
  id: string;
  title: string;
  teamKey: string;
  deleted: boolean;
  path: { id: string; title: string }[];
  children: { id: string; title: string }[];
  body: { markdown: string; version: number; updatedBy: string; updated: string; updatedFull: string };
  sources: { id: string; url: string | null; title: string | null; author: string | null; publishedAt: string | null; accessedAt: string; note: string | null }[];
  created: string;
  projectId: string | null;
  topicIds: string[];
}

export interface WikiFilter {
  projectId: string | null;
  topicId: string | null;
}

export interface WikiState {
  /** Team of the area; null = unknown (still loading or does not exist) */
  team: TeamBadge | null;
  /** The team has a wiki */
  enabled: boolean;
  /** Visible tree rows; null = still loading */
  rows: TreeRow[] | null;
  /** Number of pages */
  total: number;
  /** Recently changed pages (overview without a selected page) */
  recent: { id: string; title: string; updated: string }[];
  /** Selected page (ID from the URL) */
  articleId: string | null;
  /** undefined = loading, null = does not exist */
  article: ArticleView | null | undefined;
  /** Trash open: entries, null = loading */
  trash: TrashEntry[] | null | false;
  /** Topics and projects of the team (pickers, filter) */
  topics: { id: string; name: string; hue: number; archived: boolean }[];
  projects: { id: string; name: string }[];
  /** Tree filter (project, topic): then a flat list of the matching pages */
  filter: WikiFilter;
}

const NO_FILTER: WikiFilter = { projectId: null, topicId: null };
const EMPTY: WikiState = { team: null, enabled: false, rows: null, total: 0, recent: [], articleId: null, article: undefined, trash: false, topics: [], projects: [], filter: NO_FILTER };

const draftKey = (id: string) => `xlr8:article:${id}`;
/** This many pages stay subscribed (back, and back and forth in the tree without waiting). */
const CACHE_SIZE = 8;
const EXPANDED_KEY = 'xlr8:wikiExpanded';

export class WikiController {
  readonly state = new Slice<WikiState>(EMPTY);
  readonly #body: BodyEditSession;
  readonly edit: Slice<BodyEdit>;
  #list: { teamId: string; slice: Slice<ListResult | undefined>; release: () => void; stop: () => void } | null = null;
  #detail: { id: string; slice: Slice<DetailResult | undefined>; stop: () => void } | null = null;
  /** Subscriptions of single pages (recently open or prefetched on hover), oldest first. */
  #cache = new Map<string, { slice: Slice<DetailResult | undefined>; release: () => void }>();
  #trash: { teamId: string; slice: Slice<FunctionReturnType<typeof api.wiki.trash> | undefined>; release: () => void; stop: () => void } | null = null;
  #page: Page = { name: 'home' };
  #expanded: Set<string>;
  #filter: WikiFilter = NO_FILTER;

  constructor(private app: App) {
    this.#body = new BodyEditSession({
      draftKey,
      save: (id, text, base) => this.app.store.call(api.wiki.setBody, { id: id as never, markdown: text, baseVersion: base }),
      current: (id) => {
        const doc = this.#detail?.id === id ? this.#detail.slice.get() : undefined;
        return doc ? { markdown: doc.body.markdown, version: doc.body.version, by: this.#actor(doc.body.updatedBy) } : null;
      },
      errorCode,
      onError: (error, retry) => this.app.toasts.error(t('Page not saved'), error, retry),
      notify: (message) => this.app.toasts.show(message),
    });
    this.edit = this.#body.state;
    let saved: string[] = [];
    try {
      saved = JSON.parse(globalThis.localStorage?.getItem(EXPANDED_KEY) ?? '[]');
    } catch {
      saved = [];
    }
    this.#expanded = new Set(Array.isArray(saved) ? saved : []);
  }

  // ---------------------------------------------------------------- Page and subscriptions

  /** Called by the app controller after every page change. */
  onPage(page: Page) {
    this.#page = page;
    if (page.name !== 'article' || this.#body.editingId() !== page.id) this.#body.end(true);
    if (page.name === 'wiki') {
      this.#watchDetail(null);
      const team = this.app.store.meta.get()?.teams.find((t) => t.key === page.team);
      this.#watchList(team?._id ?? null);
    } else if (page.name === 'article') {
      this.#watchDetail(page.id);
      const teamId = this.#detail?.slice.get()?.article.teamId ?? null;
      if (teamId) this.#watchList(teamId);
    } else {
      this.#watchDetail(null);
      this.#watchList(null);
      this.closeTrash();
      for (const entry of this.#cache.values()) entry.release();
      this.#cache.clear();
    }
    this.refresh();
  }

  /** Subscription of a page from the cache (or new); keeps at most CACHE_SIZE, the shown one stays. */
  #acquire(id: string) {
    let entry = this.#cache.get(id);
    if (entry) this.#cache.delete(id);
    else entry = this.app.store.watch(api.wiki.get, { id });
    this.#cache.set(id, entry);
    for (const [key, old] of this.#cache) {
      if (this.#cache.size <= CACHE_SIZE) break;
      if (key === id || key === this.#detail?.id) continue;
      old.release();
      this.#cache.delete(key);
    }
    return entry;
  }

  /** Prefetches a page (mouse over a tree row) so the click shows it immediately. */
  prefetch(id: string) {
    if (this.#page.name === 'wiki' || this.#page.name === 'article') this.#acquire(id);
  }

  #watchList(teamId: string | null) {
    if (this.#list?.teamId === teamId) return;
    // Different team: filters no longer apply (projects and topics belong to one team).
    if (this.#list) this.#filter = NO_FILTER;
    this.#list?.stop();
    this.#list?.release();
    this.#list = null;
    if (this.#trash && this.#trash.teamId !== teamId) this.closeTrash();
    if (!teamId) return;
    const { slice, release } = this.app.store.watch(api.wiki.list, { teamId: teamId as never });
    this.#list = { teamId, slice, release, stop: slice.subscribe(() => this.refresh()) };
  }

  #watchDetail(id: string | null) {
    if (this.#detail?.id === id) return;
    this.#detail?.stop();
    this.#detail = null;
    if (!id) return;
    this.app.store.watchAgents();
    const { slice } = this.#acquire(id);
    const arrived = () => {
      const doc = slice.get();
      if (!doc) return;
      this.#watchList(doc.article.teamId);
      // The page's team becomes the sidebar's current team.
      if (doc.team && doc.team.key !== this.app.prefs.state.get().currentTeam) this.app.prefs.set({ currentTeam: doc.team.key });
      this.#body.check(id, { markdown: doc.body.markdown, version: doc.body.version, by: this.#actor(doc.body.updatedBy) });
    };
    this.#detail = {
      id,
      slice,
      stop: slice.subscribe(() => {
        arrived();
        this.refresh();
      }),
    };
    // Already prefetched: take it right away (the subscription reports only the next change).
    arrived();
  }

  #actor(actor: { kind: string; agentId?: string }) {
    return actorName(actor as never, this.app.store.agents.get());
  }

  /** Recomputes the state (subscriptions, metadata, expand/collapse). */
  refresh() {
    const page = this.#page;
    if (page.name !== 'wiki' && page.name !== 'article') {
      if (this.state.get() !== EMPTY) this.state.set(EMPTY);
      return;
    }
    const meta = this.app.store.meta.get();
    // Area opened before the metadata arrived: subscribe to the team now.
    if (page.name === 'wiki' && !this.#list) {
      const team = meta?.teams.find((t) => t.key === page.team);
      if (team) this.#watchList(team._id);
    }
    const doc = this.#detail?.slice.get();
    const teamDoc = page.name === 'wiki' ? meta?.teams.find((t) => t.key === page.team) : doc ? meta?.teams.find((t) => t._id === doc.article.teamId) : undefined;
    const list = this.#list?.slice.get();
    const articles = list?.articles ?? null;
    const articleId = page.name === 'article' ? page.id : null;
    if (articles && articleId) for (const id of ancestors(articles, articleId)) this.#expanded.add(id);
    const trash = this.#trash ? (this.#trash.slice.get() ?? null) : false;
    const filter = this.#filter;
    const filtered = filter.projectId || filter.topicId;
    const rows = articles
      ? filtered
        ? articles
            .filter((a) => (!filter.projectId || a.projectId === filter.projectId) && (!filter.topicId || a.topicIds.includes(filter.topicId as never)))
            .sort((a, b) => a.title.localeCompare(b.title, intlLocale()))
            .map((a) => ({ id: a._id, title: a.title, parentId: a.parentId ?? null, depth: 0, hasChildren: false, expanded: false }))
        : visibleRows(articles, this.#expanded)
      : teamDoc && !teamDoc.wiki
        ? []
        : null;
    this.state.set({
      team: teamDoc ? this.app.main.teamBadge(teamDoc._id) : null,
      enabled: !!teamDoc?.wiki,
      rows,
      total: articles?.length ?? 0,
      recent: articles
        ? [...articles]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 8)
            .map((a) => ({ id: a._id, title: a.title, updated: relativeTime(a.updatedAt) }))
        : [],
      articleId,
      article: page.name === 'article' ? (doc === undefined ? undefined : doc === null ? null : this.#view(doc)) : null,
      trash,
      topics: (list?.topics ?? []).map((t) => ({ id: t._id, name: t.name, hue: t.hue, archived: !!t.archived })).sort((a, b) => a.name.localeCompare(b.name, intlLocale())),
      projects: teamDoc ? (meta?.projects ?? []).filter((p) => p.teamId === teamDoc._id).map((p) => ({ id: p._id, name: p.name })) : [],
      filter,
    });
    if (typeof document !== 'undefined' && page.name === 'article' && doc) document.title = t('{title} · Knowledge · XLR8', { title: doc.article.title });
  }

  #view(doc: NonNullable<DetailResult>): ArticleView {
    return {
      id: doc.article._id,
      title: doc.article.title,
      teamKey: doc.team?.key ?? '?',
      deleted: doc.article.deletedAt !== undefined,
      path: doc.path.map((p) => ({ id: p.id, title: p.title })),
      children: [...doc.children].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((c) => ({ id: c.id, title: c.title })),
      body: {
        markdown: doc.body.markdown,
        version: doc.body.version,
        updatedBy: this.#actor(doc.body.updatedBy),
        updated: relativeTime(doc.body.updatedAt),
        updatedFull: fullDate(doc.body.updatedAt),
      },
      sources: doc.sources.map((s) => ({
        id: s._id,
        url: s.url ?? null,
        title: s.title ?? null,
        author: s.author ?? null,
        publishedAt: s.publishedAt ?? null,
        accessedAt: s.accessedAt,
        note: s.note ?? null,
      })),
      created: fullDate(doc.article.createdAt),
      projectId: doc.article.projectId ?? null,
      topicIds: doc.article.topicIds,
    };
  }

  /** Pages of the open team (for dragging and pickers). */
  articles(): readonly ArticleDoc[] {
    return this.#list?.slice.get()?.articles ?? [];
  }

  // ---------------------------------------------------------------- Tree

  toggle(id: string) {
    if (this.#expanded.has(id)) this.#expanded.delete(id);
    else this.#expanded.add(id);
    try {
      globalThis.localStorage?.setItem(EXPANDED_KEY, JSON.stringify([...this.#expanded].slice(-500)));
    } catch {
      // ignore
    }
    this.refresh();
  }

  open(id: string) {
    this.app.nav.go({ name: 'article', id });
  }

  /** New page (optionally as a subpage), opened afterwards; the title is selected for overwriting. */
  async create(parentId: string | null = null): Promise<string | null> {
    const teamId = this.#list?.teamId ?? this.app.store.meta.get()?.teams.find((t) => t.key === (this.#page.name === 'wiki' ? this.#page.team : ''))?._id;
    if (!teamId) return null;
    try {
      const { articleId } = await this.app.store.call(api.wiki.create, { teamId: teamId as never, title: t('New page'), ...(parentId ? { parentId: parentId as never } : {}) });
      if (parentId) this.#expanded.add(parentId);
      this.app.nav.go({ name: 'article', id: articleId });
      return articleId;
    } catch (error) {
      this.app.toasts.error(t('Page not created'), error);
      return null;
    }
  }

  async rename(id: string, title: string) {
    const trimmed = title.replace(/\s+/g, ' ').trim();
    const current = this.#detail?.slice.get();
    if (!trimmed || (current?.article._id === id && current.article.title === trimmed)) return;
    try {
      await this.app.store.call(api.wiki.update, { id: id as never, title: trimmed });
    } catch (error) {
      this.app.toasts.error(t('Title not saved'), error, () => void this.rename(id, title));
    }
  }

  /** Drops a dragged page before, after or inside another one. */
  async drop(id: string, target: string, place: DropPlace) {
    const move = dropTarget(this.articles(), id, target, place);
    if (!move) return;
    if (place === 'inside') this.#expanded.add(target);
    try {
      await this.app.store.call(api.wiki.move, {
        id: id as never,
        parentId: (move.parentId ?? null) as never,
        ...(move.beforeId ? { beforeId: move.beforeId as never } : {}),
        ...(move.afterId ? { afterId: move.afterId as never } : {}),
      });
    } catch (error) {
      this.app.toasts.error(t('Page not moved'), error);
    }
  }

  /** Moves to the trash (with subpages), with undo. */
  async remove(id: string) {
    const doc = this.#detail?.slice.get();
    const teamKey = doc?.article._id === id ? doc.team?.key : this.state.get().team?.key;
    try {
      const { removed } = await this.app.store.call(api.wiki.remove, { id: id as never });
      if (this.#page.name === 'article' && this.#page.id === id && teamKey) this.app.nav.go({ name: 'wiki', team: teamKey }, { replace: true });
      const text = removed > 1 ? tn(removed - 1, 'Page and {count} subpage moved to the trash', 'Page and {count} subpages moved to the trash') : t('Page moved to the trash');
      this.app.toasts.show(text, { label: t('Undo'), run: () => void this.restore(id) });
    } catch (error) {
      this.app.toasts.error(t('Page not deleted'), error);
    }
  }

  async restore(id: string) {
    try {
      const { movedToTop } = await this.app.store.call(api.wiki.restore, { id: id as never });
      if (movedToTop) this.app.toasts.show(t('Restored at the top level (the parent page is in the trash)'));
    } catch (error) {
      this.app.toasts.error(t('Page not restored'), error);
    }
  }

  openTrash() {
    const teamId = this.#list?.teamId;
    if (!teamId || this.#trash?.teamId === teamId) return;
    this.closeTrash();
    const { slice, release } = this.app.store.watch(api.wiki.trash, { teamId: teamId as never });
    this.#trash = { teamId, slice, release, stop: slice.subscribe(() => this.refresh()) };
    this.refresh();
  }

  closeTrash() {
    if (!this.#trash) return;
    this.#trash.stop();
    this.#trash.release();
    this.#trash = null;
    this.refresh();
  }

  /** Turns a team's wiki on or off (from the empty page or the settings). */
  async enable(teamId: string, on: boolean) {
    try {
      await this.app.store.call(api.teams.update, { teamId: teamId as never, wiki: on ? 'on' : null });
    } catch (error) {
      this.app.toasts.error(on ? t('Knowledge not turned on') : t('Knowledge not turned off'), error);
    }
  }

  // ---------------------------------------------------------------- Project, topics, sources, versions

  /** Restricts the tree to a project or topic (null = all). */
  setFilter(filter: Partial<WikiFilter>) {
    this.#filter = { ...this.#filter, ...filter };
    this.refresh();
  }

  async #call<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.app.toasts.error(what, error);
      return null;
    }
  }

  setProject(id: string, projectId: string | null) {
    return this.#call(t('Project not set'), () => this.app.store.call(api.wiki.update, { id: id as never, projectId: projectId as never }));
  }

  setTopics(id: string, topicIds: string[]) {
    return this.#call(t('Topics not set'), () => this.app.store.call(api.wiki.update, { id: id as never, topicIds: topicIds as never }));
  }

  /** New topic in the team of the open page; returns its ID. */
  async createTopic(name: string): Promise<string | null> {
    const teamId = this.#list?.teamId;
    if (!teamId || !name.trim()) return null;
    const result = await this.#call(t('Topic not created'), () => this.app.store.call(api.wiki.createTopic, { teamId: teamId as never, name }));
    return result?.topicId ?? null;
  }

  addSource(articleId: string, source: SourceInput) {
    return this.#call(t('Source not saved'), () => this.app.store.call(api.wiki.addSources, { articleId: articleId as never, sources: [source] }));
  }

  updateSource(sourceId: string, patch: SourcePatch) {
    return this.#call(t('Source not updated'), () => this.app.store.call(api.wiki.updateSource, { sourceId: sourceId as never, patch }));
  }

  removeSource(sourceId: string) {
    return this.#call(t('Source not removed'), () => this.app.store.call(api.wiki.removeSource, { sourceId: sourceId as never }));
  }

  /** Moves a source one place up (-1) or down (+1). */
  moveSource(articleId: string, sourceId: string, delta: -1 | 1) {
    const ids = this.state.get().article?.sources.map((s) => s.id) ?? [];
    const at = ids.indexOf(sourceId);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to]!, ids[at]!];
    return this.#call(t('Order not saved'), () => this.app.store.call(api.wiki.reorderSources, { articleId: articleId as never, sourceIds: ids as never }));
  }

  /** Restores an earlier version as the current text (itself reversible). */
  async restoreRevision(revisionId: string) {
    const view = this.state.get().article;
    if (!view) return;
    this.#body.end(true);
    const result = await this.#call(t('Version not restored'), () => this.app.store.call(api.wiki.restoreRevision, { revisionId: revisionId as never, baseVersion: view.body.version }));
    if (result?.changed) this.app.toasts.show(t('Version restored. The previous text is now in the version history.'));
  }

  // ---------------------------------------------------------------- Text

  startEdit() {
    const view = this.state.get().article;
    if (!view || view.deleted) return;
    this.#body.start(view.id, { markdown: view.body.markdown, version: view.body.version, by: view.body.updatedBy });
  }

  input(text: string) {
    this.#body.input(text);
  }

  save() {
    return this.#body.save();
  }

  keepMine() {
    this.#body.keepMine();
  }

  takeTheirs() {
    this.#body.takeTheirs();
  }

  finishEdit() {
    return this.#body.finish();
  }

  /** Saves the text directly (checking a task, a code block's language without the editor). */
  async setText(markdown: string, baseVersion: number) {
    const view = this.state.get().article;
    if (!view) return;
    try {
      await this.app.store.call(api.wiki.setBody, { id: view.id as never, markdown, baseVersion });
    } catch (error) {
      this.app.toasts.error(t('Page not saved'), error);
    }
  }

  /** The text if the page is being edited (for images that finished uploading). */
  editingText(id: string): string | null {
    return this.#body.editingId() === id ? this.edit.get().text : null;
  }
}
