import { haystackOf } from '../src/haystack.ts';
import { afterEach, describe, expect, test } from 'vitest';
import { computeList, computeVisible, emptyFilters, reuseList } from '../src/query.ts';
import { IssueSearch, identifierCandidates, loadFuzzy, scoreText } from '../src/search.ts';

// The app loads uFuzzy lazily; the tests load it up front.
await loadFuzzy();
import { computeWindow, revealIndex } from '../src/window.ts';
import { isConsentPath, pagePath, readLocation, writeLocation } from '../src/route.ts';
import { VIEWS, type ViewContext } from '../src/views.ts';
import { actorName, branchName, initials, nameHue, dayLabel, dueLabel, fullDate, monthLabel, parseDueInput, relativeTime, shortDate } from '../src/format.ts';
import { setDictionary } from '../src/i18n.ts';
import de from '../src/locales/de.ts';
import { eventCombo, formatShortcut } from '../src/keyboard.ts';
import { isOwnerKind, LEGACY_OWNER_KIND, OWNER_KIND, type Issue, type IssueDoc, type ViewRoute, type ViewState } from '../src/types.ts';
import { doc, entry, meta } from './helpers.ts';

const keyOf = (d: IssueDoc) => `${d.teamId === 't1' ? 'ACME' : 'PX'}-${d.number}`;
const enrich = (d: IssueDoc): Issue => Object.freeze({ ...d, key: keyOf(d), haystack: `${keyOf(d)} ${d.title}`.toLowerCase() }) as Issue;
/** An issue with its open inbox entry, as the store merges it. */
const inInbox = (d: IssueDoc, patch: Partial<Issue['inbox'] & object> = {}): Issue => ({ ...enrich(d), inbox: entry(d._id, patch) });
const all = Array.from({ length: 200 }, (_, i) => enrich(doc(i, i === 7 ? { deletedAt: 5 } : i === 9 ? { status: 'triage' } : {})));
const ctx = (patch: Partial<ViewContext> = {}): ViewContext => ({ teamId: null, activeSprintId: 's4', projectId: null, keep: new Set(), ...patch });
function view(route: ViewRoute, patch: Partial<ViewState> = {}): ViewState {
  return { route, filters: emptyFilters(), quick: '', quickOpen: false, display: VIEWS[route.kind].display(route), ...patch };
}

