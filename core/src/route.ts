// Routing by path: the view is in the path, filters and display options are query parameters.
//
//   /                      inbox or the last visited view
//   /inbox                 inbox
//   /snoozed               snoozed issues            /team/KIU/snoozed
//   /triage                triage (all teams)        /team/KIU/triage
//   /all /active /backlog  all teams                 /team/KIU/all, /team/KIU (= active), /team/KIU/backlog
//   /team/KIU/projects     a team's projects         /team/KIU/project/<id>
//   /team/KIU/wiki         a team's wiki             /wiki/<id> page (permanent address, no team; the older
//                          /wissen paths still parse, they are in links stored in issue texts, see backend/convex/shared/links.ts)
//   /issue/KIU-106         issue (full page)
//   /pr/<owner>/<repo>/12  pull request, full size
//   /sprint                active sprint             /sprint/plan[/<number>] planning, /sprint/close completion
//   /sprints               all sprints
//   /trash /drafts
//   /settings[/<section>[/<subpage>]]   older German section ids still work (SETTINGS_ALIAS)
//   /new?title=…&priority=high&status=todo&team=KIU&label=Bug&project=…   create an issue
//   /share?title=…&text=…&url=…  share from another app: main.ts turns it into /inbox before
//                          starting and creates the issue (app/src/lib/pwa/share.ts)
//
//   /oauth/consent?request=…  consent for a connector (claude.ai, ChatGPT); its own page outside
//                          the app shell, see isConsentPath (older address /oauth/freigabe)
//
// Extension point: a new page = a new case in `Page`, parsePath and pagePath.
import { emptyFilters } from './query.ts';
import type { Filters, Grouping, Ordering, Priority, ViewKind, ViewRoute } from './types.ts';

export type Page =
  | { name: 'home' }
  | { name: 'view'; view: ViewRoute }
  | { name: 'issue'; key: string }
  | { name: 'pr'; repo: string; number: number }
  | { name: 'projects'; team: string }
  | { name: 'wiki'; team: string }
  | { name: 'article'; id: string }
  | { name: 'drafts' }
  | { name: 'sprints' }
  | { name: 'settings'; section: string; sub?: string }
  | { name: 'new' };

export interface Location {
  page: Page;
  filters: Filters;
  quick: string;
  group: Grouping | null;
  /** Second grouping level (`?sub=`) */
  sub?: Grouping | null;
  order: Ordering | null;
  /** Board instead of list (`?layout=board`) */
  layout: 'board' | null;
  /** Only for /new: prefilled values */
  params: Record<string, string>;
}

const GLOBAL: Record<string, ViewKind> = { inbox: 'inbox', snoozed: 'snoozed', triage: 'triage', all: 'all', active: 'active', backlog: 'backlog', sprint: 'sprint', trash: 'trash' };
const TEAM_TABS: Record<string, ViewKind> = { '': 'active', all: 'all', active: 'active', backlog: 'backlog', triage: 'triage', sprint: 'sprint', snoozed: 'snoozed' };
const GROUPINGS: Grouping[] = ['status', 'team', 'priority', 'label', 'labelGroup', 'creator', 'estimate', 'due', 'project', 'sprint', 'parent', 'created', 'updated', 'scope', 'none'];
const ORDERINGS: Ordering[] = ['priority', 'rank', 'updated', 'created', 'due', 'status', 'snoozed'];
/** Settings section shown for /settings */
export const DEFAULT_SETTINGS_SECTION = 'general';
/** Older (German) settings section ids → current ids, so saved links keep working */
const SETTINGS_ALIAS: Record<string, string> = {
  allgemein: 'general',
  darstellung: 'appearance',
  benachrichtigungen: 'notifications',
  projekte: 'projects',
  wiederholungen: 'recurrences',
  agenten: 'agents',
  betrieb: 'ops',
};

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Consent page for connectors (OAuth). The app starts neither data nor navigation there. */
export const CONSENT_PATH = '/oauth/consent';
/** Older address of the consent page, still accepted */
const CONSENT_PATH_OLD = '/oauth/freigabe';
export const isConsentPath = (pathname: string) => {
  // No /\/+$/ here: on a long run of slashes that regex backtracks quadratically.
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === 47) end--;
  const path = pathname.slice(0, end);
  return path === CONSENT_PATH || path === CONSENT_PATH_OLD;
};

