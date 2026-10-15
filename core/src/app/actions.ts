// ONE action list feeds keyboard shortcuts, the command menu, the context menu and the ? help.
// Extension point: registerAction({ … }) adds an action; it shows up in all four places
// automatically. `picker` turns it into a submenu in the context menu and into second-level
// values in the command menu.
// Labels are English (msg) and translate on read: each action's `label` is a getter calling t().
import { msg, t, tn, translated } from '../i18n.ts';
import type { IconName } from '../icons.ts';
import { inInbox, unread } from '../inbox.ts';
import { CLOSED } from '../format.ts';
import type { Issue, IssueId, PaletteKind, Status } from '../types.ts';
import { VIEWS, addTarget, planSprint } from '../views.ts';
import type { App } from './index.ts';

export type ActionSection = 'Issue' | 'Selection' | 'Navigation' | 'View' | 'General' | 'Triage' | 'Inbox' | 'Sprint' | 'Wiki';

/** Display name of each section (command menu, keyboard help). */
export const SECTION_LABEL: Record<ActionSection, string> = translated({
  Issue: 'Issue',
  Selection: 'Selection',
  Navigation: 'Navigation',
  View: 'View',
  General: 'General',
  Triage: 'Triage',
  Inbox: 'Inbox',
  Sprint: 'Sprint',
  Wiki: 'Knowledge',
});

export interface Action {
  id: string;
  /** English source text; reading it returns the translation. */
  label: string;
  section: ActionSection;
  keys?: string[];
  icon?: IconName;
  /** Search data: English and German synonyms */
  keywords?: string;
  /** Visible in the command menu without a query */
  top?: boolean;
  /** Place in the context menu: [group, order]; groups are separated by lines */
  context?: [number, number];
  /** Opens this picker (context menu: submenu) */
  picker?: PaletteKind;
  danger?: boolean;
  /** Not in the command menu or the help (keyboard only) */
  hidden?: boolean;
  when?: (app: App) => boolean;
  run: (app: App) => void;
}

const hasTarget = (a: App) => a.targets().length > 0;
const realTarget = (a: App) => a.targets().length > 0 && a.targets().every((id) => !a.store.isPending(id));
const single = (a: App) => a.targets().length === 1 && !a.store.isPending(a.targets()[0]);
// Ctrl+C keeps copying selected text; it copies the identifier only when nothing is selected.
const textSelected = () => (globalThis.getSelection?.()?.toString() ?? '') !== '';
const listPage = (a: App) => a.nav.page.get().name === 'view';
const issuePage = (a: App) => a.nav.page.get().name === 'issue';
const listFocus = (a: App) => listPage(a) && a.list.focusId() !== null;
const route = (a: App) => a.list.view.get().route;
// Triage actions apply in triage and in the inbox (reviewing issues created by agents).
const inTriage = (a: App) => listPage(a) && (route(a).kind === 'triage' || route(a).kind === 'inbox');
const notDeleted = (a: App) => hasTarget(a) && a.targets().every((id) => a.store.get(id)?.deletedAt === undefined);
/** Open issues only: a closed issue is not snoozed (the backend refuses it). */
const snoozable = (a: App) => notDeleted(a) && a.targets().every((id) => !CLOSED.has(a.store.get(id)?.status as Status));
const someSnoozed = (a: App) => a.targets().some((id) => a.store.get(id)?.snoozedUntil !== undefined);
const deleted = (a: App) => hasTarget(a) && a.targets().every((id) => a.store.get(id)?.deletedAt !== undefined);
const picker = (kind: PaletteKind) => (a: App) => a.palette.open(kind);
const viewKind = (a: App) => (listPage(a) ? a.main.view.get().route.kind : null);
const planPage = (a: App) => viewKind(a) === 'plan' && !!a.sprintsLoaded();
const meta = (a: App) => a.store.meta.get();
const hasActive = (a: App) => !!meta(a)?.sprints.some((s) => s.state === 'active');
const hasPlanning = (a: App) => !!meta(a)?.sprints.some((s) => s.state === 'planning');
// Enter opens the focused issue, even with an existing selection; in the context menu, its target.
const openTarget = (a: App) => (a.menu.state.get() ? a.targets()[0] : (a.list.focusId() ?? a.targets()[0]));
/** Board possible / active */
const boardView = (a: App) => listPage(a) && !!VIEWS[a.list.view.get().route.kind].boardTypes;
const onBoard = (a: App) => listPage(a) && a.list.isBoard();
// Inbox: actions on entries on the inbox page and in the context menu of an entry.
const inboxPage = (a: App) => viewKind(a) === 'inbox';
const entries = (a: App, ids: readonly IssueId[]) => ids.map((id) => a.store.get(id)).filter((i): i is Issue => !!i && inInbox(i) && !i.pending);
const inboxTargets = (a: App) => (inboxPage(a) || a.menu.state.get() !== null) && entries(a, a.targets()).length > 0;
const someUnread = (a: App, ids: readonly IssueId[]) => entries(a, ids).some(unread);
const inboxAll = (a: App) => (inboxPage(a) ? entries(a, a.list.visibleIds()) : []);
const manualOrder = (a: App) => listFocus(a) && a.list.view.get().display.ordering === 'rank' && a.list.view.get().display.grouping === 'none';