describe('views and filters', () => {
  test('deleted issues only in the trash, triage in "All" (list) but not on the board', () => {
    const visible = computeVisible(all, view({ kind: 'all', team: null }), meta, ctx());
    expect(visible.find((i) => i._id === 'i7')).toBeUndefined();
    expect(visible.find((i) => i._id === 'i9')).toBeDefined();
    expect(computeVisible(all, view({ kind: 'all', team: null }), meta, ctx({ board: true })).find((i) => i._id === 'i9')).toBeUndefined();
    // Active and backlog stay without triage.
    expect(computeVisible(all, view({ kind: 'active', team: null }), meta, ctx()).find((i) => i._id === 'i9')).toBeUndefined();
    expect(computeVisible(all, view({ kind: 'backlog', team: null }), meta, ctx()).find((i) => i._id === 'i9')).toBeUndefined();
    const trash = computeVisible(all, view({ kind: 'trash', team: null }), meta, ctx());
    expect(trash.map((i) => i._id)).toEqual(['i7']);
    const triage = computeVisible(all, view({ kind: 'triage', team: null }), meta, ctx());
    expect(triage.map((i) => i._id)).toEqual(['i9']);
  });

  test('team, backlog, active', () => {
    const backlog = computeVisible(all, view({ kind: 'backlog', team: 'PX' }), meta, ctx({ teamId: 't2' }));
    expect(backlog.length).toBeGreaterThan(0);
    expect(backlog.every((i) => i.status === 'backlog' && i.teamId === 't2')).toBe(true);
    expect(computeVisible(all, view({ kind: 'backlog', team: 'ACME' }), meta, ctx({ teamId: 't1' }))).toEqual([]);
    const active = computeVisible(all, view({ kind: 'active', team: null }), meta, ctx());
    expect(active.every((i) => ['todo', 'in_progress', 'in_review'].includes(i.status))).toBe(true);
  });

  test('inbox: issues with an open entry, read ones stay; the "Unread" filter keeps the ones read during this visit', () => {
    const issues = [
      inInbox(doc(1)),
      enrich(doc(2)),
      { ...inInbox(doc(3)), deletedAt: 1 },
      inInbox(doc(4), { readAt: 5 }),
      inInbox(doc(5), { readAt: 5 }),
    ];
    const inbox = view({ kind: 'inbox', team: null });
    expect(computeVisible(issues, inbox, meta, ctx()).map((i) => i._id).sort()).toEqual(['i1', 'i4', 'i5']);
    const unreadOnly = { ...inbox, filters: { ...inbox.filters, unreviewed: true } };
    expect(computeVisible(issues, unreadOnly, meta, ctx()).map((i) => i._id)).toEqual(['i1']);
    expect(computeVisible(issues, unreadOnly, meta, ctx({ keep: new Set(['i4' as never]) })).map((i) => i._id).sort()).toEqual(['i1', 'i4']);
  });

  test('inbox: newest activity first, so an agent\'s new change moves an old entry to the top', () => {
    const issues = [inInbox(doc(1), { updatedAt: 10 }), inInbox(doc(2), { updatedAt: 50 }), inInbox(doc(3), { updatedAt: 30 })];
    const inbox = view({ kind: 'inbox', team: null });
    expect(inbox.display.ordering).toBe('created');
    expect(computeVisible(issues, inbox, meta, ctx()).map((i) => i._id)).toEqual(['i2', 'i3', 'i1']);
    // The other orderings still sort by the issue.
    const updated = { ...inbox, display: { ...inbox.display, ordering: 'updated' as const } };
    expect(computeVisible(issues, updated, meta, ctx()).map((i) => i._id)).toEqual(['i3', 'i2', 'i1']);
  });

  test('filters: priority, label, project "none", ordering by priority', () => {
    const v = view({ kind: 'all', team: null }, { filters: { ...emptyFilters(), priority: [2], label: ['l1'] } });
    const visible = computeVisible(all, v, meta, ctx());
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((i) => i.priority === 2 && i.labelIds.includes('l1' as never))).toBe(true);
    const none = computeVisible(all, view({ kind: 'all', team: null }, { filters: { ...emptyFilters(), project: ['none'] } }), meta, ctx());
    expect(none.length).toBe(all.length - 1);
  });

  test('hide closed issues', () => {
    const v = view({ kind: 'all', team: null });
    v.display = { ...v.display, showClosed: false };
    expect(computeVisible(all, v, meta, ctx()).some((i) => i.status === 'done')).toBe(false);
  });

  test('quick search over identifier and title', () => {
    const v = view({ kind: 'all', team: null }, { quick: 'acme-11 ' });
    const visible = computeVisible(all, v, meta, ctx());
    expect(visible.map((i) => i.key)).toContain('ACME-11');
    expect(visible.every((i) => haystackOf(i).includes('acme-11'))).toBe(true);
  });

  test('groups: status order, team, collapsed', () => {
    const v = view({ kind: 'all', team: 'ACME' });
    const visible = computeVisible(all, v, meta, ctx({ teamId: 't1' }));
    const list = computeList(visible, v, meta, new Set());
    expect(list.rows[0]).toMatchObject({ kind: 'group', group: { status: 'in_progress', label: 'In Progress', value: 'started:in progress' } });
    expect(list.rows.filter((r) => r.kind === 'group').map((r) => r.kind === 'group' && r.group.label)).toEqual(['In Progress', 'Todo']);
    expect(list.keyChars).toBe('ACME-199'.length);
    const collapsed = computeList(visible, v, meta, new Set(['g:status:started:in progress']));
    const first = collapsed.rows[0];
    expect(first.kind === 'group' && first.collapsed).toBe(true);
    expect(collapsed.rows[1].kind).toBe('group');
    expect(collapsed.count).toBe(list.count);
    const byTeam = computeList(computeVisible(all, view({ kind: 'all', team: null }), meta, ctx()), view({ kind: 'all', team: null }), meta, new Set());
    expect(byTeam.rows.filter((r) => r.kind === 'group').map((r) => r.kind === 'group' && r.group.label)).toEqual(['Acme', 'Pixelwerk']);
    expect(reuseList(list, computeList(visible, v, meta, new Set()))).toBe(list);
  });

  test('empty state tells filters and missing data apart', () => {
    const v = view({ kind: 'all', team: null }, { quick: 'does not exist' });
    expect(computeList(computeVisible(all, v, meta, ctx()), v, meta, new Set()).empty).toBe('filtered');
    expect(computeList([], view({ kind: 'all', team: null }), meta, new Set()).empty).toBe('none');
  });
});