export function parsePath(pathname: string): Page {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  const [a, b, c, d, e] = parts;
  if (!a) return { name: 'home' };
  if (GLOBAL[a] && !b) return { name: 'view', view: { kind: GLOBAL[a], team: null } };
  if (a === 'sprint' && b === 'plan') return { name: 'view', view: { kind: 'plan', team: null, sprint: c && /^\d+$/.test(c) ? c : null } };
  if (a === 'sprint' && b === 'close' && !c) return { name: 'view', view: { kind: 'close', team: null } };
  if (a === 'sprints' && !b) return { name: 'sprints' };
  if (a === 'issue' && b) return { name: 'issue', key: b.toUpperCase() };
  if (a === 'pr' && b && c && d && /^\d{1,9}$/.test(d) && !e) return { name: 'pr', repo: `${b}/${c}`, number: Number(d) };
  if (a === 'new') return { name: 'new' };
  if (a === 'drafts') return { name: 'drafts' };
  // /wissen is the older German path, still found in stored links.
  if ((a === 'wiki' || a === 'wissen') && b && !c) return { name: 'article', id: b };
  if (a === 'settings') {
    const section = (b && SETTINGS_ALIAS[b]) || b || DEFAULT_SETTINGS_SECTION;
    return c ? { name: 'settings', section, sub: c } : { name: 'settings', section };
  }
  if (a === 'team' && b) {
    const team = b.toUpperCase();
    if (c === 'projects') return { name: 'projects', team };
    if ((c === 'wiki' || c === 'wissen') && !d) return { name: 'wiki', team };
    if (c === 'project' && d) return { name: 'view', view: { kind: 'project', team, project: d } };
    const kind = TEAM_TABS[c ?? ''];
    if (kind) return { name: 'view', view: { kind, team } };
  }
  return { name: 'home' };
}

export function viewPath(view: ViewRoute): string {
  if (view.kind === 'project') return `/team/${view.team}/project/${view.project}`;
  if (view.kind === 'plan' || view.kind === 'planned') return view.sprint ? `/sprint/plan/${view.sprint}` : '/sprint/plan';
  if (view.kind === 'close') return '/sprint/close';
  if (!view.team) return `/${view.kind}`;
  if (view.kind === 'active') return `/team/${view.team}`;
  return `/team/${view.team}/${view.kind}`;
}

export function pagePath(page: Page): string {
  switch (page.name) {
    case 'home':
      return '/';
    case 'view':
      return viewPath(page.view);
    case 'issue':
      return `/issue/${page.key}`;
    case 'pr':
      return `/pr/${page.repo.split('/').map(encodeURIComponent).join('/')}/${page.number}`;
    case 'projects':
      return `/team/${page.team}/projects`;
    case 'wiki':
      return `/team/${page.team}/wiki`;
    case 'article':
      return `/wiki/${encodeURIComponent(page.id)}`;
    case 'drafts':
      return '/drafts';
    case 'sprints':
      return '/sprints';
    case 'settings':
      if (page.sub) return `/settings/${page.section}/${encodeURIComponent(page.sub)}`;
      return page.section && page.section !== DEFAULT_SETTINGS_SECTION ? `/settings/${page.section}` : '/settings';
    case 'new':
      return '/new';
  }
}

const NEW_PARAMS = ['title', 'description', 'status', 'priority', 'team', 'label', 'project', 'estimate', 'due'];