// Edit text without the mouse: on an issue page or a wiki page, while the text is loaded and not
// already being edited. The view puts the cursor at the end.
function editableIssue(a: App) {
  const d = a.detail.state.get();
  return issuePage(a) && !!d && d.body !== null && !d.deleted && !d.pending && !a.detail.desc.get().editing;
}
function editableArticle(a: App) {
  const wiki = a.nav.page.get().name === 'article' ? a.wikiLoaded() : null;
  const article = wiki?.state.get().article;
  return !!article && !article.deleted && !wiki!.edit.get().editing;
}

/** Wiki of the team in context (else of the current team); a hint if the team has no wiki. */
function goWiki(a: App) {
  const key = a.contextTeam() ?? a.currentTeam();
  const team = a.store.meta.get()?.teams.find((x) => x.key === key);
  if (!team) return;
  if (!team.wiki) {
    a.toasts.show(t('{team} has no wiki yet. Turn it on in the team settings.', { team: team.name }), { label: t('Settings'), run: () => a.openTeamSettings(team.key) });
    return;
  }
  a.nav.go({ name: 'wiki', team: team.key });
}

/** J/K: the detail page steps through issues, the list moves focus; in the split inbox the right pane follows. */
function step(a: App, delta: number) {
  a.cues.emit('tap');
  if (issuePage(a)) return a.detail.step(delta);
  a.list.moveFocus(delta);
  if (a.splitLayout()) a.detail.openSplit();
}