describe('search (identifiers with 2–6 characters)', () => {
  const issues = [
    enrich(doc(105, { teamId: 't1' as never, number: 106, title: 'Landing page' })),
    enrich(doc(11, { teamId: 't2' as never, number: 12, title: 'Pixel' })),
    Object.freeze({ ...doc(300, { number: 7, title: 'Mosaik topic' }), key: 'MOSAIK-7', haystack: 'mosaik-7 mosaik topic' }) as Issue,
  ];
  const search = new IssueSearch();
  search.prepare(1, [...issues, ...all]);

  test.each([
    ['acme106', 'ACME-106'],
    ['ACME-106', 'ACME-106'],
    ['acme 106', 'ACME-106'],
    ['px12', 'PX-12'],
    ['PX-12', 'PX-12'],
    ['mosaik7', 'MOSAIK-7'],
    ['Mosaik-7', 'MOSAIK-7'],
  ])('%s → %s', (q, key) => {
    expect(search.search(q)[0].key).toBe(key);
    expect(search.exact(q)?.key).toBe(key);
  });

  test('candidates: keys with digits are all tried', () => {
    expect(identifierCandidates('ab12')).toEqual(['AB-12', 'AB1-2']);
    expect(identifierCandidates('acme-106')).toEqual(['ACME-106']);
    expect(identifierCandidates('x1')).toEqual([]);
    expect(identifierCandidates('toolong7')).toEqual([]);
  });

  test('fuzzy over the title, deleted ones are missing', () => {
    expect(search.search('numbr 15').length).toBeGreaterThan(0);
    expect(search.search('Issue number 7').some((i) => i._id === 'i7')).toBe(false);
    expect(scoreText('Status: In progress in arbeit', 'arbeit')).toBeGreaterThan(0);
    expect(scoreText('Priority: High', 'prog')).toBe(0);
  });
});

describe('windowing', () => {
  test('fixed row height of 44 px', () => {
    expect(computeWindow(0, 440, 44, 10_000, 6)).toEqual({ start: 0, end: 17 });
    expect(computeWindow(4400, 440, 44, 10_000, 6)).toEqual({ start: 94, end: 117 });
    expect(computeWindow(0, 440, 44, 5, 6)).toEqual({ start: 0, end: 5 });
  });
  test('unknown height: window height instead of a flat 40 entries', () => {
    const before = globalThis.innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 900;
    expect(computeWindow(0, 0, 44, 10_000, 6).end).toBe(Math.ceil(900 / 44) + 1 + 6);
    expect(computeWindow(0, 0, 44, 0, 6)).toEqual({ start: 0, end: 0 });
    (globalThis as { innerHeight?: number }).innerHeight = before;
  });
  test('scrolled far past the end: no empty or negative window', () => {
    const r = computeWindow(1_000_000, 440, 44, 50, 6);
    expect(r.start).toBeLessThanOrEqual(r.end);
    expect(r.end).toBe(50);
  });
  test('revealIndex scrolls only as far as needed', () => {
    const el = { scrollTop: 0, clientHeight: 440 };
    revealIndex(el, 12, 44);
    expect(el.scrollTop).toBe(13 * 44 - 440);
    revealIndex(el, 0, 44);
    expect(el.scrollTop).toBe(0);
  });
});