export function readLocation(url: URL): Location {
  const p = url.searchParams;
  const page = parsePath(url.pathname);
  const filters: Filters = {
    ...emptyFilters(),
    // Status names, or older links with status type keys (in_progress …)
    status: list(p.get('status')).map((s) => s.trim().toLowerCase()).filter(Boolean),
    priority: list(p.get('prio'))
      .map(Number)
      .filter((n): n is Priority => n >= 0 && n <= 4),
    team: list(p.get('fteam')).map((k) => k.toUpperCase()),
    label: list(p.get('label')),
    project: list(p.get('project')),
    sprint: list(p.get('sprint')),
    unreviewed: p.get('unreviewed') === '1',
    snoozed: p.get('snoozed') === '1',
  };
  const group = p.get('group') as Grouping | null;
  const sub = p.get('sub') as Grouping | null;
  const order = p.get('order') as Ordering | null;
  // Only the keys `openFromParams` (core/src/app/create.ts) reads, so a name from the URL never becomes a property name.
  const params: Record<string, string> =
    page.name === 'new' ? Object.fromEntries([...p].filter(([k]) => NEW_PARAMS.includes(k))) : {};
  return {
    page,
    filters: page.name === 'new' ? emptyFilters() : filters,
    quick: page.name === 'new' ? '' : (p.get('q') ?? ''),
    group: group && GROUPINGS.includes(group) ? group : null,
    sub: sub && GROUPINGS.includes(sub) ? sub : null,
    order: order && ORDERINGS.includes(order) ? order : null,
    layout: p.get('layout') === 'board' ? 'board' : null,
    params,
  };
}

/**
 * Readable labels in the URL: the name instead of the id if the name is unique and has no comma,
 * else the id. Reading accepts both (old links with ids stay valid), see `labelIdsFrom`.
 */
export function labelParam(id: string, labels: readonly { _id: string; name: string }[]): string {
  const label = labels.find((l) => l._id === id);
  if (!label || label.name.includes(',')) return id;
  const lower = label.name.toLowerCase();
  return labels.filter((l) => l.name.toLowerCase() === lower).length === 1 ? label.name : id;
}

/** Label values from the URL (names or ids) → ids; unknown values stay (reference data may be missing still). */
export function labelIdsFrom(values: readonly string[], labels: readonly { _id: string; name: string }[]): string[] {
  return values.map((v) => {
    if (labels.some((l) => l._id === v)) return v;
    const lower = v.toLowerCase();
    const hits = labels.filter((l) => l.name.toLowerCase() === lower);
    return hits.length === 1 ? hits[0]._id : v;
  });
}

/** URL for a page; filters and display options only for lists. Other parameters (e.g. perf) stay. */
export function writeLocation(base: URL, loc: Pick<Location, 'page' | 'filters' | 'quick' | 'group' | 'sub' | 'order'> & { layout?: 'board' | null }, labels: readonly { _id: string; name: string }[] = []): URL {
  const url = new URL(base);
  url.pathname = pagePath(loc.page);
  const p = url.searchParams;
  for (const key of ['status', 'prio', 'fteam', 'label', 'project', 'sprint', 'unreviewed', 'snoozed', 'q', 'group', 'sub', 'order', 'layout', 'title', 'priority', 'team', 'description', 'estimate', 'due']) p.delete(key);
  if (loc.page.name === 'view') {
    const set = (key: string, value: string | null | undefined) => (value ? p.set(key, value) : p.delete(key));
    const f = loc.filters;
    set('status', f.status.join(','));
    set('prio', f.priority.join(','));
    set('fteam', f.team.join(','));
    set('label', f.label.map((id) => labelParam(id, labels)).join(','));
    set('project', f.project.join(','));
    set('sprint', f.sprint.join(','));
    set('unreviewed', f.unreviewed ? '1' : null);
    set('snoozed', f.snoozed ? '1' : null);
    set('q', loc.quick);
    set('group', loc.group);
    set('sub', loc.sub);
    set('order', loc.order);
    set('layout', loc.layout);
  }
  return url;
}

export function samePage(a: Page, b: Page) {
  return pagePath(a) === pagePath(b);
}