export const ACTIONS: Action[] = [
  // Issue
  { id: 'issue.create', label: msg('New issue'), section: 'Issue', keys: ['c'], icon: 'compose', top: true, keywords: 'create new anlegen erstellen neu', run: (a) => a.create.open() },
  { id: 'issue.open', label: msg('Open issue'), section: 'Issue', keys: ['enter'], icon: 'open', context: [3, 1], when: (a) => listFocus(a) || (a.menu.state.get() !== null && hasTarget(a)), run: (a) => a.openIssue(openTarget(a)!) },
  { id: 'issue.peek', label: msg('Preview (peek)'), section: 'Issue', keys: ['space'], icon: 'eye', context: [3, 2], when: listFocus, run: (a) => a.detail.togglePeek() },
  { id: 'issue.status', label: msg('Change status …'), section: 'Issue', keys: ['s'], icon: 'active', top: true, keywords: 'status state', picker: 'status', context: [1, 1], when: notDeleted, run: picker('status') },
  { id: 'issue.priority', label: msg('Set priority …'), section: 'Issue', keys: ['p'], icon: 'gauge', top: true, keywords: 'priority prio priorität', picker: 'priority', context: [1, 2], when: notDeleted, run: picker('priority') },
  { id: 'issue.labels', label: msg('Labels …'), section: 'Issue', keys: ['l'], icon: 'label', top: true, keywords: 'label tag', picker: 'labels', context: [1, 3], when: notDeleted, run: picker('labels') },
  { id: 'issue.estimate', label: msg('Estimate …'), section: 'Issue', keys: ['shift+e'], icon: 'estimate', keywords: 'estimate schätzung punkte points', picker: 'estimate', context: [1, 4], when: notDeleted, run: picker('estimate') },
  { id: 'issue.sprint', label: msg('Sprint …'), section: 'Issue', keys: ['shift+c'], icon: 'sprint', keywords: 'cycle zyklus', picker: 'sprint', context: [1, 5], when: notDeleted, run: picker('sprint') },
  { id: 'issue.project', label: msg('Project …'), section: 'Issue', keys: ['shift+p'], icon: 'projects', keywords: 'project projekt', picker: 'project', context: [1, 6], when: notDeleted, run: picker('project') },
  { id: 'issue.due', label: msg('Due date …'), section: 'Issue', keys: ['shift+d'], icon: 'calendar', keywords: 'due date deadline fälligkeit datum termin', picker: 'due', context: [1, 7], when: notDeleted, run: picker('due') },
  { id: 'issue.snooze', label: msg('Snooze …'), section: 'Issue', keys: ['h'], icon: 'snooze', top: true, keywords: 'snooze later hide remind defer hold zurückstellen wiedervorlage später verschieben erinnern', picker: 'snooze', context: [1, 10], when: snoozable, run: picker('snooze') },
  { id: 'issue.unsnooze', label: msg('Unsnooze'), section: 'Issue', keys: ['shift+h'], icon: 'snooze', keywords: 'unsnooze wake back zurückholen aufwecken wiedervorlage', context: [1, 11], when: (a) => notDeleted(a) && someSnoozed(a), run: (a) => a.edit.snooze(a.targets(), null) },
  { id: 'issue.parent', label: msg('Set parent …'), section: 'Issue', keys: ['mod+shift+p'], icon: 'parent', keywords: 'parent eltern übergeordnet', context: [1, 8], when: notDeleted, run: picker('parent') },
  { id: 'issue.team', label: msg('Move to team …'), section: 'Issue', keys: ['mod+shift+m'], icon: 'team', top: true, keywords: 'team move switch verschieben wechseln umziehen', picker: 'team', context: [1, 9], when: (a) => realTarget(a) && notDeleted(a), run: picker('team') },
  { id: 'issue.subissue', label: msg('Create sub-issue'), section: 'Issue', keys: ['mod+shift+o'], icon: 'subissue', keywords: 'sub child unter anlegen', context: [2, 1], when: (a) => single(a) && notDeleted(a), run: (a) => a.create.openSubIssue(a.targets()[0]) },
  { id: 'issue.blocks', label: msg('Blocks …'), section: 'Issue', icon: 'blocked', keywords: 'relation blocks blockiert', context: [2, 2], when: (a) => single(a) && notDeleted(a), run: (a) => a.palette.openRelation('blocks') },
  { id: 'issue.blockedBy', label: msg('Blocked by …'), section: 'Issue', icon: 'blocked', keywords: 'relation blocked by blockiert von', context: [2, 3], when: (a) => single(a) && notDeleted(a), run: (a) => a.palette.openRelation('blocks', true) },
  { id: 'issue.related', label: msg('Related to …'), section: 'Issue', icon: 'relation', keywords: 'relation related verwandt', context: [2, 4], when: (a) => single(a) && notDeleted(a), run: (a) => a.palette.openRelation('related') },
  { id: 'issue.duplicate', label: msg('Mark as duplicate …'), section: 'Issue', icon: 'duplicate', keywords: 'duplicate duplikat doppelt', context: [2, 5], when: (a) => realTarget(a) && notDeleted(a), run: (a) => a.palette.openRelation('duplicate') },
  { id: 'issue.copyLink', label: msg('Copy link'), section: 'Issue', keys: ['mod+shift+,'], icon: 'link', keywords: 'url copy kopieren', context: [3, 4], when: single, run: (a) => a.edit.copyLink(a.targets()[0]) },
  { id: 'issue.copyBranch', label: msg('Copy branch name'), section: 'Issue', keys: ['mod+shift+.'], icon: 'branch', keywords: 'git branch copy kopieren', context: [3, 5], when: (a) => single(a) && notDeleted(a), run: (a) => a.edit.copyBranch(a.targets()[0]) },
  { id: 'issue.copyKey', label: msg('Copy ID'), section: 'Issue', keys: ['mod+.'], icon: 'copy', keywords: 'id identifier key kennung copy kopieren', context: [3, 3], when: realTarget, run: (a) => a.edit.copyKeys(a.targets()) },
  { id: 'issue.copyKeyPlain', label: msg('Copy ID'), section: 'Issue', keys: ['mod+c'], hidden: true, when: (a) => realTarget(a) && !textSelected(), run: (a) => a.edit.copyKeys(a.targets()) },
  { id: 'issue.moveUp', label: msg('Move issue up'), section: 'Issue', keys: ['alt+arrowup'], icon: 'arrowUp', keywords: 'reihenfolge rang order rank', when: manualOrder, run: (a) => a.edit.move(a.list.focusId()!, -1) },
  { id: 'issue.moveDown', label: msg('Move issue down'), section: 'Issue', keys: ['alt+arrowdown'], icon: 'arrowDown', keywords: 'reihenfolge rang order rank', when: manualOrder, run: (a) => a.edit.move(a.list.focusId()!, 1) },
  // E for "edit". In the inbox, E stays "remove": this action applies only on the issue page.
  { id: 'issue.editDescription', label: msg('Edit description'), section: 'Issue', keys: ['e'], icon: 'edit', keywords: 'edit description text write bearbeiten ändern schreiben beschreibung', when: editableIssue, run: (a) => a.detail.startEdit() },
  { id: 'issue.repeat', label: msg('Repeat …'), section: 'Issue', icon: 'restore', keywords: 'wiederkehrend recurring repeat weekly monthly template wöchentlich monatlich vorlage', picker: 'repeat', context: [3, 6], when: (a) => single(a) && notDeleted(a), run: picker('repeat') },
  { id: 'issue.restore', label: msg('Restore'), section: 'Issue', icon: 'restore', keywords: 'restore trash wiederherstellen papierkorb', context: [4, 2], when: deleted, run: (a) => a.edit.restore(a.targets()) },
  { id: 'issue.delete', label: msg('Delete'), section: 'Issue', keys: ['mod+backspace', 'mod+delete'], icon: 'trash', keywords: 'delete remove trash löschen papierkorb entfernen', danger: true, context: [5, 2], when: (a) => notDeleted(a), run: (a) => a.edit.remove(a.targets()) },

  // Triage: 1 accept, 2 duplicate, 3 decline
  { id: 'triage.accept', label: msg('Accept …'), section: 'Triage', keys: ['1'], icon: 'check', keywords: 'accept triage annehmen', context: [0, 1], when: (a) => inTriage(a) && realTarget(a), run: picker('move') },
  { id: 'triage.duplicate', label: msg('Mark as duplicate …'), section: 'Triage', keys: ['2'], icon: 'duplicate', keywords: 'duplicate triage duplikat', hidden: true, when: (a) => inTriage(a) && realTarget(a), run: (a) => a.palette.openRelation('duplicate') },
  {
    id: 'triage.decline',
    label: msg('Decline'),
    section: 'Triage',
    keys: ['3'],
    icon: 'close',
    keywords: 'decline reject ablehnen triage',
    context: [0, 2],
    when: (a) => inTriage(a) && realTarget(a),
    run: (a) => {
      const ids = a.targets();
      a.edit.patch(ids, { status: 'canceled' }, { label: t('Declined') });
      a.edit.markRead(ids);
    },
  },

  // Inbox: ⌫ remove, ⇧ ⌫ remove read entries, U read/unread, Alt U all read.
  // Removing only takes the entry out of the inbox; the issue stays as it is.
  { id: 'inbox.remove', label: msg('Remove from inbox'), section: 'Inbox', keys: ['backspace', 'delete', 'e'], icon: 'check', keywords: 'inbox eingang entfernen erledigt archivieren archive done remove', context: [4, 1], when: inboxTargets, run: (a) => a.edit.removeFromInbox(entries(a, a.targets()).map((i) => i._id)) },
  { id: 'inbox.read', label: msg('Mark as read'), section: 'Inbox', keys: ['u'], icon: 'eye', keywords: 'gelesen read seen gesichtet', context: [4, 2], when: (a) => inboxTargets(a) && someUnread(a, a.targets()), run: (a) => a.edit.markRead(a.targets(), true, { undo: true }) },
  { id: 'inbox.unread', label: msg('Mark as unread'), section: 'Inbox', keys: ['u'], icon: 'eye', keywords: 'ungelesen unread', context: [4, 2], when: (a) => inboxTargets(a) && !someUnread(a, a.targets()), run: (a) => a.edit.markRead(a.targets(), false, { undo: true }) },
  { id: 'inbox.readAll', label: msg('Mark all as read'), section: 'Inbox', keys: ['alt+u'], icon: 'eye', keywords: 'alle gelesen read all', when: (a) => inboxAll(a).some(unread), run: (a) => a.edit.markRead(inboxAll(a).filter(unread).map((i) => i._id), true, { undo: true }) },
  {
    id: 'inbox.clearRead',
    label: msg('Remove read entries from inbox'),
    section: 'Inbox',
    keys: ['shift+backspace', 'shift+delete'],
    icon: 'check',
    keywords: 'gelesene entfernen leeren clear read remove',
    when: (a) => inboxAll(a).some((i) => !unread(i)),
    run: (a) => a.edit.removeFromInbox(inboxAll(a).filter((i) => !unread(i)).map((i) => i._id)),
  },
  {
    id: 'inbox.clearAll',
    label: msg('Done for today: clear inbox'),
    section: 'Inbox',
    icon: 'check',
    top: true,
    keywords: 'fertig heute alle entfernen leeren eingang clear all done today inbox',
    when: (a) => inboxAll(a).length > 0,
    run: (a) => {
      const ids = inboxAll(a).map((i) => i._id);
      a.edit.removeFromInbox(ids, { label: tn(ids.length, 'Inbox cleared', 'Inbox cleared ({count} entries)') });
    },
  },

  // Wiki
  { id: 'wiki.editBody', label: msg('Edit page text'), section: 'Wiki', keys: ['e'], icon: 'edit', keywords: 'edit wiki page text write wissen seite bearbeiten ändern schreiben', when: editableArticle, run: (a) => a.wiki.startEdit() },

  // Sprint
  { id: 'go.sprints', label: msg('Go to: All sprints'), section: 'Navigation', icon: 'sprint', keywords: 'sprints cycles overview übersicht', run: (a) => a.nav.go({ name: 'sprints' }) },
  { id: 'sprint.plan', label: msg('Plan sprint'), section: 'Sprint', icon: 'sprint', top: true, keywords: 'sprint planung planen plan cycle', run: (a) => a.nav.goView({ kind: 'plan', team: null, sprint: null }) },
  {
    id: 'sprint.start',
    label: msg('Start sprint'),
    section: 'Sprint',
    icon: 'sprint',
    keywords: 'sprint start begin starten beginnen',
    when: (a) => hasPlanning(a) && !hasActive(a),
    run: (a) => {
      const route = planPage(a) ? a.main.view.get().route : { kind: 'plan' as const, team: null };
      const id = planSprint(route, meta(a))?._id;
      if (id) void a.loadSprints().then((s) => s.start(id));
    },
  },
  {
    id: 'sprint.edit',
    label: msg('Edit sprint'),
    section: 'Sprint',
    icon: 'edit',
    keywords: 'sprint edit change name goal dates end start capacity bearbeiten ändern ziel ende kapazität',
    when: hasActive,
    run: (a) => {
      a.nav.goView({ kind: 'sprint', team: null });
      void a.loadSprints().then((s) => s.editing.set(true));
    },
  },
  { id: 'sprint.close', label: msg('Complete sprint'), section: 'Sprint', icon: 'check', keywords: 'sprint complete finish end close abschluss abschließen ende beenden', when: hasActive, run: (a) => a.nav.goView({ kind: 'close', team: null }) },
  {
    id: 'sprint.add',
    label: msg('Add to the sprint'),
    section: 'Sprint',
    icon: 'sprint',
    keywords: 'sprint einplanen hinzufügen add schedule cycle',
    when: (a) => {
      const target = addTarget(meta(a));
      return notDeleted(a) && !!target && a.targets().some((id) => a.store.get(id)?.sprintId !== target._id);
    },
    run: (a) => {
      const ids = a.targets();
      const target = addTarget(meta(a))!;
      void a.loadSprints().then((s) => s.move(ids, target._id));
    },
  },
  // Selection
  { id: 'select.toggle', label: msg('Select'), section: 'Selection', keys: ['x'], icon: 'select', context: [5, 1], when: listFocus, run: (a) => a.list.toggleSelect(a.menu.state.get() ? a.targets()[0] : undefined) },
  { id: 'select.down', label: msg('Extend selection down'), section: 'Selection', keys: ['shift+arrowdown', 'shift+j'], when: listPage, run: (a) => a.list.extendSelection(1) },
  { id: 'select.up', label: msg('Extend selection up'), section: 'Selection', keys: ['shift+arrowup', 'shift+k'], when: listPage, run: (a) => a.list.extendSelection(-1) },
  { id: 'select.all', label: msg('Select all'), section: 'Selection', keys: ['mod+a'], icon: 'select', top: true, keywords: 'select all alle auswählen', when: listPage, run: (a) => a.list.selectAll() },
  { id: 'select.clear', label: msg('Clear selection'), section: 'Selection', keywords: 'deselect auswahl aufheben', when: (a) => a.list.selectionCount.get() > 0, run: (a) => a.list.clearSelection() },

  // Navigation
  { id: 'nav.down', label: msg('Next issue'), section: 'Navigation', keys: ['j', 'arrowdown'], hidden: false, when: (a) => listPage(a) || issuePage(a), run: (a) => step(a, 1) },
  { id: 'nav.up', label: msg('Previous issue'), section: 'Navigation', keys: ['k', 'arrowup'], when: (a) => listPage(a) || issuePage(a), run: (a) => step(a, -1) },
  { id: 'nav.first', label: msg('First issue'), section: 'Navigation', keys: ['home'], hidden: true, when: listPage, run: (a) => a.list.focusEdge(false) },
  { id: 'nav.last', label: msg('Last issue'), section: 'Navigation', keys: ['end'], hidden: true, when: listPage, run: (a) => a.list.focusEdge(true) },
  { id: 'go.inbox', label: msg('Go to: Inbox'), section: 'Navigation', keys: ['g i'], icon: 'inbox', top: true, keywords: 'inbox eingang', run: (a) => a.nav.goView({ kind: 'inbox', team: null }) },
  { id: 'go.snoozed', label: msg('Go to: Snoozed'), section: 'Navigation', keys: ['g h'], icon: 'snooze', keywords: 'snoozed zurückgestellt wiedervorlage later hidden', run: (a) => a.nav.goView({ kind: 'snoozed', team: a.contextTeam() }) },
  { id: 'go.triage', label: msg('Go to: Triage'), section: 'Navigation', keys: ['g t'], icon: 'triage', keywords: 'triage', run: (a) => a.nav.goView({ kind: 'triage', team: null }) },
  { id: 'go.all', label: msg('Go to: All issues'), section: 'Navigation', keys: ['g a'], icon: 'issues', top: true, keywords: 'all alle', run: (a) => a.nav.goView({ kind: 'all', team: null }) },
  { id: 'go.active', label: msg('Go to: Active issues'), section: 'Navigation', keys: ['g e'], icon: 'active', keywords: 'active aktiv', run: (a) => a.nav.goView({ kind: 'active', team: a.contextTeam() }) },
  { id: 'go.backlog', label: msg('Go to: Backlog'), section: 'Navigation', keys: ['g b'], icon: 'backlog', keywords: 'backlog', run: (a) => a.nav.goView({ kind: 'backlog', team: a.contextTeam() }) },
  { id: 'go.wiki', label: msg('Go to: Knowledge'), section: 'Navigation', keys: ['g w'], icon: 'wiki', keywords: 'wissen wiki doku dokumentation docs documentation knowledge seiten pages', run: (a) => goWiki(a) },
  { id: 'go.sprint', label: msg('Go to: Sprint'), section: 'Navigation', keys: ['g s'], icon: 'sprint', keywords: 'sprint cycle', run: (a) => a.nav.goView({ kind: 'sprint', team: null }) },
  { id: 'team.switch', label: msg('Switch team …'), section: 'Navigation', keys: ['o t'], icon: 'team', keywords: 'team wechseln switch current aktuelles', run: (a) => a.palette.open('switchTeam') },
  { id: 'team.new', label: msg('Add team …'), section: 'Navigation', keys: ['o n'], icon: 'plus', keywords: 'team neu anlegen erstellen hinzufügen add create new', run: (a) => a.openNewTeam() },
  { id: 'team.settings', label: msg('Current team settings'), section: 'Navigation', keys: ['o s'], icon: 'settings', keywords: 'team settings einstellungen name logo status workflow', when: (a) => a.currentTeam() !== null, run: (a) => a.openTeamSettings() },
  { id: 'go.trash', label: msg('Go to: Trash'), section: 'Navigation', keys: ['g x'], icon: 'trash', keywords: 'trash deleted papierkorb gelöscht', run: (a) => a.nav.goView({ kind: 'trash', team: null }) },
  { id: 'go.drafts', label: msg('Go to: Drafts'), section: 'Navigation', icon: 'compose', keywords: 'drafts entwurf entwürfe', run: (a) => a.nav.go({ name: 'drafts' }) },
  { id: 'go.settings', label: msg('Settings'), section: 'Navigation', icon: 'settings', keywords: 'settings preferences einstellungen', run: (a) => a.nav.go({ name: 'settings', section: 'general' }) },
  { id: 'go.settings.profile', label: msg('Settings: Profile'), section: 'Navigation', icon: 'user', keywords: 'profile profil name picture photo avatar bild foto', run: (a) => a.nav.go({ name: 'settings', section: 'profile' }) },
  { id: 'go.settings.teams', label: msg('Settings: Teams and logos'), section: 'Navigation', icon: 'team', keywords: 'teams logo key color kürzel farbe', run: (a) => a.nav.go({ name: 'settings', section: 'teams' }) },
  { id: 'go.settings.labels', label: msg('Settings: Labels'), section: 'Navigation', icon: 'label', keywords: 'labels groups gruppen', run: (a) => a.nav.go({ name: 'settings', section: 'labels' }) },
  { id: 'go.settings.agents', label: msg('Settings: Agents'), section: 'Navigation', icon: 'agent', keywords: 'agents agenten schlüssel mcp api key connector claude chatgpt oauth', run: (a) => a.nav.go({ name: 'settings', section: 'agents' }) },
  { id: 'go.settings.recurrences', label: msg('Settings: Recurrences'), section: 'Navigation', icon: 'restore', keywords: 'wiederkehrend wiederholungen recurring recurrences', run: (a) => a.nav.go({ name: 'settings', section: 'recurrences' }) },
  { id: 'go.ops', label: msg('Ops: View status'), section: 'Navigation', icon: 'gauge', keywords: 'betrieb status backup import health ops operations', run: (a) => a.nav.go({ name: 'settings', section: 'ops' }) },
  { id: 'open.recent', label: msg('Recently opened issues …'), section: 'Navigation', keys: ['o i'], icon: 'issues', keywords: 'recent zuletzt öffnen open', run: (a) => a.palette.open('search') },
  { id: 'search.open', label: msg('Search issues'), section: 'Navigation', keys: ['/'], icon: 'search', top: true, keywords: 'search find suchen', run: (a) => a.palette.open('search') },
  { id: 'nav.back', label: msg('Back to list'), section: 'Navigation', icon: 'back', when: issuePage, run: (a) => a.closeIssue() },
  { id: 'palette.open', label: msg('Command menu'), section: 'General', keys: ['mod+k'], run: (a) => a.palette.open('command') },

  // View
  { id: 'quick.open', label: msg('Search in this view'), section: 'View', keys: ['mod+f'], icon: 'search', keywords: 'filter quick find schnell suchen', when: listPage, run: (a) => a.list.openQuick() },
  { id: 'filter.open', label: msg('Filter …'), section: 'View', keys: ['f'], icon: 'filter', top: true, keywords: 'filter', when: listPage, run: (a) => a.palette.open('filter') },
  { id: 'filter.clear', label: msg('Clear filters'), section: 'View', icon: 'close', keywords: 'filter reset zurücksetzen', when: (a) => listPage(a) && (a.list.header.get().filterCount > 0 || a.list.view.get().quick !== ''), run: (a) => a.list.clearFilters() },
  { id: 'display.open', label: msg('Display options …'), section: 'View', keys: ['shift+v'], icon: 'display', keywords: 'display grouping ordering view gruppierung sortierung ansicht', when: listPage, run: (a) => a.toggleDisplay() },
  { id: 'layout.toggle', label: msg('Toggle board / list'), section: 'View', keys: ['mod+b'], icon: 'board', keywords: 'board kanban list liste layout columns spalten', when: boardView, run: (a) => a.list.toggleLayout() },
  { id: 'board.left', label: msg('Column left'), section: 'View', keys: ['arrowleft'], hidden: true, when: onBoard, run: (a) => (a.cues.emit('tap'), a.list.moveColumn(-1)) },
  { id: 'board.right', label: msg('Column right'), section: 'View', keys: ['arrowright'], hidden: true, when: onBoard, run: (a) => (a.cues.emit('tap'), a.list.moveColumn(1)) },
  { id: 'board.moveLeft', label: msg('Move card one column left'), section: 'View', keys: ['shift+arrowleft'], icon: 'chevronLeft', keywords: 'status back zurück', when: (a) => onBoard(a) && notDeleted(a), run: (a) => a.list.moveCard(-1) },
  { id: 'board.moveRight', label: msg('Move card one column right'), section: 'View', keys: ['shift+arrowright'], icon: 'chevronRight', keywords: 'status forward weiter', when: (a) => onBoard(a) && notDeleted(a), run: (a) => a.list.moveCard(1) },
  { id: 'group.toggle', label: msg('Collapse/expand group'), section: 'View', keys: ['t'], keywords: 'collapse expand group gruppe', when: (a) => listPage(a) && a.list.view.get().display.grouping !== 'none', run: (a) => a.list.toggleFocusedGroup() },
  { id: 'sidebar.toggle', label: msg('Toggle sidebar'), section: 'View', icon: 'sidebar', keywords: 'sidebar navigation seitenleiste', run: (a) => a.toggleSidebar() },

  // General
  { id: 'history.undo', label: msg('Undo'), section: 'General', keys: ['mod+z'], icon: 'undo', top: true, keywords: 'undo rückgängig', run: (a) => a.edit.undo() },
  { id: 'history.redo', label: msg('Redo'), section: 'General', keys: ['mod+shift+z', 'mod+y'], icon: 'redo', keywords: 'redo wiederholen', run: (a) => a.edit.redo() },
  { id: 'help.open', label: msg('Show keyboard shortcuts'), section: 'General', keys: ['?'], icon: 'keyboard', top: true, keywords: 'help hilfe shortcuts tastenkürzel keyboard', run: (a) => a.palette.open('help') },
  { id: 'theme.toggle', label: msg('Toggle light/dark'), section: 'General', icon: 'theme', keywords: 'theme dark light hell dunkel farbschema', run: (a) => a.prefs.toggleTheme() },
  { id: 'perf.toggle', label: msg('Toggle perf overlay'), section: 'General', icon: 'gauge', keywords: 'perf overlay performance messung', run: (a) => a.perf.toggle() },
  { id: 'test.reject', label: msg('Test switch: server rejects changes'), section: 'General', keywords: 'test reject error fehler', when: (a) => a.debug, run: (a) => void a.toggleRejectWrites() },
];