describe('routing by path', () => {
  const at = (path: string) => readLocation(new URL(`http://x${path}`));
  test.each([
    ['/', { name: 'home' }],
    ['/inbox', { name: 'view', view: { kind: 'inbox', team: null } }],
    ['/triage', { name: 'view', view: { kind: 'triage', team: null } }],
    ['/all', { name: 'view', view: { kind: 'all', team: null } }],
    ['/team/ACME', { name: 'view', view: { kind: 'active', team: 'ACME' } }],
    ['/team/acme/backlog', { name: 'view', view: { kind: 'backlog', team: 'ACME' } }],
    ['/team/ACME/projects', { name: 'projects', team: 'ACME' }],
    ['/team/ACME/project/p1', { name: 'view', view: { kind: 'project', team: 'ACME', project: 'p1' } }],
    ['/issue/acme-106', { name: 'issue', key: 'ACME-106' }],
    ['/trash', { name: 'view', view: { kind: 'trash', team: null } }],
    ['/sprint', { name: 'view', view: { kind: 'sprint', team: null } }],
    ['/settings', { name: 'settings', section: 'general' }],
    ['/settings/appearance', { name: 'settings', section: 'appearance' }],
    ['/settings/ops', { name: 'settings', section: 'ops' }],
    ['/settings/teams', { name: 'settings', section: 'teams' }],
    ['/settings/teams/NOVA', { name: 'settings', section: 'teams', sub: 'NOVA' }],
    ['/sprint/plan', { name: 'view', view: { kind: 'plan', team: null, sprint: null } }],
    ['/sprint/plan/5', { name: 'view', view: { kind: 'plan', team: null, sprint: '5' } }],
    ['/sprint/close', { name: 'view', view: { kind: 'close', team: null } }],
    ['/sprints', { name: 'sprints' }],
    ['/new', { name: 'new' }],
    ['/pr/acme/widgets/57', { name: 'pr', repo: 'acme/widgets', number: 57 }],
    ['/pr/acme/acme.dev/3', { name: 'pr', repo: 'acme/acme.dev', number: 3 }],
    ['/pr/acme/widgets', { name: 'home' }],
    ['/pr/acme/widgets/abc', { name: 'home' }],
    ['/does/not/exist', { name: 'home' }],
  ])('%s', (path, page) => {
    expect(at(path).page).toEqual(page);
    // Canonical paths come back unchanged.
    if (page.name !== 'home' && page.name !== 'new' && !/[a-z]+-\d|\/acme\//.test(path)) expect(pagePath(at(path).page)).toBe(path);
  });

  test.each([
    ['allgemein', 'general'],
    ['darstellung', 'appearance'],
    ['benachrichtigungen', 'notifications'],
    ['projekte', 'projects'],
    ['wiederholungen', 'recurrences'],
    ['agenten', 'agents'],
    ['betrieb', 'ops'],
  ])('older settings id /settings/%s → %s', (old, section) => {
    const page = at(`/settings/${old}`).page;
    expect(page).toEqual({ name: 'settings', section });
    expect(pagePath(page)).toBe(section === 'general' ? '/settings' : `/settings/${section}`);
    expect(at(`/settings/${old}/sub`).page).toEqual({ name: 'settings', section, sub: 'sub' });
  });

  test('wiki pages under the new and the older /wissen paths', () => {
    const id = 'k57abcdefghijklmnop';
    expect(at(`/wiki/${id}`).page).toEqual({ name: 'article', id });
    expect(at(`/wissen/${id}`).page).toEqual({ name: 'article', id });
    expect(pagePath(at(`/wissen/${id}`).page)).toBe(`/wiki/${id}`);
    expect(at('/team/acme/wissen').page).toEqual({ name: 'wiki', team: 'ACME' });
    expect(pagePath(at('/team/ACME/wissen').page)).toBe('/team/ACME/wiki');
  });

  test('consent page under the new and the old address', () => {
    expect(isConsentPath('/oauth/consent')).toBe(true);
    expect(isConsentPath('/oauth/consent/')).toBe(true);
    expect(isConsentPath('/oauth/freigabe')).toBe(true);
    expect(isConsentPath('/oauth')).toBe(false);
    expect(isConsentPath('/oauth/consent/x')).toBe(false);
    expect(isConsentPath('/oauth/consent///')).toBe(true);
    expect(isConsentPath('///')).toBe(false);
  });

  test('a long run of slashes does not stall the consent check', () => {
    const start = performance.now();
    expect(isConsentPath(`${'/'.repeat(200_000)}x`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test('filters and display survive the trip through the URL, other parameters stay', () => {
    const filters = { ...emptyFilters(), status: ['todo' as const], priority: [1 as const, 2 as const], label: ['l1'], unreviewed: true };
    const url = writeLocation(new URL('http://x/?perf=1'), { page: { name: 'view', view: { kind: 'all', team: 'ACME' } }, filters, quick: 'abc', group: 'priority', order: null });
    expect(url.pathname).toBe('/team/ACME/all');
    expect(url.searchParams.get('perf')).toBe('1');
    const back = readLocation(url);
    expect(back.filters).toEqual(filters);
    expect(back.quick).toBe('abc');
    expect(back.group).toBe('priority');
  });

  test('/new with prefilled values', () => {
    const loc = at('/new?title=Test&priority=high&team=ACME');
    expect(loc.page).toEqual({ name: 'new' });
    expect(loc.params).toEqual({ title: 'Test', priority: 'high', team: 'ACME' });
  });

  test('/new keeps only the known parameters, names from the URL never become properties', () => {
    const loc = at('/new?title=Test&__proto__=x&constructor=y&toString=z&other=1');
    expect(loc.params).toEqual({ title: 'Test' });
    expect(Object.getPrototypeOf(loc.params)).toBe(Object.prototype);
    expect(at('/issue/ACME-1?title=Test').params).toEqual({});
  });
});

describe('odds and ends', () => {
  test('due date from free input (German words)', () => {
    const now = new Date(2026, 9, 9, 12).getTime(); // Fri, Oct 9, 2026
    expect(parseDueInput('heute', now)).toBe('2026-10-09');
    expect(parseDueInput('morgen', now)).toBe('2026-10-10');
    expect(parseDueInput('fr', now)).toBe('2026-10-16');
    expect(parseDueInput('mo', now)).toBe('2026-10-12');
    expect(parseDueInput('12.10.', now)).toBe('2026-10-12');
    expect(parseDueInput('1.1.', now)).toBe('2027-01-01');
    expect(parseDueInput('24.12.2027', now)).toBe('2027-12-24');
    expect(parseDueInput('+3', now)).toBe('2026-10-12');
    expect(parseDueInput('31.2.', now)).toBeNull();
    expect(parseDueInput('quatsch', now)).toBeNull();
    expect(parseDueInput('übermorgen', now)).toBe('2026-10-11');
    expect(parseDueInput('nächste woche', now)).toBe('2026-10-12');
    expect(parseDueInput('naechste woche', now)).toBe('2026-10-12');
    expect(parseDueInput('in 3 tagen', now)).toBe('2026-10-12');
    expect(parseDueInput('+3 t', now)).toBe('2026-10-12');
    expect(parseDueInput('2 wochen', now)).toBe('2026-10-23');
    expect(parseDueInput('2w', now)).toBe('2026-10-23');
    expect(parseDueInput('Freitag', now)).toBe('2026-10-16');
    expect(parseDueInput('So.', now)).toBe('2026-10-11');
    expect(parseDueInput('do', now)).toBe('2026-10-15');
    expect(parseDueInput('12. okt', now)).toBe('2026-10-12');
    expect(parseDueInput('3. März', now)).toBe('2027-03-03');
  });

  test('due date from free input (English words)', () => {
    const now = new Date(2026, 9, 9, 12).getTime(); // Fri, Oct 9, 2026
    expect(parseDueInput('today', now)).toBe('2026-10-09');
    expect(parseDueInput('Tomorrow', now)).toBe('2026-10-10');
    expect(parseDueInput('day after tomorrow', now)).toBe('2026-10-11');
    expect(parseDueInput('next week', now)).toBe('2026-10-12');
    expect(parseDueInput('fri', now)).toBe('2026-10-16');
    expect(parseDueInput('monday', now)).toBe('2026-10-12');
    expect(parseDueInput('tue', now)).toBe('2026-10-13');
    expect(parseDueInput('thurs', now)).toBe('2026-10-15');
    expect(parseDueInput('sun', now)).toBe('2026-10-11');
    expect(parseDueInput('in 3 days', now)).toBe('2026-10-12');
    expect(parseDueInput('3d', now)).toBe('2026-10-12');
    expect(parseDueInput('in 2 weeks', now)).toBe('2026-10-23');
    expect(parseDueInput('2026-10-12', now)).toBe('2026-10-12');
    expect(parseDueInput('oct 12', now)).toBe('2026-10-12');
    expect(parseDueInput('October 12, 2027', now)).toBe('2027-10-12');
    expect(parseDueInput('12 dec', now)).toBe('2026-12-12');
    expect(parseDueInput('jan 1', now)).toBe('2027-01-01');
    expect(parseDueInput('feb 30', now)).toBeNull();
    expect(parseDueInput('nonsense 12', now)).toBeNull();
  });

  test('initials: first letters of the first and last word, upper case', () => {
    expect(initials('Jane Q. Doe')).toBe('JD');
    expect(initials('  jane ')).toBe('J');
    expect(initials('Élodie Çelik')).toBe('ÉÇ');
    expect(initials('😀 Smile')).toBe('😀S');
    expect(initials('   ')).toBe('');
    expect(nameHue('Jane')).toBe(nameHue('Jane'));
    expect(nameHue('Jane')).toBeGreaterThanOrEqual(0);
    expect(nameHue('Jane')).toBeLessThan(360);
  });

  test('the owner shows as "You" ("Du" in German)', () => {
    const agents = new Map([['a1', 'Claude Code']]);
    expect(actorName({ kind: OWNER_KIND }, agents)).toBe('You');
    expect(actorName({ kind: OWNER_KIND }, agents, 'Jane')).toBe('Jane');
    expect(actorName({ kind: 'agent', agentId: 'a1' } as never, agents)).toBe('Claude Code');
    // A profile name replaces "You"
    expect(actorName({ kind: OWNER_KIND }, new Map([...agents, [OWNER_KIND, 'Jane Doe']]))).toBe('Jane Doe');
    setDictionary('de', de);
    expect(actorName({ kind: OWNER_KIND }, agents)).toBe('Du');
    setDictionary('en', null);
  });

  test('legacy owner kind is the owner too, with the profile name from the same map key', () => {
    // legacy-xlr8: data not yet migrated still says "steven"
    const legacy = { kind: LEGACY_OWNER_KIND } as const;
    expect(isOwnerKind(OWNER_KIND) && isOwnerKind(LEGACY_OWNER_KIND) && !isOwnerKind('agent')).toBe(true);
    expect(actorName(legacy, new Map())).toBe('You');
    expect(actorName(legacy, new Map([[OWNER_KIND, 'Jane Doe']]))).toBe('Jane Doe');
    expect(actorName(legacy, new Map(), 'Jane')).toBe('Jane');
  });

  test('suggested branch name: no prefix by default, optional prefix', () => {
    expect(branchName('ACME-106', 'Größere Übersicht für Ärzte & Co.')).toBe('acme-106-groessere-uebersicht-fuer-aerzte-co');
    expect(branchName('ACME-106', 'Fix login', 'jane')).toBe('jane/acme-106-fix-login');
    expect(branchName('ACME-106', 'Fix login', 'jane/')).toBe('jane/acme-106-fix-login');
    expect(branchName('ACME-106', 'Fix login', '')).toBe('acme-106-fix-login');
    expect(branchName('ACME-7', '!!!')).toBe('acme-7');
  });

  test('keyboard combos', () => {
    const key = (init: Partial<KeyboardEvent>) => eventCombo({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '', ...init } as KeyboardEvent);
    expect(key({ key: 'k', ctrlKey: true })).toBe('mod+k');
    expect(key({ key: 'V', shiftKey: true })).toBe('shift+v');
    expect(key({ key: '?', shiftKey: true })).toBe('?');
    expect(key({ key: ' ' })).toBe('space');
    expect(key({ key: 'Z', ctrlKey: true, shiftKey: true })).toBe('mod+shift+z');
    // Ctrl Shift . on a German keyboard yields ":" – still counts as a period.
    expect(key({ key: ':', code: 'Period', ctrlKey: true, shiftKey: true })).toBe('mod+shift+.');
    expect(key({ key: 'Backspace', ctrlKey: true })).toBe('mod+backspace');
    expect(formatShortcut('g i')).toBe('G then I');
  });
});

describe('dates and times by language', () => {
  const now = new Date(2026, 9, 9, 12).getTime(); // Fri, Oct 9, 2026
  afterEach(() => setDictionary('en', null));

  test('English', () => {
    setDictionary('en', null);
    expect(shortDate(new Date(2026, 9, 8).getTime(), now)).toBe('Oct 8');
    expect(shortDate(new Date(2025, 2, 3).getTime(), now)).toBe('Mar 3, 2025');
    expect(dayLabel('2026-10-16', now)).toBe('Fri, Oct 16');
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(dueLabel('2026-10-09', now)).toEqual({ label: 'Today', overdue: false, soon: true });
    expect(dueLabel('2026-10-10', now).label).toBe('Tomorrow');
    expect(dueLabel('2026-10-08', now)).toEqual({ label: 'Yesterday', overdue: true, soon: false });
    expect(dueLabel('2026-10-13', now).label).toBe('Tue');
    expect(dueLabel('2026-10-30', now).label).toBe('Oct 30');
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(relativeTime(now - 3_600_000, now)).toBe('1 hour ago');
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday');
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago');
    expect(relativeTime(now - 65 * 86_400_000, now)).toBe('2 months ago');
    expect(fullDate(new Date(2026, 9, 8, 14, 5).getTime())).toMatch(/^October 8, 2026.*2:05/);
  });

  test('German, as before', () => {
    setDictionary('de', de);
    expect(shortDate(new Date(2026, 9, 8).getTime(), now)).toBe('8. Okt.');
    expect(shortDate(new Date(2025, 2, 3).getTime(), now)).toBe('3. März 2025');
    expect(dayLabel('2026-10-16', now)).toBe('Fr., 16. Okt.');
    expect(dayLabel('2027-01-04', now)).toBe('Mo., 4. Jan. 2027');
    expect(monthLabel('2026-10')).toBe('Oktober 2026');
    expect(dueLabel('2026-10-09', now).label).toBe('Heute');
    expect(dueLabel('2026-10-10', now).label).toBe('Morgen');
    expect(dueLabel('2026-10-08', now).label).toBe('Gestern');
    expect(dueLabel('2026-10-13', now).label).toBe('Di');
    expect(dueLabel('2026-10-30', now).label).toBe('30. Okt.');
    expect(relativeTime(now - 10_000, now)).toBe('gerade eben');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('vor 5 Min.');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('vor 3 Std.');
    expect(relativeTime(now - 86_400_000, now)).toBe('gestern');
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('vor 4 Tagen');
    expect(relativeTime(now - 65 * 86_400_000, now)).toBe('vor 2 Mon.');
    expect(fullDate(new Date(2026, 9, 8, 14, 5).getTime())).toBe('8. Oktober 2026, 14:05');
    expect(formatShortcut('mod+shift+z')).toMatch(/^(Strg|⌘) ⇧ Z$/);
    expect(formatShortcut('g i')).toBe('G dann I');
  });
});
