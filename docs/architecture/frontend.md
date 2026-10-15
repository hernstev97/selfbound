# Frontend (Svelte 5 + core)

Code: `core/` (framework-neutral) and `app/` (Svelte).

This document describes the structure, data flow and extension points of the UI. If you build a new page, view or action (sprints, settings, ops), this is where you find out where it belongs and which performance rules apply.

## Overview

```
Convex (subscriptions, mutations)
   │
   ▼
core/src/store.ts      IssueStore: all issues frozen in one Map, pending issues,
   │                   optimistic mutations, detail subscriptions, IndexedDB mirror
   ▼
core/src/app/*.ts      App = submodules with slices (value + subscription), compute outside components
   │
   ▼
app/src/**/*.svelte    render only what the slices hold; report DOM events to the App
```

Svelte binds slices through `fromSlice(slice).current` (`app/src/slice.svelte.ts`). No deep proxies, no Svelte store in the core; the core also runs in Vitest without a DOM.

## Core (`core/src`)

| File | Contents |
|---|---|
| `types.ts` | Domain types (Issue, Meta, ViewState, RowState, MenuItem, PaletteState …) |
| `store.ts` | Data layer (see below) |
| `idb.ts` | IndexedDB mirror: header (schema, meta, maxSeq) in `kv`, one record per bucket in `buckets`; read in one transaction (`getAll`), only changed buckets are written, in batches of 8 buckets per idle slice, header last. Schema version `MIRROR_SCHEMA` (mirror is discarded on mismatch) |
| `query.ts` | Filtering, sorting, grouping (`visibleFilter`, `viewComparator`, `computeList`, `reuseList`, `keyWidth`) |
| `haystack.ts` | Search text of an issue (`haystackOf`), computed on demand, cached per object in a WeakMap |
| `views.ts` | Views as data (`VIEWS`): base filter, default display, allowed groupings/orderings, row style, defaults for new issues, empty text |
| `route.ts` | Paths ↔ pages, filters/display as query parameters |
| `search.ts` | uFuzzy over identifier + title, identifiers with 2–6 character team keys (`kiu106`, `KIU-106`, `kiu 106`) |
| `window.ts` | Windowing (fixed row height 44 px, mobile 52, inbox 60) |
| `format.ts` | Labels, orderings, dates (through `intlLocale()`), free-form due date input in English and German (`parseDueInput`: “today”/“heute”, “tomorrow”/“morgen”, “fri”/“fr”, “next week”, “+3”, “in 3 days”, “12.10.”, month names), branch name |
| `icons.ts` | SVG strings (status/priority icons, UI icons) and from them `rowIconCss()`: the same shapes as CSS masks (`.s-<status>`, `.p-<priority>`, `.i-…`, `.ui-<icon>` on `.mi::before`) for rows, sidebar and headers |
| `keyboard.ts` | Key event → `"mod+shift+z"`, display “Ctrl ⇧ Z” |
| `auth.ts` | Sign-in: local token or Clerk |
| `i18n.ts` | UI translations, see [Internationalization](#internationalization) |
| `app/index.ts` | `App`: wires everything together, shell and sidebar state |
| `app/nav.ts` | Navigator: page, history, URL |
| `app/list.ts` | ListController: view, filters, display, focus, selection, groups, scroll |
| `app/detail.ts` | DetailController: detail page and peek, description with conflict handling, comments |
| `app/edit.ts` | Editor: all issue changes with undo/redo, copy |
| `app/palette.ts` | Command menu, search, help, filters, all pickers (one pattern) |
| `app/menu.ts` | Context menu with submenus |
| `app/create.ts` | Create dialog, drafts, `/new` |
| `app/actions.ts` | THE action list |
| `app/keys.ts` | Keyboard |
| `app/toasts.ts`, `prefs.ts`, `perf.ts` | Toasts, theme/font, perf overlay |
| `app/sprints.ts` | SprintController (own chunk, `app.loadSprints()`): header numbers of the current sprint, planning, decisions when closing, overview `/sprints`, sprint mutations, drag and drop; registers the keys of the sprint pages (→ ← Tab, 1/2/3/0, Ctrl Enter) |
| `app/admin.ts` | Settings (`@selfbound/core/app/admin`, only in the settings chunk): teams, logos, projects, labels, groups, agent keys, recurrences; site URL and MCP command |
| `app/repeat.ts` | “Repeat …”: template from an issue (small chunk) |
| `app/wiki.ts`, `wikiTree.ts` | WikiController (own chunk, `app.loadWiki()`): a team's wiki, page, trash, dragging in the tree ([below](#wiki-appwikits-pageswiki)) |
| `bodyEdit.ts` | `BodyEditSession`: editing a versioned text (autosave, draft, conflict), for the description and wiki pages |
| `budget.ts` | Priority budget: open Urgent/High per team, warning when exceeded |
| `sprintlogic.ts` | Pure sprint computations: date range, points, metrics from `sprints.items`, closing state, insertion point when dragging |

### Data layer (`IssueStore`)

- **Subscriptions:** `meta.get` (teams with logo URLs, projects, labels, groups, sprints), `meta.counter` (`maxSeq` → buckets `0 … floor(maxSeq/64)`), once at startup `issues.head` (maxSeq and the two newest buckets with the first response, then unsubscribed), one `issues.bucket` per bucket (newest subscribed first), for the current sprint `sprints.items` (→ `sprintKinds`: planned/added later), `agents.list` (names for the activity feed).
- **Deleted** issues stay in memory (`deletedAt`); every view except the trash filters them out (`VIEWS.*.includes`), search too.
- **One object per issue:** The document from the server (or from the mirror) becomes the issue itself: `#enrich` only sets `key` and freezes it, no second copy next to the Convex result (objects that are already frozen are copied, e.g. after a team key changed). `haystackOf(issue)` provides the search text on demand.
- **Change detection:** `sameIssue` compares ALL fields of both sides generically (including removed and new ones). Unchanged issues keep their object; only what changed is reported (`onChange(ids)`), batched per microtask.
- **Counters and indexes, updated incrementally instead of recounted:** `counts()` (inbox, triage per team for the sidebar), `teamCounts(team, sprint)` (team cards: not started and started by status type, issues in the sprint and how many are done) and `childrenOf(id)` (sub-issues for detail and peek) are updated on every insert and removal; no loop over 10,000 issues per change.
- **Optimistic, every mutation:** `update`, `revert`, `remove`, `restore`, `markReviewed`, `reorder` patch the affected buckets through a Convex optimistic update; comments, description and relations patch the detail subscription. If the server rejects, Convex rolls back the update and the value jumps back; the caller shows the error.
- **Create:** `create(items)` adds pending issues immediately (`_id = tmp:n`, `pending`, identifier `KIU-…`, “saving”). Only the server knows seq and bucket. The pending row disappears exactly when the real issue has arrived in its bucket (no duplicate, no gap). `resolvedId(tmp)` then returns the real ID; changes to pending issues apply locally at once and are sent after confirmation.
- **Detail subscriptions:** `watchDetail(id, listener)`; up to 16 without listeners stay in memory. Cleanup only runs after the new entry has its listener and timestamp (regression test in `core/test/store.test.ts`).
- **Sync indicator** (`sync`): visible only when something is stuck (> 1 s pending) or there is no connection.
- **General subscriptions and mutations** (settings, sprints): `store.watch(query, args)` returns a slice plus `release` (same query = one subscription); `store.call(mutation, args, optimisticUpdate?)` and `store.act(action, args)` go through the sync indicator and the perf hooks. In Svelte: `useQuery(api.x, args)` from `app/src/lib/live.svelte.ts` (subscription ends with the component).
- **Perf hooks** (`globalThis.__selfbound` with `saves` and `app`) exist only with `debug`: in development, with `?perf=1` or in the test build (`VITE_XLR8_TEST=1`), never in the normal production build.

### Data flow of a change (example: S → “In Progress”)

1. `keys.ts` recognizes `s`, looks up the first action in `KEYMAP` whose `when` condition holds (`issue.status`) and calls `palette.open('status')`.
2. The picker takes the targets (`app.targets()`: menu target → open issue → selection → focus).
3. Enter → `palette.apply({ status })` → `edit.patch(ids, patch)`: remember the old values (undo entry with location), `store.update(...)` with an optimistic update.
4. Convex delivers the optimistic bucket → `store.#ingest` → `onChange({id})` → `list.onIssues` updates the row (`rows.refresh(id)`). If all changed issues (up to 200) stay inside or outside the view, in their group and between their neighbours (`#tryInPlace`), the list does not change and nothing is filtered or sorted again. Otherwise the list recomputes; `reuseList` keeps the old list object if the order did not change, and the topmost visible row stays in place on screen (scroll anchoring).
5. Server confirms (or rejects → value jumps back + persistent toast with “Try again”).

### Statuses per team (`workflow.ts`)

`meta.get` returns all statuses of all teams (`workflowStates`, including archived ones). `workflowsOf(meta)` builds an index (`Workflows`) once per meta revision: an issue's status (`of(issue)`: name, status type for icon and default colour, custom colour), a team's statuses in workflow order, statuses for a status type (`forStatus`), groups across teams (`groups()`: same type and name = one entry; pickers, filters, board columns). Rules and order come from `@selfbound/backend/shared/workflow`, so they match the backend.

- **Status type** (`issue.status`, eight keys) remains the client's basis for views (Triage, Active, Backlog), “Show completed”, sprint logic, budget and sorting. Name, icon colour and group come from the status.
- **Setting a status:** The picker (S) shows the statuses of the affected teams; with several teams only those that exist in all of them (same name and type). Digits 1–9 pick the first nine. `edit.setState` sends each issue the `stateId` of its own team (`patchEach`, one undo step). A bare status type (accept from triage, decline, duplicate) is first translated by `edit.patch` into the team's status, so undo restores exactly the old status. Optimistically, the status type follows the status (`applyPatch` with `Workflows`).
- **Fixed order:** The picker only offers targets allowed for all affected issues (`Workflows.allowed`, same rule as the backend); the hint below names the blocked ones. “Accept from triage” only offers what is allowed. If the server still rejects (e.g. stale metadata), the reason comes back as a toast listing the allowed targets.
- **Move to another team** (`issue.team`, **Ctrl Shift M**, also in the command menu without search text, in the context menu, in the issue's properties by clicking the team, and for the whole selection in the list): The team picker calls `palette.requestMove(ids, teamId)`. `movePlan` (`core/src/move.ts`, a pure function over the metadata, same rules as `ops/move.ts`) computes up front what will be dropped: the project (belongs to one team) and team labels of the old team. If something is dropped, a confirmation replaces the picker (entries “Move to <team>” and “Cancel”, the lines from `moveLines` as a hint below; `‹ Team` and Esc go back to the team picker, Enter moves); otherwise the move happens at once. Afterwards as usual: a toast “KIU-12 is now PX-3” with Undo, and an open detail page switches to the new identifier. Triage “Accept into <team>” does not ask (rarely drops anything there). The MCP route: [mcp.md](mcp.md) (`move_issues`).
- **Grouping** “by status”: key `<type>:<name>` (lower case), order: triage, started (later ones first), planned, backlog, completed, canceled.
- **Filter** `status`: names in lower case (across teams); older links with keys (`status=in_progress`) still work.
- **Create:** The draft remembers `stateId` (picked) or `stateName` (group “+”, filter, `/new?status=…`) and resolves it in the team when creating; without a choice the team's default status applies.
- **History:** `stateId` entries show the names (also of archived statuses); older `status` entries as before.
- **Settings:** Team → “Workflow” section (`pages/settings/Workflow.svelte`, operations in `core/src/app/admin.ts`).
- Mirror (`MIRROR_SCHEMA` 5): older mirrors without status IDs are discarded.

### Board (`board.ts`, `components/board/`)

The board is a **layout** of every list view that has `boardTypes` (All, Active, Backlog, Sprint, Project): `display.layout = 'board'`, `?layout=board` in the URL, remembered per view. **Ctrl B** (`layout.toggle`, also the button in the view bar) switches and keeps the focus.

- **Columns** (`computeBoard`): one per status of the view's teams (team, project team, otherwise all active); across teams, same type and name = one column. Empty columns only for the view's types. Completed and canceled columns are **collapsed** by default (header with count only, no cards in the DOM); clicking the header toggles (remembered per view). Each column uses the view's ordering.
- **Computation:** in the `ListController` (`recompute` → `#recomputeBoard`); `reuseBoard` keeps unchanged columns. If an issue changes without moving column or position, only its card is redrawn (`#tryInPlaceBoard`). The flat order (`order()`) runs column by column, so selection, Shift-click, peek paging and actions work unchanged.
- **Cards** read the same row state as the list (`rows.get(id)`), fixed height 76 + 6 px (`CARD_SLOT`), windowing per column (`computeWindow`).
- **Keyboard:** J/K or ↑/↓ within the column, ←/→ to the next column with cards, **Shift ←/→** moves the selection or card one column over (also into collapsed ones), all other shortcuts as in the list (S, P, L, X, Ctrl Z …).
- **Mouse:** drag cards (HTML5 drag and drop). While dragging, allowed columns are outlined, blocked ones dimmed with the reason in a tooltip (`dropProblem`: status missing in the team, or fixed order). “+” in the column header creates an issue in that status.
- **Mobile:** columns nearly screen-wide, swipe horizontally (scroll snap), long press opens the context menu.
- Own chunk (`pages.board`), preloaded when idle.

### Sidebar with team cards (`Sidebar.svelte`, `lib/sidebarMotion.ts`)

- **Current team:** `App.currentTeam()` is the most recently visited team page (a team's view or projects, remembered in `Prefs.currentTeam`), otherwise the first active team. Issue pages and global pages do not change it, otherwise the sidebar would jump while paging through “All issues”.
- **State:** `SidebarState.current` (top, with Triage, Issues, Backlog, Projects), `teams` (other active teams in `order`), `dormant` (other dormant teams), plus `teamsCollapsed` and `dormantCollapsed`.
- **Counts:** own slice `App.teamStats` (per key from `IssueStore.teamCounts`), recomputed at most every 150 ms. They are not a response to input; redrawing the sidebar after each of the roughly 150 buckets during loading measurably slowed startup.
- **Switching:** `App.switchTeam(key)` opens the same team page of the other team (Backlog stays Backlog, Projects stays Projects, otherwise Issues). Ways in: click a card, Enter on a card (focus then moves to the card at the top), `O T` (“Switch team …” in the command menu).
- **Team settings:** last item under the current team's card, opens `/settings/teams/<KEY>` (`App.openTeamSettings`, `O S`, “Current team settings” in the command menu).
- **Add team:** plus button at the right of the “Teams” header (visible on hover and keyboard focus, always on touch), `O N`, “Add team …” in the command menu. `App.openNewTeam` sets `newTeamOpen`; the dialog (`NewTeamDialog.svelte`, overlay chunk) asks for name, key (suggested from the name) and optionally a logo. The UI checks the key against the metadata immediately; the authority is `teams.create` in the backend (`assertKeyFree`, also under concurrent creation). The dialog then waits until the team appears in the metadata and switches to it with `switchTeam`. A logo rejected by the server does not block creation (toast “Team created, but the logo is missing”).
- **Motion (FLIP):** Elements with `data-flip="<key>"` are measured before the change (`$effect.pre`) and, in the next frame before painting, put back at their old position (`$effect` schedules `requestAnimationFrame`; by then the content on the right is in place too, and layout runs once). The same key at a different place slides (`translate`), new keys fade in staggered, removed ones stay briefly as a static, inert snapshot. Measuring only happens when the structure changes (other team, section expanded or collapsed), not on every page change and not on data changes (triage entry, new team). Nothing moves during loading until the app is in sync. The current team's block is rebuilt per team (`{#key}`), so the old team's snapshot shows its own entries.
- **One frame later:** On a team switch, the sidebar shows the new state only after the frame with the new content on the right (`deferredSidebar`). Rebuilding and starting the motion in the response frame otherwise cost about 3 ms (Chrome trace: painting and layers of the moving cards). Other sidebar changes (active entry, counts, section expanded/collapsed) apply immediately.

### Snooze

An issue with `snoozedUntil` is hidden until the server's morning job returns it ([backend.md](backend.md#invariants), rule 12). The client only needs the field, no clock: `VIEWS[kind].snoozed` is `'hide'` (inbox, triage, all, active, backlog, sprint, plan, project) or `'show'` (the Snoozed view, trash, sprint planning's right column and sprint completion, which must still decide on every open issue). `visibleFilter` applies it as one property check per issue, unless the filter **Include snoozed** (`Filters.snoozed`, URL `snoozed=1`, chip “With snoozed”) is on. `inInbox`/`unread`, the sidebar counts (inbox, triage) and the team card numbers (to do, started) leave snoozed issues out; the counter for the sidebar entry **Snoozed** (shown only while something is snoozed) is kept incrementally in `IssueStore.#count`. Search (`/`, command menu) and the issue page ignore the snooze.

- **Snoozing:** action `issue.snooze` (**H**, context menu “Snooze”, command menu, “Snooze” in the issue page properties and chips) opens the picker `snooze` (`palette.ts`): Tomorrow, Next week (Monday), In two weeks, In a month, the calendar (days up to today are disabled) and free input in the due date syntax (“+3”, “fri”, “12.10.”; today and earlier are not offered). In the context submenu, “Pick a date …” opens the picker with the calendar. All of them go through `Editor.snooze(ids, day)`, which is `patch({ snoozedUntil })` with a toast “KIU-12 snoozed until Mon, Oct 19” and Undo; a selection is one call and one undo step. `issue.unsnooze` (**Shift H**) clears it; **G H** goes to the Snoozed view. Closed issues are skipped (the backend refuses them); a status change to done also ends the snooze, and `patchEach` puts that into the same undo step as the priority.
- **Snoozed view:** `ViewKind` `snoozed`, ordering `snoozed` (day, then priority), column “Snoozed until” (`DisplayProp` `snoozed`, with the dates at the far right). History shows “snoozed it until …”, “ended the snooze” and, for the morning job, “brought it back from the snooze”.

### Inbox as split view (`inbox.ts`, `InboxSplit.svelte`)

- **Entries are their own table** (`inboxEntries`, [backend](backend.md#inbox)): one open entry per issue, opened when an agent creates the issue or changes it. The store subscribes to `inbox.list` and merges the entry into the issue as `issue.inbox` (derived like `key`: ignored when comparing with the server document, picked up by `#enrich`, so entries that arrive before their issue are not lost). `inInbox` = has an entry and is neither deleted nor snoozed (`snoozedUntil` unset: the entry waits until the morning job brings the issue back, unread, with the text "Back from snooze"); `unread` = and `readAt` unset. A change to the entry replaces the issue object, so views, rows and the counters follow through the normal change path. Removing (`Editor.removeFromInbox`, `issues.markReviewed`) and reading (`Editor.markRead`, `issues.markRead`) take issue IDs, update `inbox.list` optimistically (not the buckets) and change nothing on the issue itself. The sidebar count counts unread entries. The open entries are in the IndexedDB mirror's head, so the warm start shows the inbox.
- **Text and order:** a row says what happened (`inboxText`, `inboxText.ts`: "Aleister set the status to Done", "· 2 more changes" when several were grouped; the wording of one change is the activity feed's, `app/historyText.ts`, so English and German exist for every field). The inbox sorts by the entry's latest change ("Newest activity", the stored ordering value stays `created`), so a new change moves an old entry to the top and makes it unread.
- **When split:** `App.splitLayout()` = the “Inbox” page and a window at least `SPLIT_MIN_WIDTH` (1100 px) wide, not on mobile (`ShellState.split`). Below that the inbox behaves like any list: click and Enter open the issue as its own page.
- **Right side = normal detail:** `DetailController.split` (open/closed); it shows the list's focused issue (`#wanted`: detail page, otherwise split view, otherwise peek). `ListPage` renders `InboxSplit` with the list on the left and `IssuePage` (`split`) on the right, fully editable. If the target changes while the description is being edited, it is saved first. Clicking a row, J/K and Space show it on the right; Esc closes the right side (focus stays); Enter opens the issue's own page. The list including the split stays mounted (`ListPage.viewSplit`), so Back shows it unchanged. The mouse does not move the focus in the split view (otherwise hovering would switch the issue on the right).
- **Read:** after 250 ms on the right (`SPLIT_READ_MS`); paging past with J does not mark as read, and marking does not land in the frame of the switch. Peek and the detail page mark immediately, triage actions as a side effect. In the “Unread” filter, entries read during this visit stay visible (`ViewContext.keep`), otherwise focus and the right side would jump on and read the next one.
- **Empty list:** When the last entry is gone, the right side closes; an entry that arrives later does not open by itself (and is not marked read).
- **Actions** (“Inbox” section, all also in the command menu, with Undo): remove `⌫`/`E` (also the checkmark on the row and “Remove” at the top right), read/unread `U`, mark all read `Alt U`, remove read entries `⇧ ⌫`, “Done for today: clear inbox” (button in the header). “All” means all entries of the view including filters (`ListController.visibleIds`). The store sends more than 500 in chunks.
- **Width:** drag the divider, ←/→ on the focused divider, double-click resets; remembered in `Prefs.inboxSplit` (default 420 px), limited to at least 320 px list and 480 px issue. If the right side is narrower than 820 px, the properties sit as buttons above the description as on mobile (container query on the right side only, not on the list).

### Pull requests (`components/pr/`)

- **On the issue** (`IssuePullRequests.svelte`): per PR its state, checks as a dot, review decision, number of comments, “Conflicts”. The summary comes from `githubPr.summaries` (own subscription, started only after the frame in which the issue opens, like `IssueKnowledge`); `githubPr.refresh` with `maxAgeMs: 120000` triggers a fetch if the data is older.
- **Opening:** a click opens the PR next to the issue (`app.prSplit`, a slice in the core), another click closes it. On mobile, below `SPLIT_MIN_WIDTH` and in the split inbox it opens as its own page `/pr/<owner>/<repo>/<number>` (`PrPage.svelte`). Esc first closes the PR next to the issue, then the page. Switching to another page or to an issue without this PR (J/K) closes it.
- **Frame** (`PrHost.svelte`): wraps the issue page in `Shell.svelte` (chunk `pages.issueHost` = issue page + frame); without an open PR it contains only the issue. When a PR is open, the issue gets the class `split-detail` (container query as in the inbox: below 820 px properties as buttons), the PR on the right, width at the divider (drag, ←/→, double-click) in `localStorage xlr8:prSplit`.
- **View** (`PullRequestView.svelte`, own chunk `pages.prView`): subscription `githubPr.view({repo, number})`, `githubPr.refresh` on open (30 s). Header with state and conflicts, branches, +/− with a link “n files on GitHub” (the diff stays on GitHub), labels, requested reviews; a box with checks (expanded when something fails or is running; link to the log), mergeability and actions (method selectable and remembered in `xlr8:prMergeMethod`, delete branch, merge with confirmation, close/reopen); description; timeline of comments, reviews and line comments (long posts, e.g. from bots, collapsed); comment field (`TextEditor` without images).
- **HTML from GitHub** (`lib/prHtml.ts`, `PrHtml.svelte`): `body_html` runs through a separate DOMPurify instance (not the one used for Markdown): no scripts, forms, iframes or inline styles; links open in a new tab, images lazy, videos with controls, task checkboxes read-only. Images and videos from private repos point to the media proxy (`/ghmedia/…`), whose URLs do not expire. Clicking an image opens the image viewer in the same tab (`ImageViewer.svelte`, attached to `<body>`, modal): ←/→ page through the images of the same text, clicking the image shows the original size, Esc or clicking outside closes only the viewer (it captures keys before the app's shortcuts). Ctrl-click, middle click, small images and images that link elsewhere (badges) stay links.
- **Styles** in `styles/pr.css` (loaded with the issue page or PR view, never in the start bundle; `shared/pullRequests.ts` is excluded from the start chunk pattern in `vite.config.ts`).

### Dialogs keep the focus (`lib/modal.ts`)

All modal overlays share one foundation: the attachment `{@attach modal()}` on the element with `out:leave` (create dialog, “Add team”, the settings dialog `pages/settings/Dialog.svelte`, command menu and pickers in `Palette.svelte`). It

- **locks the background:** sets `inert` on all siblings along the path from the dialog up to `<body>` (mouse, keyboard, screen readers), with a counter per element so pickers inside the create dialog nest cleanly. Exceptions: live regions (`aria-live`, the toasts) and the dialog's own backdrop (`data-scrim`). Plus `role="dialog"` with `aria-modal="true"`.
- **keeps Tab inside the dialog:** Tab and Shift Tab cycle within the topmost dialog. The command menu and pickers don't (`trap: false`): there Tab selects an entry (`core/app/keys.ts`). If the editor already used Tab (lists, table cells), it is left alone.
- **sets the initial focus:** if nothing inside the dialog has focus when it opens, `[data-autofocus]` gets it, otherwise the first interactive element. The settings dialog focuses itself (`focus: false`), so “Revoke for good” is never preselected.
- **returns the focus:** on close, to the element that opened the dialog, unless the app deliberately moved the focus elsewhere. If the command menu opens a dialog, the dialog inherits the menu's trigger.
- **releases immediately:** when hiding (Svelte sets `inert` on the element), not only after the 90 ms of `leave`.

In the create dialog, Esc, × and clicking outside all close the same way (`create.close()`): with content, it becomes a saved draft. Only “Discard” in the footer deletes the content (`create.discard()`), with an “Undo” toast that brings back the dialog with its content; an empty dialog closes without a toast.

Esc closes as before (dialogs in `core/app/keys.ts`, the settings dialog on the element itself). Not modal: context menu, display options, peek and the language picker in the editor. New dialog: add `{@attach modal()}` and `aria-modal="true"`, mark the input with `data-autofocus`, and mark a backdrop that lies next to the dialog rather than around it with `data-scrim`. Tests: `e2e/tests/dialog-focus.spec.ts`.

### Undo/redo (`edit.ts`)

Entries: `patch` (before/after per issue; snooze is a patch of `snoozedUntil`), `move`, `remove`, `restore`, `create`, `review` (removed from the inbox), `read` (read/unread), `relation` (add/remove; for “Duplicate of” including the old status, which undo resets via compare-and-set). In the UI, redo is called “Redo” (not to be confused with “Repeat …” for recurring issues). An “Undo” toast belongs to exactly one entry: it disappears once that entry is undone, and a click only affects that entry. Undo sends `issues.revert` with `expect` = the app's own value (compare-and-set). If the server reports `conflict`, the app reads the issue's history and says who changed it in the meantime (“… was changed by Claude Code in the meantime”). Undoing “Create” moves the issue to the trash; redo brings it back. Every entry remembers page, filters, selection and focus; undo jumps back there.

### Description with version check (`detail.ts`, `bodyEdit.ts`)

Editing starts on the current `body.version` (base), in the editor (see below) at the clicked position. Without a mouse: the rendered text is a tab stop (a named group “Description” or “Page text”, not `role="button"`, because it contains links, checkboxes and language buttons); Enter or Space on it, and E on the issue page or wiki page (actions `issue.editDescription`, `wiki.editBody`, also in the command menu), start editing with the cursor at the end. In the inbox, E stays “Remove”. After Esc or “Done”, focus returns to the rendered text (`lib/bodyView.ts`). The peek card only displays the description. Autosave runs 0.9 s after the last keystroke and on leaving; Esc or “Done” saves and closes. If a foreign version arrives while editing (or the server answers `conflict`), a toast offers a choice: “Keep mine” saves on the new base version, “Take theirs” takes the other text (your own text goes to the clipboard). Your text is also kept in `localStorage` (`xlr8:desc:<id>`) until it is saved. The status line shows “Unsaved” from the first keystroke and “Saving …” while saving. Unsent comments are likewise kept per issue in `xlr8:comment:<id>` and removed after sending. In the activity feed, consecutive description changes by the same actor (at most 10 minutes apart) are merged into one line. The app's own optimistic update (version +1) does not count as foreign. The logic (autosave, draft, conflict) lives in `BodyEditSession` (`core/src/bodyEdit.ts`); the detail page and wiki pages use it with their own save function and draft key.

### Wiki (`app/wiki.ts`, `pages/wiki/`)

Teams can have a wiki (German UI: “Wissen”). Paths are `/team/KEY/wiki` and `/wiki/<id>`; the older `/wissen` paths still parse (`core/src/route.ts`) because they appear in links stored in texts.

- **Pages:** `/team/KEY/wiki` shows the team's page tree on the left and an overview (recently changed) on the right. `/wiki/<id>` is a page's permanent URL; the team follows from the page. Reachable via “Wiki” under the current team in the sidebar (only with `teams.wiki`, before “Settings”), `G W`, and the toggle in the team settings. Without a wiki, the page offers “Turn on wiki”.
- **Data:** only while a wiki page is open: the team's `wiki.list` (page rows without text, topics) and `wiki.get` for the page. Hovering a row in the tree preloads the page; the last eight stay subscribed (back and forth without waiting). Startup, sidebar and `meta.get` load none of this.
- **Tree:** `wikiTree.ts` (pure, tested in `core/test/wiki.test.ts`): visible rows from `parentId` and `rank`, expanded pages in `localStorage xlr8:wikiExpanded`. Dragging: top or bottom quarter of a row = before or after, middle = as a subpage (`dropTarget` → `wiki.move`). The plus on a row creates a subpage.
- **Page:** title inline (Enter saves), text like the description (editor, images with target `{ articleId }`, draft `xlr8:article:<id>`, conflict with choice), below it subpages and sources. “New page” creates a page titled “New page” and selects the title.
- **Project, topics, sources, revisions:** Below the title, the project (picked from the team) and the topics as chips with a picker; a new topic is created directly from the input. The tree can be filtered by project and topic (then a flat list; reset on team switch). The projects overview shows the number of pages per project (`wiki.projectCounts`, only for teams with a wiki) and links into the filtered wiki. Sources: add, edit, move up/down, remove. “Revisions” in the header: earlier revisions (20 at a time, “Load older”), preview and “Restore this revision” (creates a new version; the previous text becomes a revision itself).
- **Trash:** deleting takes the subpages along (toast with “Undo”); “Deleted” shows the wiki's own trash with “Restore”.
- **Keys:** on wiki pages, issue shortcuts do nothing (`App.targets()` is empty). E edits the page text.
- **Search:** `/` also searches the title and text of wiki pages (`wiki.search`, in parallel with the issue search, only if a team has a wiki); results in a “Wiki” section.
- **Linking:** in the editor, “/” → “Link wiki page” or `[[` opens the picker (palette `article`, results from the server) and inserts `[Title](<app>/wiki/<id>)`. When rendering (`markdownRender.ts`), links to `/wiki/<id>` (or the older `/wissen/<id>`) and `/issue/KIU-n` of the same app become chips with `data-nav`; `Markdown.svelte` opens them in the app without a modifier key. Bare identifiers of known teams (“KIU-106”, upper case, not in code) become links; the keys come from the metadata through `setLinkKeys`.
- **Wiki only** (`wiki: 'only'`): the team's card shows “Wiki” instead of counts, and only “Wiki” and “Settings”; clicking the card, switching team and `/team/KEY` lead into the wiki (`App.#redirectWikiOnly`). The team is left out when creating an issue, moving, accepting from triage, in recurrences, in sprint planning and on the board. Team settings: “Wiki: Off / Alongside issues / Wiki only” (no workflow with “Wiki only”); “Add team” asks “Issues / Issues and wiki / Wiki only”.
- **Backlinks:** on the issue, the “Wiki” section (`IssueKnowledge.svelte`, subscription `wiki.forIssue` only while the detail is displayed, not during preloading); on the page, “Mentioned in” and “Referenced issues” (`ArticleMentions.svelte`, `wiki.backlinks`).

### Editor (`app/src/lib/editor/`)

Description, comments (new and edit) and the create dialog are edited directly as formatted text. **Storage stays Markdown**; agents read and write through MCP as before.

- **Library:** ProseMirror directly (no TipTap/Milkdown); Markdown is parsed by the same parser as the renderer (`marked`, GFM, line break = break). Own chunk `RichEditor` (about 73 kB brotli with tables), loaded only when editing: clicking into the description (on `pointerdown`), focus in the comment field, “Edit” on a comment. Until then (and if loading fails) `TextEditor.svelte` shows the Markdown textarea and then switches to the editor, carrying over text and focus. The start bundle is unchanged.
- **Lossless:** `parse.ts` remembers the original text (`Source`) of every top-level block. `serialize.ts` writes unchanged blocks (same object, or same content after undo) back byte for byte, including the blank lines between them; only changed blocks are re-serialized. Escaping is minimal first (`5 * 3` stays as is); if the result parses differently, thorough (`5 \* 3`). The source's notation is preserved as attributes (`*`/`-`/`+`, `1.`/`1)`, `_`/`*`, `` ``` ``/`~~~`, bare links). Anything the editor does not know as a block (HTML blocks, link definitions) is shown as a source block and stays unchanged; inline HTML as a small code span. Round-trip tests: `app/test/editor-markdown.test.ts` over all Markdown files in the repo and `app/test/fixtures/markdown/`.
- **Usage:** input rules while typing (`# `, `- `, `1. `, `[ ] `, `> `, `` ``` ``, `---`, `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, URL + space = link), Ctrl B / I / E / K, Ctrl Shift 7 / 8 / 9 (numbered, bullets, checklist), Ctrl Alt 0–3 (paragraph, headings), Tab / Shift Tab (indent list, table cell), Shift Enter (line break), Ctrl Z / Shift Z. “/” at the start of a line or after a space opens the block menu (text, headings, lists, checklist, quote, code, table, divider, image). Pasted text is parsed as Markdown; pasting a URL over selected text makes a link. Tasks can be toggled in the editor and in the rendered view (description and own comments; `lib/tasks.ts` toggles the n-th `[ ]` in the source without loading the editor). Code blocks with a language are colored in the editor too (`codeRanges` in `highlight.ts`, same chunk and same colors as the renderer; [Syntax highlighting](#syntax-highlighting-libhighlightts-liblooksyntaxts)).
- **Code blocks:** the language sits as a button at the top right (`CodeView` in `views.ts`; without a language, “Plain text” on hover). It opens the language picker `components/LangPicker.svelte` with search, arrow keys, Enter and Esc. The list lives in `lib/languages.ts` (names, aliases, the TextMate grammar for `highlight.ts`). An unknown language stays selectable, and a searched one can be applied. Four ways back to text: Backspace at the start of the block, “Convert to text” in the picker, Ctrl Alt 0, and “/” → “Text” in an empty code block. Each line becomes its own paragraph (`codeToText`). Ctrl Shift \ toggles between code block and text. In code with content, “/” stays a character (comments, paths). In the rendered view (description, own comments) the same button opens the same picker without loading the editor. `lib/codeLang.ts` replaces the language at the n-th fence in the source, but only if the number of fences matches the rendered view; otherwise a toast asks to change the language in the editor.
- **Tables (`table.ts`):** when the cursor is in a cell, its top right corner shows a small button. It and right-click open the table menu: insert row above/below, column left/right (Ctrl Alt ↑ ↓ ← →), align column left/center/right, delete row (Ctrl Alt ⌫), delete column (Ctrl Alt ⇧ ⌫), delete table. The cursor jumps into the new row or column. Tab in the last cell appends a row. The `tableShape` plugin keeps the table in Markdown shape: exactly one header row at the top, alignment applies to the whole column.
- **Tasks:** the checkbox looks the same in the rendered view and the editor (`md.css`, 14 px, radius 4, checked = accent) and is vertically centered on the first text line (`margin-top: calc((1lh - 14px) / 2)`).
- **App keys:** in the editor, letters are just letters (`isEditable`). Esc first closes an open menu, then the editor (description: save and show the rendered view; editing a comment: cancel; otherwise leave the field). Ctrl Enter sends comments; in the create dialog it creates the issue.
- **Text out and in:** changes go to `onchange` as Markdown, batched for long texts (from 20,000 characters: 120 ms, immediately on Esc, Ctrl Enter, leaving). If a different text comes in through `value` (foreign version taken, an image finished outside, comment sent), the editor replaces its document. For tests, the editor element exposes `el.markdown` (computed on read).

### Pasting images (`app/src/lib/imageInput.ts`, `upload.ts`)

In the description, comments (new and edit) and the create dialog: **Ctrl V** with an image on the clipboard (text wins, e.g. table cells), **drag a file in**, or the **“Image”** button (file picker; on mobile also photos and camera). A field is an `ImageField` (insert images at the cursor, replace placeholders): the editor or, while it loads, the textarea (`textareaField`, `imageInput(target)` as a Svelte attachment). `TextEditor.svelte` forwards through its own field to whichever is current, so an image still uploading during the switch arrives in the editor. `ImageButton.svelte` is the button. Both are small; resizing, upload and error handling live in `upload.ts`, loaded only with the first image.

Flow per image: at the cursor (on its own line) `![Uploading name …](#upload-<id>)` appears immediately (in the editor as a hint); draft and autosave run as when typing. In the browser: PNG, JPEG, WebP, GIF only; longest edge at most 2560 px, otherwise (or from 300 KB) re-encoded as WebP (quality 0.86); JPEGs are always re-encoded (dropping camera metadata); GIFs unchanged. Then `files.generateUploadUrl` → POST → `files.register` (the backend checks again) → the placeholder becomes `![name](<site>/img/<token>)`. On error the placeholder becomes `![Upload failed: name](#upload-<id>)`, and a persistent toast names the reason and offers “Try again”. If the field is no longer open when the upload finishes (editor closed, paged on, comment already saved), `upload.ts` replaces the placeholder wherever the text now is: description in the editor, local draft, saved description, own comment or create draft. “Comment” waits while an image is in flight.

The placeholder alt texts come from `app/src/lib/uploadNote.ts` and are stored in the Markdown in the language of whoever inserted the image; a failed placeholder is recognized in English and in the active language.

### Showing images and Drive videos (`app/src/lib/markdown.ts`, `Markdown.svelte`)

- Images: `loading="lazy"`, `referrerpolicy="no-referrer"`, at most as wide as the text, with a fine border (light image on dark background and vice versa). Clicking opens the image full size in a new tab. In the peek at most 96 px high. `#upload-…` placeholders render as a hint (“Uploading …” or red “Upload failed …”), not as a broken image.
- **Google Drive:** a link `https://drive.google.com/file/d/<ID>/…` **alone on a line** (bare, in `<…>` or as `[text](link)`) becomes a player. The Markdown renderer (`marked` extension `drive`) only emits a placeholder with an “Open in Drive” link (DOMPurify still forbids `iframe`; there is no arbitrary HTML). `driveEmbeds()` inserts the player `https://drive.google.com/file/d/<ID>/preview` only when the placeholder becomes visible (IntersectionObserver, 200 px margin). Links inside a sentence and other URLs stay links. The “Open in Drive” link always stays below the player: a fallback when Drive won't show the file embedded (see [operations.md](../operations.md#images-and-videos)).
- **CSP** (`app/index.html`, `<meta http-equiv>`): `frame-src https://drive.google.com https://challenges.cloudflare.com https://*.protect.clerk.com; object-src 'none'; base-uri 'self'`. Only Drive videos and Clerk's bot protection at sign-in may be embedded (without the two Clerk origins, sign-in breaks whenever Clerk shows a challenge).

### Syntax highlighting (`lib/highlight.ts`, `lib/look/syntax.ts`)

Code blocks in the rendered view, in the editor (ProseMirror decorations) and in GitHub HTML of the PR view (`div.highlight-source-<lang> > pre`, `PrHtml.svelte`) are colored by Shiki with the TextMate grammars and the VS Code theme from the appearance settings, so they look as in the editor: same tokenization, context selectors (`meta.tag string`), italic, bold and underline included.

- **Loading:** `highlightLoad.ts` (small, `needsHighlight`, `loadHighlight`) decides from the text which grammars are needed (`fenceGrammars`: known language, not claimed by another renderer) and imports `highlight.ts` (Shiki core), the engine and each grammar on demand. Nothing of it is in the start bundle, a text without a code block with a language loads nothing, and a text with only `ts` loads no Python. The engine is Oniguruma as WebAssembly (`highlightEngine.ts`; the `.wasm` file is its own asset and fetched there, because the engine remembers a failed load for good), the one VS Code uses. Switching to Shiki's JavaScript engine is a one-line change in `highlightEngine.ts` (about 90 kB brotli smaller; on about 1,200 real files from this repository and others only SQL and Python showed differences in a few characters).
- **Until it is loaded** a block is neutral text in the same `pre` (same lines, same font), so nothing moves when the colors arrive. `highlightCode(code, info)` and `codeRanges` are synchronous afterwards and return `null` while a grammar is missing.
- **Both modes in one HTML:** every token carries its dark and its light color as custom properties (`<span class="tk" style="--d:#ff79c6;--l:#cf222e">`, font style as `tk-di`/`tk-li` …); `md.css` picks one by `data-theme`, so the light/dark switch needs no new HTML. Code in the plain color has no span. DOMPurify lets `style` through only on `span.tk` and only in this form (`TOKEN_STYLE` in `codeblock.ts`).
- **Theme:** `Look.syntaxThemes()` / `Look.syntax` (`look/index.ts`) provide `SyntaxSet` (dark and light). `syntaxTheme()` (`look/syntax.ts`) takes the VS Code theme's `tokenColors` unchanged and only lifts each color to 3 : 1 against the code block background (`MIN_SYNTAX`, as before; the fixes show up in the settings). Color changes in the settings (`syn-*`) replace the colors of the theme's rules inside that category (longest matching scope, `categoryOf`; operators keep the theme's own color, only `new`, `typeof` and similar count as keywords), and a rule behind them with the old scope list covers what the theme does not set. Without a VS Code theme the Selfbound palette is a small rule list (`selfboundSyntax`) whose colors are the `--sx-*` variables from `md.css` (chained to `--syn-*`), so it follows hue and accent like everything else. `look/map.ts` still derives the eleven `--syn-*` colors for the theme previews and swatches in the settings.
- **Theme change:** `render()` sets a new `SyntaxSet` (only if it colors differently: a slider tick for UI colors does not trigger anything); `highlight.ts` loads it and reports `onChange`; `markdown.ts` clears its cache and bumps `highlightVersion()`, `Markdown.svelte`, `PrHtml.svelte` and the editor plugin color again.
- **Another renderer for a fence language** (diagrams): `claimFence(lang, render)` in `codeblock.ts`. The renderer returns the block's HTML, or `null` to leave it to the code block renderer. A claimed language never reaches Shiki and does not cause loading.
- **Limits:** tokenizing runs on the main thread once per mode, so code over 20,000 characters stays neutral, in the editor (every keystroke) over 10,000. Languages are those of `lib/languages.ts` (`grammar` is Shiki's language name and needs an entry in `GRAMMARS` in `highlight.ts`; a test checks that).
- **Licenses:** Shiki, `vscode-textmate` and the Oniguruma WebAssembly are MIT. The grammars come from `@shikijs/langs` (`tm-grammars`), each under its own license: TypeScript, JavaScript, CSS, HTML, XML, JSON, Shell, SQL, Python and Markdown from `microsoft/vscode` (MIT); Diff from `microsoft/vscode` (MIT); Kotlin from `fwcd/vscode-kotlin` (MIT); Svelte from `sveltejs/language-tools` (MIT); Vue from `vuejs/language-tools` (MIT). **YAML** comes from `textmate/yaml.tmbundle`, which has no license file; VS Code, GitHub and many editors ship the same grammar, but its terms are not stated.

## Routes

| Path | Page |
|---|---|
| `/` | Inbox or the last visited view (`localStorage xlr8:lastView`). In production only with the `xlr8_signed_in` marker, otherwise the sign-in page (see [Sign-in page](#sign-in-page-welcomehtml-srcwelcome)) |
| `/sign-in?redirect_url=/issue/KIU-106` | Sign-in (welcome.html), then back to `redirect_url` |
| `/welcome` | Sign-in page, local only (dev and `vite preview`); in production at `/` |
| `/inbox` | Inbox (created by agents and snoozed issues that came back, until the user removes the entry); split view on wide screens |
| `/snoozed`, `/team/KIU/snoozed` | Snoozed issues, soonest return first ([below](#snooze)) |
| `/triage`, `/team/KIU/triage` | Triage |
| `/all`, `/active`, `/backlog` | Across teams |
| `/team/KIU` (= active), `/team/KIU/all`, `/team/KIU/backlog` | Team |
| `/team/KIU/projects`, `/team/KIU/project/<id>` | Projects, issues of one project |
| `/team/KIU/wiki`, `/wiki/<id>` | A team's wiki, one page (permanent URL without team); older `/wissen` paths still work |
| `/issue/KIU-106` | Detail (old identifiers are redirected through `issues.resolve`) |
| `/pr/<owner>/<repo>/<number>` | Pull request full size; only PRs Selfbound knows (linked to an issue) |
| `/sprint` | Current sprint: header (goal inline, points done/total, issues, capacity, share added later, date range), list grouped by “Planned” / “Added later” (`grouping: 'scope'`, from `sprints.items`), then by status |
| `/sprint/plan`, `/sprint/plan/5` | Planning of the next (or the given) sprint in planning; without one: “Create sprint” |
| `/sprint/close` | Closing the current sprint with a decision per open issue |
| `/sprints` | All sprints (current, in planning, closed, imported Linear cycles) with goal, date range, points, share added later |
| `/trash`, `/drafts` | Trash, drafts |
| `/settings[/<section>[/<team>]]` | Settings: `general`, `appearance`, `notifications`, `teams` (`/settings/teams/ACME`: one team with logos), `projects`, `labels`, `recurrences`, `agents`, `github` (connection, repos, webhooks), `ops`. The old German ids (`allgemein`, `darstellung`, `benachrichtigungen`, `projekte`, `wiederholungen`, `agenten`, `betrieb`) still work as aliases |
| `/new?title=…&priority=high&status=todo&team=KIU&label=Bug&project=…&estimate=3&due=tomorrow` | Create with prefilled fields |
| `/share?title=…&text=…&url=…` | Share from another app (Web Share Target): creates an issue in the inbox, then `/inbox` |
| `/oauth/consent?request=…` | Consent page for connectors (claude.ai, ChatGPT), outside the app shell; old path `/oauth/freigabe?anfrage=…` still works |

Filters and display as query parameters: `status`, `prio`, `fteam`, `label` (name if unique, otherwise ID; both are read), `project`, `sprint`, `unreviewed=1`, `snoozed=1`, `q` (quick search), `group`, `order` (only when different from the view's default). Vite dev and `vite preview` serve `index.html` for all paths (`appType: 'spa'`); on Vercel the app is renamed to `app.html` at deploy time (`deploy/web/vercel.json`, see [Landing page and sign-in](#landing-page-and-sign-in-welcomehtml-srcwelcome)).

## Extension points

### New action (shows up automatically in shortcuts, command menu, context menu, help)

```ts
import { registerAction } from '@selfbound/core';
import { msg } from '@selfbound/core/i18n';

registerAction({
  id: 'sprint.start',
  label: msg('Start sprint'),       // English, marked with msg(); translated at display time
  section: 'General',
  keys: ['mod+shift+s'],            // optional; two-key sequences as 'g x'
  icon: 'sprint',                   // name from ICON
  context: [6, 1],                  // optional: position in the context menu [group, order]
  picker: undefined,                // or e.g. 'status': submenu in the context menu + values in the command menu
  when: (app) => app.nav.page.get().name === 'view',
  run: (app) => { /* … */ },
});
```

Actions always operate on `app.targets()`; if they change issues, they do so through `app.edit.*` (undo and error toast included). Actions are registered at module level, so labels are marked with `msg()` (not `t()`) and translated when shown; add the German translation to the dictionary (see [Internationalization](#internationalization)).

### Two lists on one page (sprint planning)

`app.main` is the page's list (URL, filters, display), `app.side` a second `ListController` instance without a URL (`side: true`) that only computes while it is needed (`idle`). `app.list` is the one currently in use (`app.pane`: click, mouse, Tab); all actions, `app.targets()`, peek and undo go through it to the right column. Components get the list as a prop (`ListView list={…} drop={…}`, `IssueRow list={…}`). Planning uses the views `plan` (backlog: open, accepted, without sprint, active teams, by rank) and `planned` (contents of the planned sprint); scheduling is `edit.patch(ids, { sprintId })` (optimistic, with undo), reordering is `issues.reorder`.

### Sprint chunk and late actions

What only the sprint pages need is not in the start bundle: `app.loadSprints()` loads `core/src/app/sprints.ts` (the page loaders in `app/src/lib/pages.ts` wait for it). The chunk registers the keys of these pages itself through `registerAction`. Actions available everywhere (command menu “Plan sprint”, “Start sprint”, “Close sprint”, “Add to sprint”) live in `actions.ts` and load the chunk on demand. Same pattern: `uFuzzy` (`loadFuzzy()`, simple substring search until then), `app/src/components/overlays.ts` (context menu, create, display, peek; loaded right after startup), perf overlay and mobile bar.

### Priority budget

When setting Urgent/High (also on create), `edit.patch` checks locally with `budgetCheck` (same rule as `budget_warning`): over budget, a toast shows the existing candidates and “Downgrade …” (picker `downgrade`, lowers by one level). It never blocks. Team groups (e.g. “All issues”) show “Urgent 1/1 · High 3/3”; planning shows it per active team.

### New list (view)

1. Add the `ViewKind` in `types.ts`.
2. Add an entry to `VIEWS` (`views.ts`): `includes`, `display`, `groupings`, `orderings`, `style`, `createDefaults`, `emptyText`.
3. Add the path in `route.ts` (`parsePath`, `viewPath`).
4. Optional: a sidebar entry (`Sidebar.svelte`) and a `go.*` action. Team pages make their team the current one automatically (`App.onPage`).

The list, peek, filters, display options, undo and all shortcuts then work without further work.

### New page (sprint planning, ops, settings section)

1. Extend `Page` in `route.ts` (`parsePath`, `pagePath`).
2. Component under `app/src/pages/`, registered as a chunk in `app/src/lib/pages.ts` and mounted in `Shell.svelte` with `{#await pages.x() then m}`.
3. Data: own slices in a new module `core/src/app/<name>.ts` (e.g. `sprints.ts` with subscriptions `sprints.list`/`sprints.items`), instantiated in `App`. For issue lists inside the page, reuse `computeVisible`/`computeList`.
4. Settings: an entry in `app/src/pages/settings/sections.ts` plus a case in `SettingsPage.svelte`, each section a component under `pages/settings/`. On settings pages the left navigation (`SettingsNav.svelte`) replaces the sidebar. Operations through `admin` (`pages/settings/admin.ts`, class `Admin` from `@selfbound/core/app/admin`), data through `useQuery` or `app.store.meta`. Team logos: `Admin.uploadLogo` (browser pre-check → `teams.generateLogoUploadUrl` → `fetch POST` → `teams.setLogo`; the server's message appears at the field). Logos are always displayed as `<img>` through `TeamLogo.svelte` (14/16/20/32/40 px); the URL points to `GET <site>/logo/<id>`.

### New picker (e.g. milestone)

Extend `PaletteKind`, add a case in `PaletteController.pickerItems` (values, `checked`, `run` via `apply(patch, target)`), and an action with `picker: '<kind>'`. The same picker then works by shortcut (centered), by click (anchored, `anchor`), in the context menu (submenu), in the command menu (second level) and in the create dialog (`target: { kind: 'draft' }`).

## Internationalization

Code: `core/src/i18n.ts`, loader `app/src/lib/i18n.ts`, dictionaries `core/src/locales/de.ts` and `app/src/locales/de/*.ts`.

- **Gettext style:** the English text is the key. English needs no dictionary and adds nothing to the start bundle. German is a dictionary (English → German) loaded as one lazy chunk (`app/src/locales/de/index.ts` merges `core/src/locales/de.ts` with `app/src/locales/de/{shared,lib,components,pages}.ts`).
- **Choosing the language:** the preference `locale` in `Prefs` (`localStorage xlr8:prefs`) is `'en'`, `'de'` or `'auto'` (default). `resolveLocale` takes an explicit choice, otherwise the first of `navigator.languages` that is English or German, otherwise English. `app/src/lib/locale-ready.ts` calls `startLocale` with a top-level `await`, and `app-instance.ts` imports it first, so the App and its first labels are created with the right dictionary: English continues at once; for German the dictionary chunk is loaded first, and if it cannot be loaded (offline on first start) the app falls back to English. `<html lang>` follows. The language picker is in Settings › General (`data-testid="settings-locale"`, names from `LOCALE_NAMES`).
- **API:** `t('Text {name}', { name })`; `tn(count, '{count} issue', '{count} issues')` for plurals (German entry `['{count} Issue', '{count} Issues']`); `tc('verb', 'Open')` when the same English needs different German in different places (dictionary key `[ctx('verb', 'Open')]`); `translated({ urgent: 'Urgent', … })` for constant label maps whose getters translate on every read; `msg('…')` marks a string for extraction and is translated later with `t(value)`.
- **Never call `t()` while a module is evaluated** (top-level constants, module-level arrays of objects, `<script module>`): the dictionary is not loaded yet. Call it at render or call time, or use `translated()`. Strings looked up before the dictionary is set are reported in the console as `[i18n] translated before the dictionary was loaded: …`. Svelte component `<script>` blocks run at mount time and are fine.
- **Placeholders** are `{name}`, and the German entry must use the same set. Interpolate through params, never by concatenating translated fragments (word order differs).
- **Dates and numbers:** `intlLocale()` (`de-DE` or `en-US`) instead of hard-coded locales.
- Keyboard shortcuts are the same in both languages. Command search keywords may contain English and German synonyms.
- **Hot paths:** a lookup is cheap, but hoist `t()` out of per-row render code (rows of a 10,000-issue list) into the component script where possible.
- **Check:** `node tooling/i18n-check.mjs` scans `app/src`, `core/src` and `backend/convex/shared` for literal keys in `t()`, `tn()`, `tc()`, `msg()` and `translated({...})` and reports keys without a German entry, placeholder mismatches, `tn()` keys without a `[singular, plural]` entry and keys translated differently in two dictionary files. German entries whose key is not found as a literal are only a warning (labels may be translated through a variable). `--verbose` lists more.
- Backend texts read outside the UI (push notifications) are English by default and German with the Convex env var `XLR8_LOCALE=de` (see [backend.md](backend.md)).

## Design

Tokens in `app/src/styles/app.css`: colours from base hue/chroma, accent and contrast (OKLCH), light and dark as two ramps. Dimensions: sidebar 244, inset panel with 8 px gap and radius 12, headers 44, list row 44 without dividers, group header 36 with a status colour gradient, popover radius 12, menu items 32 (anchored) or 40 (centered). Font Inter Variable (510/590). Font size small/normal/large via `data-font` (row heights stay, so windowing stays correct). Mobile at ≤ 768 px: drawer, full-screen detail, floating bar at the bottom, rows 52. Logo and icons: [brand.md](../brand.md).

## Performance rules

1. **No work in components.** Filtering, sorting, grouping, building strings: in the core. Components read slices.
2. **One row = one slice** (`list.rows.get(id)`); a change updates exactly one row (e2e tests in `e2e/tests/list.spec.ts` and `e2e/tests/layout.spec.ts`: a status change, or an agent changing the priority, touches exactly one row in the DOM). Focus and selection only flip their flag in the row state. Slices without subscribers (row scrolled out) are dropped by `SliceFamily` at the next recompute.
2a. **Flat rows** (`IssueRow.svelte`, `lib/rowHtml.ts`): team logo/identifier and title with the right side are built as an HTML string (all user text through `esc`); checkbox, priority and status are fixed elements whose class changes. Icons are CSS masks on `::before`, no inline SVG. Only visible properties go into the DOM (`data-props` on the list hides priority/status). About 20 instead of 63 nodes per row. The row recognizes clicks through `data-cell`; long press and logo load errors are caught by the list (one listener instead of four per row).
2b. **Right side of the row:** flex from right to left, wrapping into a clipped second line: whatever doesn't fit drops out as a whole, labels first. Title and right side shrink proportionally; nothing overlaps the title.
2c. **Label stack** (`labelStackHtml`, shared by list rows and board cards; styles in `app.css`, “Label stack”): up to three chips in their natural width, each overlapping the end of the one before it (the chip's right padding is what disappears under its neighbor). When the room is short the chips shrink (plain flex shrink) and slide further under their right neighbor, down to the colored dot; the last one stays whole. More than three labels end in one “+n” chip with overlapping dots, the names in its tooltip. No measuring in JS. A tap on the stack (not a mouse click) opens the label picker (`data-cell="labels"`, `cellOf` in `lib/ui.ts`), which is how touch screens get to the names.
3. **Frozen issues, no deep proxies.** New objects only on real changes (`sameIssue`).
4. **Reuse instead of rebuild:** `reuseList`, `#all` in the store, `IssueSearch.prepare(version)`, `teamBadge` cache.
5. **Fixed row height, windowing in the core** (`computeWindow`); with unknown height assume the window height.
6. **Menus show at most 50 entries** (help 200).
7. **Visible change first, then network** (optimistic), no spinner for local work. Skeleton only on a cold start without data.
8. **Code splitting and startup order:** detail page (with its own CSS `detail.css`), projects, drafts, settings (with own CSS), sprint pages and sprint logic (with own CSS), overlays (with `overlays.css`), uFuzzy, Markdown (`marked` + `DOMPurify`), the editor (`RichEditor`, ProseMirror), Clerk and the German dictionary are separate chunks. Code blocks are colored with Shiki (own chunk `highlight` of about 30 kB brotli, the regex engine as a separate `.wasm` file of about 105 kB brotli and one chunk per grammar, see [Syntax highlighting](#syntax-highlighting-libhighlightts-liblooksyntaxts)); they load only when a visible text contains a code block with a known language, and only the grammars that text uses (`app/src/lib/highlightLoad.ts`, `markdown.ts`); without a language the block stays neutral. `Markdown.svelte` inserts the copy button after DOMPurify. None of this loads at startup: only once all buckets are in sync (at the latest after 3 s) do the overlays load, then when idle uFuzzy, detail, Markdown and, only with a running sprint, the sprint header (`app/src/main.ts`). The first key press or click loads the overlays immediately; the shell mounts them through `overlaysLoaded` without triggering the import itself. Font: only Inter latin/latin-ext (`styles/fonts.css`); latin is preloaded in `index.html` (plugin `preloadFont` in `vite.config.ts`). What startup needs is bundled by `app/vite.config.ts` into one `start` chunk (`codeSplitting.groups`; without it, it falls apart into several small files). Exclude new modules that only subpages need from that pattern.
9. **Measuring:** `?perf=1` shows the overlay; `node e2e/tools/bench.mjs <url>` measures the core actions against `--seed large` (with `THROTTLE=4` CPU throttling), `node tooling/bundle-size.mjs` the start size. The full performance harness: [perf/README.md](../../perf/README.md).
10. **Identifier column:** `keyColumnWidth` (`app/src/lib/ui.ts`) measures the width on a canvas (no measuring element in the DOM that would force layout on first paint) using patterns per team key (“NOVA-0000”, `keyWidth` in `query.ts`), cached per pattern and font size; identifiers are never truncated.
11. **No layout work per frame:** rows with `contain: strict`, checkbox via `visibility` instead of `display` (J/K without layout), a mask image per icon class instead of `var()` in the `mask` shorthand (that would be re-parsed on every style recalc). Avoid long tasks in idle time (mirror in batches).

## Authentication

`core/src/auth.ts`: locally `VITE_DEV_TOKEN` (only set by `tooling/local.mjs`), otherwise Clerk through `@clerk/clerk-js/no-rhc` (headless) with `VITE_CLERK_PUBLISHABLE_KEY` and the JWT template `convex`. The value is a single key or a list `host=key,…`; `app/src/publishableKey.ts` picks the key for the current host (useful during a domain change, when two Clerk instances run side by side). When signed out, the app goes straight to the sign-in page `/sign-in?redirect_url=<url>` (`auth.signIn`); `LoginScreen.svelte` only shows “not set up” and “no access”. When signed in, the app sets the cookie `xlr8_signed_in=1` (not a secret, only a marker for routing); it deletes it when signed out, rejected or on sign-out.

## Sign-in page (`welcome.html`, `src/welcome/`)

A separate entry next to `index.html`, without Svelte, Convex or the core: the sign-in page loads nothing from the app's start bundle, and the app nothing from it. It is deliberately plain: a logo, the Clerk form and one line of text, on a static dot grid (CSS), no marketing. `noindex`. The public landing page is a separate static site, see [site/README.md](../../site/README.md). `src/welcome/main.ts` loads the sign-in form right away.

- **Routing:** in production Vercel decides: `/` without the `xlr8_signed_in` cookie → `welcome.html`, otherwise `app.html` (the app; `deploy-web.mjs` renames `index.html` at deploy time, because Vercel always serves an existing `index.html` at `/`). `/sign-in` → `welcome.html`, all other paths → `app.html`. Deep links therefore keep working.
- **Signed out on a deep link:** a small script in the head of `index.html` (only in the production build with Clerk, `signedOutGuard` in `vite.config.ts`) checks the marker and, without it, goes straight to `/sign-in?redirect_url=…` before the app loads. If the marker is stale, the app notices after Clerk has loaded and takes the same route.
- **Sign-in form:** `src/welcome/signin.ts`. Since version 6, clerk-js ships no UI; `@clerk/ui` (with React) provides it and is loaded only here, dynamically after the page script. `mountSignIn` with `routing: 'hash'` (no subpaths needed), `withSignUp: false`, styled through `appearance` with the page's colours, light and dark. Clerk's redirects go through `routerPush`/`routerReplace`: set the marker first, then navigate, otherwise `/` would show the sign-in page again. `safeRedirect` (`session.ts`) only allows same-origin paths.
- **Consent page for connectors** (`/oauth/consent`): uses the same sign-in (signed out → `/sign-in?redirect_url=/oauth/consent?…` → back).
- **Local:** the dev and preview servers serve `welcome.html` at `/welcome` and `/sign-in` (`welcomeRoutes`); `/` stays the app. Without Clerk (test sign-in), the page shows a hint with a link into the app.
- **Separate build:** `pnpm build` first builds the app (`vite.config.ts`), then the sign-in page (`vite.welcome.config.ts`) into the same output. Built together, both shared chunks (Vite's preload helper ended up in the app's start chunk and the sign-in page loaded it too). In the sign-in page build, Clerk sits in two chunks (`clerk-js`, `clerk-ui`) instead of over a hundred small files. Shared plugins: `vite.plugins.ts`.

## Installable app, service worker and notifications

- **Manifest** (`app/public/site.webmanifest`, generated by `tooling/brand.mjs`): `id`/`start_url`/`scope` `/`, `display: standalone`, shortcuts Inbox and New issue, `share_target` (GET `/share?title&text&url`). Icons as in [brand.md](../brand.md), plus `badge-96.png` (white star, for the status bar on notifications). The status bar colour (`meta theme-color`) follows the theme: inline script in `index.html` and `Prefs.apply` (`THEME_COLOR` = `--bg-panel` light/dark).
- **Service worker for push only** (`app/sw/sw.js`, JavaScript with JSDoc, type-checked through `app/sw/tsconfig.json`): the `pwaFiles` plugin (`vite.plugins.ts`) emits it with the build ID as `/sw.js`, plus `/version.json`. Registered with the scope **`/push/`**, so it controls no page of the app. A controlling SW made every warm start 16–40 ms slower, even without any fetch handler, so the project keeps startup unchanged instead. Consequences: no custom offline page (without network the browser shows its own page), `navigator.serviceWorker.ready` never resolves (use `registration()` in `lib/pwa/push.ts` instead), messages to windows go through `clients.matchAll({ includeUncontrolled: true })`. Selfbound is installable anyway (Chrome does not require a controlling SW).
- **Push in the SW:** `push` shows the notification (`tag` replaces an older one with the same tag, `renotify`), unless a Selfbound window is visible and focused: then that window gets it as an `xlr8-push` message (toast with sound). `notificationclick` focuses an open app window and sends `xlr8-open` with the path (the app navigates through `Navigator.open`, with filters from the URL); otherwise it opens a new window.
- **Offline:** in the open app, “Offline” or “Offline · n pending” appears in the sidebar on desktop and above the toasts at the bottom on mobile (`Toasts.svelte`, `mobile-sync-state`).
- **App part** `app/src/lib/pwa/` (own chunk, loaded by `main.ts` when idle after the first list; the SW is not registered in the Vite dev server or with `?sw=0`):
  - `index.ts`: registers the SW (and removes an old registration with scope `/`), SW messages, **presence** (`push.presence` every minute while visible and with input in the last 3 minutes; unregisters at once when hidden), **notifications in the app** (subscription `push.recent`; a visible window shows them as a toast with “Open” and the `notification` sound, and confirms them with `push.seen`), **new version** (on return, at most every 10 minutes, `/version.json` against `__SELFBOUND_BUILD__`; reloads if there is no dialog, no focused input and no pending change, otherwise a “Reload” toast), **closing read notifications** (notification for an issue that was read, removed or is currently open).
  - `push.ts`: turning push on and off on this device (`PushManager.subscribe` on the `/push/` registration with the public VAPID key from `push.config`, recorded via `push.subscribe`), device name, reconciliation at startup (server no longer knows the device or has a new key → resubscribe).
  - `share.ts`: sharing. `main.ts` remembers `/share?…` before startup and rewrites the URL to `/inbox`. After the metadata has loaded, `issues.share` creates the issue (title from `title`, otherwise the first text line without a link, otherwise the URL; link and text into the description; team = current team; `requestId` per content remembered in `localStorage` for 10 minutes, so sharing twice or “Try again” never creates a second issue). Toast with “Undo”.
- **Missing chunks after a deploy:** Vercel replaces `assets/`; if loading a chunk fails (`vite:preloadError`), `main.ts` reloads the page once (at most every 30 s), but only when online and with no pending changes. Otherwise the chunk reports the error itself and offers “Try again” (`components/Lazy.svelte`).
- **Settings › Notifications** (`pages/settings/Notifications.svelte`): toggle for this device, test notification, events from `backend/convex/shared/notifyEvents.ts` (new ones appear automatically), device list.
- **Tests:** `app/test/pwa.test.ts` (share parsing, device name, manifest), `e2e/tests/pwa.spec.ts` (installable, SW controls no page, “Offline” on mobile, sharing, tapping a notification, toast in the open app, settings, new version). All other e2e tests block the SW (`serviceWorkers: 'block'`).

## Tests

- `pnpm --filter @selfbound/core test`: Vitest, including per-field comparison, pending issues, undo/conflict with agent name, description conflict, search with 2–6 character identifiers, windowing with unknown height, focus while loading, detail subscription cleanup, routing, mirror with schema version.
- Images and Drive: `e2e/tests/images.spec.ts` (real Ctrl V from the clipboard, dragging, button, resizing to 2560 px WebP, error with “Try again”, SVG rejected, peek, Drive player only on scroll, CSP); mobile: `mobile.spec.ts`.
- `pnpm e2e`: Playwright against its own backend (port 13470, `tooling/local.mjs --dir e2e/.backend --no-env`) and a test build (`vite preview` on 5472). `E2E_KEEP=1` keeps both running, `E2E_SKIP_BUILD=1` skips the build. Other ports (e.g. parallel worktrees): `E2E_BACKEND_PORT=13510 E2E_APP_PORT=5512 pnpm e2e`. Sprints: `e2e/tests/sprint.spec.ts`, settings: `e2e/tests/settings.spec.ts`.
- Sprint page performance: `node e2e/tools/bench-sprint.mjs <url> [repetitions]` against `--seed large`.
- Screenshots: `node e2e/tools/shoot.mjs <url> <dir> [scene …]` (`SCALE=2`, `CLIP=x,y,w,h` for crops).