/** Replaces `label` (English source) with a getter that returns the translation on every read. */
function translateLabel(action: Action): Action {
  const english = action.label;
  Object.defineProperty(action, 'label', { enumerable: true, configurable: true, get: () => t(english) });
  return action;
}
ACTIONS.forEach(translateLabel);

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
export const KEYMAP = new Map<string, Action[]>();

function index(action: Action) {
  for (const key of action.keys ?? []) {
    const list = KEYMAP.get(key) ?? [];
    list.push(action);
    KEYMAP.set(key, list);
  }
}
ACTIONS.forEach(index);

/** Extension point for more pages (sprints, settings …). Pass the label in English (msg). */
export function registerAction(action: Action) {
  if (BY_ID.has(action.id)) throw new Error(`Action ${action.id} already exists`);
  translateLabel(action);
  ACTIONS.push(action);
  BY_ID.set(action.id, action);
  index(action);
}

export function actionById(id: string) {
  return BY_ID.get(id);
}

/** First shortcut of an action as text (tooltips). */
export function shortcutOf(id: string): string | undefined {
  return BY_ID.get(id)?.keys?.[0];
}

/** Does the key start a two-key sequence ("g", "o")? */
export function startsSequence(combo: string) {
  for (const key of KEYMAP.keys()) if (key.startsWith(`${combo} `)) return true;
  return false;
}
