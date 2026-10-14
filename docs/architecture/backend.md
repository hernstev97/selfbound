# Backend (Convex)

Code: `backend/`

This document is the contract between the backend and the UI. It describes the tables and rules, every public function with its arguments and return value, error codes, actors, idempotency, the sprint rules, the test data and how to run the backend locally.

## Layout

| Location | Contents |
|---|---|
| `convex/schema.ts` | Data model (authoritative) |
| `convex/ops/*.ts` | Shared operations `(ctx, actor, args) => result`. UI mutations and MCP call the same functions; only the identity check in front of them differs. Not Convex functions themselves. |
| `convex/<module>.ts` | Public API (only through `ownerQuery`, `ownerMutation`, `ownerWriteMutation`, `ownerAction`) and internal functions |
| `convex/lib/*.ts` | Helpers: auth, errors, value equality, rank, counters, idempotency, test switches, identifiers, calendar days, logo validation, keys |
| `convex/shared/constants.ts` | Constants shared by backend, core and UI (also run in the browser) |
| `convex/crons.ts` | Scheduled jobs |
| `convex/http.ts` | HTTP endpoints `/mcp`, `/github`, `/logo/<id>`, `/img/<token>`, `/health` ([below](#http-endpoints-convexhttpts)) |
| `convex/files.ts`, `convex/ops/files.ts`, `convex/lib/image.ts` | Images in descriptions and comments: validated upload, references, cleanup ([below](#files-images)) |
| `convex/wiki.ts`, `convex/ops/wiki.ts`, `convex/lib/wikiText.ts` | Knowledge base: pages per team as a tree, text with revisions, sources, topics, search, trash ([below](#wiki-knowledge-base)) |
| `convex/lib/search.ts` | Search terms, "contains all words" matching and snippets for `issues.search` and `wiki.search` |
| `convex/mcp.ts`, `convex/ops/mcp.ts`, `convex/lib/mcp/*` | MCP: read tools as a query (after a counting mutation), write tools as one mutation, tools mapped onto the shared operations ([`mcp.md`](mcp.md)) |
| `convex/github.ts`, `convex/ops/github.ts` | GitHub webhook: one delivery per transaction |
| `convex/githubPr.ts`, `convex/ops/githubPr.ts`, `convex/lib/githubApi.ts`, `convex/lib/githubMedia.ts`, `convex/shared/pullRequests.ts` | Pull requests in Selfbound: fetching via the GitHub API, view, actions, media proxy, webhooks in all repos ([below](#githubpr-pull-requests-in-selfbound)) |
| `convex/importer.ts`, `convex/ops/import.ts` | Linear import: staging → tables ([`import.md`](import.md)) |
| `convex/opsStatus.ts` | Reports for the ops page (backup) |
| `convex/migrations.ts` | One-off data migrations (internal, safe to rerun), e.g. `workflowBackfill`/`workflowVerify` ([statuses](#statuses-per-team)), `inboxBackfill` ([inbox](#inbox)) |
| `convex/inbox.ts`, `convex/ops/inbox.ts`, `convex/ops/inboxChanges.ts` | Inbox entries: list, read, remove, undo, cleanup (`inbox.ts`); what makes an entry and how changes are grouped (`inboxChanges.ts`, called from `record`) ([below](#inbox)) |
| `convex/shared/workflow.ts`, `convex/lib/workflow.ts` | Statuses per team: types, ordering, status kind, strict order (also run in the browser); loading, creating and resolving in the backend |
| `data/generate.ts` | Deterministic test data generator |
| `scripts/seed.ts` | Loads test data into a local backend |
| `test/*.test.ts` | Vitest with `convex-test` |
| `test/integration/*.mjs` | Integration tests against a fresh local backend (`test:integration`) |

## Tables

`issues` stays lean (measured at about 475 bytes per issue) because the client subscribes to all issues in buckets of 64. Everything large lives in separate tables.

| Table | Contents | Key indexes |
|---|---|---|
| `teams` | `key`, name, `hue`, `dormant`, `order`, `logoId`/`logoDarkId` (storage), `logoType`, `workflow?` (`strict`, `exceptions`, `defaultStateId`), `wiki?` (`'on'` = knowledge base next to the issues, `'only'` = knowledge base only; missing = none) | `by_key` |
| `workflowStates` | A team's statuses: name, `type` (triage, backlog, unstarted, started, completed, canceled), `position` (within the type), `color?`, `description?`, `isDuplicate?`, `legacyKey?` (old key of the default statuses), `archivedAt?` | `by_team` |
| `projects` | Belongs to exactly one team. Name, `state`, `order` | `by_team` |
| `labelGroups` | Name, `exclusive` (single choice), `hue`, optional `teamId` | |
| `labels` | Name, `hue`, optional `groupId`, optional `teamId` (missing = workspace label), `archived` | |
| `counters` | `seq`, `team:<teamId>`, `sprint`: the last value handed out for each | `by_name` |
| `issues` | `seq`, `bucket`, `teamId`, `number`, title, `stateId` (team status), `status` (status kind, derived), priority, `labelIds`, project, estimate, `dueDate`, `snoozedUntil` (snooze), `parentId`, `sprintId`, `rank`, `createdBy`, `reviewedAt` and `readAt` (legacy inbox markers, see `inboxEntries`), timestamps, `deletedAt`, `recurrenceId` | `by_bucket`, `by_seq`, `by_team_number`, `by_status`, `by_state`, `by_sprint`, `by_due`, `by_snoozed`, `by_completed`, `by_status_due`, `by_status_completed`, `by_parent`, `by_rank`, `by_updated`, `by_deleted`, `by_team_priority`, `by_project`, search `search_title` |
| `identifierAliases` | Old identifier (upper case, "ACME-106") → issue | `by_key`, `by_issue` |
| `issueBodies` | Markdown, `version`, `updatedAt`, `updatedBy` | `by_issue` |
| `bodySearch` | Search text of the description: the first 8000 characters (`BODY_SEARCH_CHARS`). Written only through `ops/bodies.ts`, together with `issueBodies` | `by_issue`, search `search_text` |
| `bodyRevisions` | Earlier versions of a description with full text: overwritten by the import (`import_overwrite`) or a Linear version not applied because of a conflict (`import_conflict`), `version`, `at`, `actor`, `runId` | `by_issue` |
| `comments` | `body`, `author`, `createdAt`, `editedAt`, `deletedAt` (soft delete) | `by_issue`, search `search_comment` |
| `relations` | `fromId`, `toId`, `type` (blocks: from blocks to; duplicate: from is a duplicate of to; related) | `by_from`, `by_to` |
| `history` | One row per change: `field`, `from`, `to`, `actor`, `at`, `requestId` | `by_issue` |
| `inboxEntries` | The owner's inbox: `issueId`, `kind` (`created` \| `changed` \| `snoozed`), `actor` (latest), `changes` (latest change per field: `field`, `actor`, `at`, `value?`, `from?`), `createdAt`, `updatedAt`, `readAt?`, `removedAt?`. At most one open entry (no `removedAt`) per issue | `by_issue` (`issueId`, `removedAt`), `by_removed` (`removedAt`, `updatedAt`) |
| `sprints` | `number`, name, goal, `startDate`/`endDate` (calendar days), `state`, `capacity`, `source` (`xlr8`/`linear`), `startedAt`, `closedAt`, `retro` | `by_state`, `by_number`, `by_source_state_closed` |
| `sprintItems` | Sprint, issue, `kind` (planned/late/imported), `carriedFrom`, `addedAt`, `addedBy`, `removedAt`, `outcome`, `points` (estimate at close) | `by_sprint`, `by_issue` |
| `agents` | Name, `keyHash` (SHA-256 hex), `keyPrefix` (both only for keys), `connector` (`{ app, clientId }` for connectors), `revokedAt`, `revokedReason`, `lastUsedAt` | `by_hash` |
| `oauthClients`, `oauthRequests`, `oauthTokens` | OAuth for connectors: registered clients, authorization requests until the code is redeemed, access and refresh tokens (hashes only). See [`mcp.md`](mcp.md#oauth-for-connectors) | `by_client`, `by_approved_created`; `by_public`, `by_code`, `by_client_status`, `by_expires`; `by_hash`, `by_agent`, `by_expires` |
| `rateWindows` | Counter per agent and window (`m:<minute>`, `d:<day>`) | `by_agent_window` |
| `requests` | Idempotency: `owner`, `requestId`, `argsHash`, `operation`, `result` | `by_owner_request`, `by_created` |
| `pullRequests`, `issuePullRequests`, `githubDeliveries` | GitHub. `pullRequests.headSha`: last known head commit | `pullRequests.by_repo_number`, `by_repo_head` |
| `pullRequestDetails`, `pullRequestItems`, `githubCheckRuns` | Pull requests in Selfbound ([below](#githubpr-pull-requests-in-selfbound)) | `by_pr`, `by_media_key`; `by_pr_created`, `by_pr_key`; `by_repo_sha`, `by_check`, `by_received` |
| `recurrences`, `recurrenceRuns` | Recurring issues, one run per due date | `by_next`, `by_recurrence_date` |
| `linearLinks`, `importStaging`, `importRuns`, `importConflicts` | Import. `linearLinks.base`: the last imported Linear values of an issue (three-way merge), `purgedAt`: permanently deleted in Selfbound. `importRuns.phase`/`cursor`/`maxNumbers`/`heartbeatAt`: progress of the run | `by_kind_linear`, `by_local`, `importRuns.by_status` |
| `files` | Uploaded images: `token` (access protection, appears in the Markdown), `storageId`, validated `contentType`, `size`, `createdAt`, `uploadedBy`, `deleteAfter` (deletion time once unreferenced) | `by_token`, `by_delete_after` |
| `fileRefs` | Image references: one row per text (`owner` = ID of a description, comment, earlier revision or recurrence) and token. Only through `ops/files.ts` | `by_owner`, `by_token` |
| `articles` | Knowledge page: `teamId`, `parentId?` (tree), `projectId?` (project docs), title, `rank` (among siblings), `topicIds`, `createdAt`/`createdBy`, `updatedAt`/`updatedBy` (text changes at most once per minute), `deletedAt?` | `by_team_deleted`, `by_team_parent` (`teamId`, `parentId`, `rank`), `by_project`, `by_updated`, `by_deleted`, search `search_title` (filter `teamId`) |
| `articleBodies` | Text of a page: Markdown (at most 200,000 characters), `version`, `updatedAt` (exact), `updatedBy`, `revisionCount` | `by_article`, `by_updated` |
| `articleSearch` | Search text of a page in chunks of about 4000 characters (`lib/wikiText.ts`), without URLs and image tokens; only changed chunks are rewritten | `by_article` (`articleId`, `n`), search `search_text` (filter `teamId`) |
| `articleRevisions` | Earlier revisions: title, Markdown, `version`, `at` and `actor` of the old text, `savedAt` | `by_article` (`articleId`, `savedAt`) |
| `articleSources` | Sources: `url?`, `title?` (at least one of them), `author?`, `publishedAt?` (YYYY, YYYY-MM, YYYY-MM-DD), `accessedAt` (day), `note?`, `order` | `by_article` (`articleId`, `order`) |
| `wikiTopics` | Topics per team: name (unique within the team, case-insensitive), `hue`, `archived?` | `by_team` |
| `articleLinks` | Links that involve a knowledge page (`ops/links.ts`): from descriptions and comments to pages, from pages to pages and issues. `from` (ID of the text document), `fromKind` (`article`, `body`, `comment`), `fromArticleId?`/`fromIssueId?`, `toArticleId?`/`toIssueId?` | `by_from`, `by_from_issue`, `by_to_article`, `by_to_issue` |
| `articleTombstones` | Permanently deleted pages: `articleId` (text), `teamId`, `purgedAt` (for a later sync) | `by_purged` |
| `opsStatus` | Operational state: `backup`, `auditSprints`, `seed` | `by_key` |
| `settings` | Test switches (`rejectWrites`) | `by_key` |

**Index notes:**

- `issues.by_team_priority` (`teamId`, `priority`, `status`): the priority budget counts a team's open Urgent/High issues without scanning the team.
- `identifierAliases.by_issue`: finds an issue's aliases when it is permanently deleted.
- `issues.by_project` (`projectId`, `status`): MCP `list_issues` with a project filter without a scan.
- `issues.by_status_due` (`status`, `dueDate`) and `issues.by_status_completed` (`status`, `completedAt`): MCP "due/overdue" reads only open statuses, "done today" only `done`.
- `sprints.by_source_state_closed` (`source`, `state`, `closedAt`): the most recently closed sprints per source (`meta.get`, capacity). `source` comes first so that Selfbound sprints and imported Linear cycles can be queried separately.
- `issues.by_snoozed` (`snoozedUntil`): the morning job finds the issues whose snooze has ended (`gt('')` skips the many issues without one); MCP `list_issues` with `snoozed: true` reads only these.
- `bodySearch` instead of a search index on `issueBodies`: a search hit reads the whole document, so the search text is kept separate and capped at 8000 characters.
- `importRuns.by_status`: finds running imports (only one at a time; detects stuck runs).
- `issues.by_state` (`stateId`): the issues of a status (archive with move, migration checks).

### Invariants

1. **Buckets:** `bucket = floor(seq / 64)`. An issue never changes its bucket. Deleted issues stay in their bucket with `deletedAt` until the trash is emptied.
2. **Identifier** = `team.key + '-' + number`, not stored. `number` is sequential per team, `seq` is sequential globally. Both are assigned in the same transaction that creates the issue. Convex retries conflicting transactions, so no number is handed out twice.
3. **`updatedAt`** changes on EVERY change to the issue document, including description, comment, relation, rank, sprint and reviewed. The client detects changes through it. Only exception: data migrations (`migrations.ts`) that store the same information in a new form.
4. **History:** every change writes `history`, with the actor taken from the verified identity. A new issue has exactly one row `field: 'created'`, even if it is added to a sprint right away.
5. **Sprint:** for every sprint S that is **not closed**: `issue.sprintId === S` if and only if there is exactly one `sprintItems` entry for (S, issue) without `removedAt`. **Closed sprints are frozen:** nothing changes or deletes their entries any more (no moving, no detaching, not even permanently deleting the issue). Every entry without `removedAt` has an `outcome`, and if `issue.sprintId` still points to the closed sprint, such an entry exists there. Not the other way round: a reopened issue may have been carried over or detached, and a permanently deleted one is missing (the entry then points to an `issueId` with no issue). Exception: entries of imported Linear cycles are reconciled by the import. Only `ops/sprints.ts` writes `sprintId` and entries. At most one sprint is `active`. Checked in the tests after every operation and nightly by a cron.
6. **Team key** matches `TEAM_KEY_RE` (2–6 characters, upper-case letters and digits, starting with a letter), is unique, and can no longer be changed once the team has issues.
7. **Labels:** at most one label per issue from each group with `exclusive: true`. Team labels only on issues of that team. Archived labels cannot be **newly** assigned; labels already on the issue stay allowed during any other label change, and `issues.revert` may bring back what the last label change removed (undo).
8. **Project** belongs to the issue's team. **Parent** exists, is not in the trash, and no cycle is created.
9. **Status:** `issue.stateId` belongs to the issue's team, and `issue.status === statusOfState(state)`. Only `ops/issues.ts` (create, `applyPatch`), `ops/move.ts`, the import, the seed and the migration write both fields. Checked by `migrations.workflowVerify`.
10. **Priority belongs to open work:** when an issue moves into a status of kind `done`, `canceled` or `duplicate`, `applyPatch` sets the priority to 0, even if the same patch sends a different one. This applies to every path through `applyPatch` (UI, bulk edit, undo/redo, MCP, GitHub merge, sprint close with "cancel", "duplicate of", moving issues when a status is archived) and to creating an issue in a final status (`createIssues`; `ops/workflow.ts` also applies it to issues in the trash). History: a separate `priority` row (old → 0) with the same actor, `requestId` and timestamp as the status row; on create only the `created` row. Reopening does not change the priority. The UI puts the priority into the same undo step (`before`/`after`), so Ctrl Z restores both; `issues.revert` itself only knows fields and restores nothing on its own. Not affected: the Linear import and moving to another team (the status kind stays the same).
11. **Knowledge base:** pages exist only in teams with `wiki`. The parent page belongs to the same team, is not in the trash, no cycle is created, at most 20 levels. Project and topics belong to the page's team; archived topics cannot be newly assigned. Only `ops/wiki.ts` writes text, search text, revisions and image references. A delete gives all pages of the subtree the same `deletedAt` (unique per team); restore brings back exactly those pages. `teams.wiki` can only be turned off while no page exists outside the trash. **Knowledge only** (`wiki: 'only'`): the team gets no new issues (`createIssuesCore`, so also MCP, recurrences and sharing), no issues can be moved into it (`ops/move.ts`) and no recurrences can be created (`assertIssuesAllowed` in `ops/validate.ts`). Switching to "knowledge only" requires no open issues (triage through in review, counted via `by_team_priority`) and no active recurrences; completed issues stay. Switching back to `'on'` always works.
12. **Snooze:** `snoozedUntil` (calendar day) hides an open issue from the owner's lists until that day; it is a plain field, so the calendar feed or other readers only need this one value. It is set only through `applyPatch` (UI, bulk edit, undo, MCP `update_issue`), never earlier than the day after today in Europe/Berlin, and only on open issues (not done, canceled or duplicate). When an issue moves into such a status, `applyPatch` clears the snooze with its own `snoozedUntil` history row (same actor, `requestId` and timestamp as the status row, like the priority in rule 10), even if the same patch sets a day. Undo may put back a day that has passed (the next morning job returns the issue). The morning job (`returnSnoozed` in `ops/notify.ts`, called from `push.morning`) clears the field for every issue with `snoozedUntil <= today`, also for days it missed, and bumps `updatedAt` so clients see it, and opens an inbox `snoozed` entry (rule 13). Open issues also lose their `reviewedAt` and `readAt`, so they are back in the inbox as unread (history `snoozedUntil` and `unreviewed`, actor `system`), and one push per issue is recorded (bundled). Closed and deleted issues only lose the snooze. The due summary does not list snoozed issues. Existing data needs no migration: a missing field means not snoozed.
13. **Inbox:** an issue has at most one open `inboxEntries` row. Every history row with an agent as actor adds to it or opens one (`record` → `noteChange`, except `created`, `rank`, `deleted`, `reviewed`, `unreviewed`); creating an issue as an agent, or sharing it into the inbox, opens a `created` entry; the morning job that returns a snoozed issue opens (or refreshes) a `snoozed` entry. Entries never change the issue document. Permanently deleting an issue deletes its entries.

## Actors

`actor = { kind: 'steven' | 'agent' | 'github' | 'import' | 'system', agentId? }`. `'steven'` is the legacy stored value for the instance owner. The actor always comes from the verified identity, never as an argument from the client:

- UI: `requireOwner` checks the token (Convex) and the allowlist `XLR8_OWNER_IDS` (`tokenIdentifier`, comma-separated) → `steven` (owner). Tokens from the local test sign-in (issuer `https://dev.xlr8.local`) are only accepted when `CONVEX_CLOUD_URL` (set by Convex in every function) points to `127.0.0.1` or `localhost`; otherwise `access_denied`, even if `XLR8_DEV_JWKS` is set by mistake.
- MCP: agent key → `{ kind: 'agent', agentId }` (checked in the HTTP action and again in the mutation). MCP output shows the owner under the name from `XLR8_OWNER_NAME` (default "Owner").
- Crons: `system`. GitHub webhook: `github`. Import: `import`.

Permissions that depend on the actor:

| What | Who |
|---|---|
| Create, change, reorder teams | owner, `import` |
| Set and remove logos | owner only |
| Create and revoke agent keys | owner only |
| Edit and remove comments | owner for all, otherwise only the author |
| Delete and restore knowledge pages | owner only (all actors may create and edit) |
| Inbox entries | Agents that create an issue or change an existing one open an entry or add to the open one ([below](#inbox)); the owner's own changes never do. The owner removes (`issues.markReviewed`), reads (`issues.markRead`) and restores (`issues.markUnreviewed`) them. These only touch the entry: no status, no `updatedAt`, reading writes no history |

## Errors

Business errors arrive as `ConvexError` with `data = { code, message, …extra }`. `message` is plain English text for display.

| Code | Meaning | Extra fields |
|---|---|---|
| `access_denied` | Not signed in, not on the allowlist, missing permission, seed or test switches disabled | |
| `not_found` | Document does not exist | e.g. `issueId`, `labelId` |
| `conflict` | Compare-and-set failed, description out of date, a sprint is already active | `expect`: `issueId`, `identifier`, `field`, `expected`, `actual`; description: `issueId`, `version`, `updatedAt`, `updatedBy`; knowledge page: `articleId`, `version`, `updatedAt`, `updatedBy`; sprint: `activeSprintId` |
| `invalid` | Invalid input or rule violation | e.g. `missing` (missing sprint decisions) |
| `invalid_transition` | Status change not allowed under strict order | `identifier`, `from` (name, `null` = new issue), `to`, `allowed` (names of the allowed targets) |
| `rejected` | Test switch "server rejects" is on | |
| `rate_limited` | Agent above 120/minute or 5000/day | `retryAfterMs` |

**`budget_warning` is not an error:** `issues.create` and `issues.update` return `warnings: [{ code: 'budget_warning', teamId, priority, open, budget, message }]` when a team ends up with more than 1 open Urgent or 3 open High issues (`PRIORITY_BUDGET`). The change is saved anyway.

## Idempotency

All write functions for issues, comments, relations and sprint contents take an optional `requestId` (1–200 characters; MCP clients should always send one, see [`mcp.md`](mcp.md)). In the same transaction as the change:

- (actor, `requestId`) not seen yet → run, store the result.
- Seen, same operation and same argument hash → return the stored result; nothing happens again.
- Seen, different arguments or a different operation → `invalid` "requestId reused with different arguments".

If the operation fails, nothing is stored and a retry runs it again. Each actor has its own namespace (owner, agent ID …). A cron deletes entries older than 30 days. The `requestId` is also recorded in the history.

## Test switches

Only effective with `XLR8_TEST_SWITCHES=1` (local only). `admin.setRejectWrites({ value })` toggles "server rejects": every UI change then throws `rejected`, including key and logo actions. `meta.get().rejectWrites` shows the state. Without the variable the switch can neither be set (`access_denied`) nor take effect.

## Public functions

All require sign-in (exception: `health.status`). A test calls every exported public function of every module without an identity and with a foreign identity and expects `access_denied`. Write mutations also check the test switch. Types: `Id<'issues'>` etc. from `@selfbound/backend/dataModel`, function references from `@selfbound/backend/api`. `day` = calendar day `"YYYY-MM-DD"`. For optional fields in a patch, `null` means "clear".

### health

| Function | Arguments | Returns |
|---|---|---|
| `health.status` (query, no sign-in) | – | `{ ok, local, devAuth, devAuthConfigured, clerk, testSwitches }`: `local` = local deployment (`CONVEX_CLOUD_URL`), `devAuth` = local test sign-in configured **and** effective (local only), `devAuthConfigured` = `XLR8_DEV_JWKS` set. `devAuth` must be `false` before a production deploy ([`operations.md`](../operations.md)) |
| `health.whoami` (query) | – | actor `{ kind: 'steven' }` (owner) |

### meta

| Function | Arguments | Returns |
|---|---|---|
| `meta.get` (query) | – | `{ teams: (Team & { logoUrl, logoDarkUrl })[]` by `order`, `workflowStates` (all statuses of all teams, archived ones included), `projects` by `order`, `labelGroups`, `labels`, `sprints` (all sprints not closed + the last 6 closed ones by close time, Selfbound sprints first; imported Linear cycles only fill up while there are fewer than 6 Selfbound sprints; descending by number), `rejectWrites }`. Deliberately without counters. `logoUrl`/`logoDarkUrl` = `<site>/logo/<storageId>` (dedicated endpoint with a strict CSP, not the storage URL), still displayed via `<img>`. |
| `meta.counter` (query) | – | `{ maxSeq }` (−1 without issues). The buckets `0 … floor(maxSeq/64)` follow from it. |

### issues

| Function | Arguments | Returns |
|---|---|---|
| `issues.bucket` (query) | `{ bucket }` | Issue documents of the bucket (up to 64), **including deleted ones** (`deletedAt`); the client filters |
| `issues.detail` (query) | `{ id }` | `null` or `{ id, identifier, body: { markdown, version, updatedAt, updatedBy }, comments` (the **newest 100** not removed, at most about 1 million characters, in chronological order)`, commentsHasMore` (older ones exist: `comments.page`)`, relations: [{ id, type, direction: 'out'|'in', createdAt, other: { id, identifier, title, status, teamId, deleted } }], pullRequests: [PR & { via, closes }], history` (newest 100 first)`, sprints: [sprintItem & { sprint: { _id, number, name, state } }] }` |
| `issues.revisions` (query) | `{ id }` | earlier descriptions from `bodyRevisions`, newest first, at most 20: `[{ id, markdown` (full text)`, version, reason: 'import_overwrite'|'import_conflict', at, actor }]` |
| `issues.search` (query) | `{ q, limit? ≤ 50 (default 20) }` | `[{ id, identifier, title, status, teamId, match: 'title'|'description'|'comment', snippet? }]`: title hits first, then description, then comment hits; no trash, no duplicates. Descriptions via `bodySearch` (the first 8000 characters) |
| `issues.resolve` (query) | `{ identifier }`: "ACME-106", "acme106", an old identifier or an issue ID | `{ id, identifier }` or `null` |
| `issues.create` | `{ issues: NewIssue[1..50], requestId? }` | `{ issues: [{ id, identifier }], warnings }` |
| `issues.update` | `{ ids: Id[1..500], patch: IssuePatch, expect?: IssuePatch[]` (one per issue)`, requestId? }` | `{ updatedAt, changed` (number of changed issues)`, warnings }` |
| `issues.revert` | `{ items: [{ id, patch, expect }][1..500], requestId? }` | `{ updatedAt, changed }` |
| `issues.setDescription` | `{ id, markdown, baseVersion, requestId? }` | `{ version, changed }` |
| `issues.remove` | `{ ids, requestId? }` | `{ removed, deletedAt }` |
| `issues.restore` | `{ ids, requestId? }` | `{ restored }` |
| `issues.markReviewed` | `{ ids, requestId? }` (issue IDs) | `{ reviewed }`: remove the open entries from the inbox (issues without one don't count), history `reviewed`, issue unchanged |
| `issues.markUnreviewed` | `{ ids, requestId? }` | `{ unreviewed }`: undo of the above, the entry removed last comes back (not if a newer one is open) |
| `issues.markRead` | `{ ids, read, requestId? }` | `{ changed }`: mark the open entry read or unread (`readAt`), no history |
| `issues.reorder` | `{ id, beforeId?, afterId?, requestId? }`: at least one neighbour | `{ rank }` |
| `issues.moveTeam` | `{ ids, teamId, requestId? }` (used by the UI, e.g. triage "accept into …"; MCP: `move_issues`) | `{ moved: [{ id, identifier, previous }] }` |

`NewIssue = { teamId, title, description?, stateId?, status?, priority? = 0, labelIds?, projectId?, estimate?, dueDate?, parentId?, sprintId? }`: without `stateId` and `status`, the team's default status ([below](#statuses-per-team)).

`IssuePatch = { title?, stateId?, status?, priority?, labelIds?, projectId? | null, estimate? | null, dueDate? | null, snoozedUntil? | null, parentId? | null, sprintId? | null }`

Rules for changes:

- A field is only written if its value changes (value equality; `labelIds` as a set, order irrelevant). Equal values create no history and don't change `updatedAt`.
- **Compare-and-set:** every value in `expect[i]` must match the current value (`null` = not set), otherwise `conflict` for the whole call. Undo sends `issues.revert` with `expect` = the value it set itself.
- **Status** (`stateId` or status kind `status`, see [Statuses per team](#statuses-per-team)). The status kind sets the timestamps: `in_progress`/`in_review` → `startedAt` (if empty); `done` → `completedAt`; `canceled`/`duplicate` → `canceledAt`; `triage`/`backlog`/`todo` → all three cleared. The history row is `field: 'stateId'` with the old and new status ID (older rows: `field: 'status'` with the old key).
- `snoozedUntil` (`null` = unsnooze): see invariant 12. A day that is not after today (Berlin) or an issue that is not open → `invalid`; undo is exempt from both checks.
- `sprintId` in the patch is passed on to the sprint operations (rules below).
- Issues in the trash cannot be changed (`invalid`), only restored.
- **Description:** `baseVersion` must match the current `version` (new issues: 1), otherwise `conflict` with `{ version, updatedAt, updatedBy }`. Afterwards `version + 1`. Same text: no change. The history only records `{ version }` and a 120-character preview.
- **Rank** (`issues.reorder`): afterwards the order is `before, issue, after`. `beforeId` is the neighbour directly above, `afterId` the one directly below. If one is missing, the server takes the next rank in the index. If the neighbours no longer fit together (stale state), the issue lands directly after `before`. The rank is global across all teams; each view sorts its subset by it. New issues go to the end.
- **Move to another team** (`issues.moveTeam`, `ops/move.ts`): new status in the target team (same default status, otherwise same name, otherwise same status kind; history `stateId`), new number in the target team, the old identifier becomes an alias (`identifierAliases`), seq and bucket stay. A project of another team and team labels of the old team are dropped (history `teamId`, and `projectId`, `labelIds` if affected). Same team: nothing happens; trash: `invalid`.
- **Trash:** `remove` sets `deletedAt` and takes the issue out of a sprint that is not closed (`restore` does not put it back). After 30 days the cron deletes permanently: issue, description (including search text and earlier revisions), image references (the files follow one day later unless another text uses them), comments, relations, entries of sprints not closed, PR links, aliases and history. Sub-issues lose their parent (actor `system`). **Kept:** entries of closed sprints (frozen, with `points`, so capacity doesn't change) and the Linear link, marked with `purgedAt`, so a later import doesn't recreate the issue.
- **Archived labels:** see invariant 7.

### inbox

| Function | Arguments | Result |
|---|---|---|
| `inbox.list` (query) | – | The open entries, newest change first (`updatedAt`), at most 1000 (`INBOX_LIST_MAX`). One subscription per client; the client merges each entry into its issue |

**Entries.** One open entry per issue. Reasons (`kind`): `created` (an agent created the issue, or it was shared into the inbox), `changed` (an agent changed an issue that was not in the inbox) and `snoozed`. `snoozed`: the morning job (`returnSnoozed`) brought a snoozed issue back; it opens an entry, or turns the open one into `snoozed` (unread, first in the list, `changes` emptied: what happened meanwhile is in the history). A snoozed issue is not in the inbox (`inInbox` needs `snoozedUntil` unset), so an entry waits hidden behind the snooze, and agent changes during the snooze join it. Further reasons are one more `kind` value plus the code that opens the entry. A change by an agent to an issue with an open entry joins it whatever the kind: `changes` keeps the latest change per field (at most 16), `actor` and `updatedAt` are those of the latest change, and `readAt` is cleared so the entry is unread again. `value` is what the field became (IDs for references, a 120-character preview for comments, `type:direction:otherId` for relations), missing if the field was cleared; `from` only for labels and team moves. The owner, GitHub, the import and system jobs make no entries. Removing sets `removedAt`; the daily cleanup deletes entries removed more than 90 days ago.

**Idempotent writes.** `record` is the only place that notices changes, so every path with an agent as actor (MCP, the shared operations) is covered, including a retried request: the stored result is returned and nothing is noted twice.

**Migration `inboxBackfill`** (from the old markers on issues, safe to rerun): every issue without `reviewedAt` (trash included, so a restored issue comes back as before) gets one `created` entry with `createdAt` as its time and its `readAt`. Issues are not touched; `reviewedAt`/`readAt` stay in the schema, and `reviewedAt` is still written at creation for issues that do not start in the inbox, which is what lets the migration run before, during or after the deploy. Without `apply: true` it counts only (`missing` = issues that would get an entry, `existing` = issues that already have one; `missing: 0` after the run). With `apply: true` it works in pages of 500 and reschedules itself; issues with any entry (open or removed) are skipped; after the last page a note in `opsStatus` (`inboxBackfill`) makes later runs do nothing, so removed entries never come back (`force: true` ignores the note). How to run it: [`operations.md`](../operations.md#inbox-entries-migration).

### Statuses per team

Each team has its own statuses (`workflowStates`), each with a type: triage, backlog, unstarted (planned), started, completed, canceled. Order: by type, then by `position` within the type (`compareStates`). A new team gets the eight default statuses (Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate), each with a `legacyKey`. The names are stored per team; with `XLR8_LOCALE=de` new teams get German names (`defaultStateName` in `shared/workflow.ts`). Statuses are never deleted, only archived.

**Status kind** (`issue.status`): the eight legacy keys, derived from the status (`statusOfState`: `isDuplicate` → `duplicate`, otherwise `legacyKey`, otherwise the key of the type, e.g. "Testing" of type started → `in_progress`). It backs the indexes (`by_status…`, `by_team_priority`, `by_project`), the open/closed sets, sprint close, priority budget, timestamps and the MCP filters. That is why custom statuses change none of these rules.

**Resolving** (`resolveState`): `stateId` must belong to the issue's team and must not be archived. A status kind on its own (e.g. `'done'` from a GitHub merge, `'canceled'` on sprint close, `'duplicate'` for "mark as duplicate", `'todo'` for recurrences, older clients) resolves to the matching status of the team (`stateForStatus`: default status with that key, otherwise a custom status of that kind, otherwise the first status of the type). If the issue is already in a status of that kind, it stays there. New issues without a status: `teams.workflow.defaultStateId`, otherwise the first backlog status; agents (MCP): the triage status.

**Strict order** (`teams.workflow.strict`, rules in `shared/workflow.ts` `allowedTargets`, checked in `lib/workflow.ts` `assertTransition` on create and in `applyPatch`): allowed are the next non-archived status in workflow order, any status of type canceled at any time (Canceled, Duplicate), any backlog or planned status from triage, and the configured `exceptions` (from → to). New issues only in triage, backlog or planned statuses. The rule applies to the owner and `agent` actors; exempt are `github`, `import`, `system`, undo (`issues.revert`; compare-and-set still applies), team moves and moving issues when a status is archived. Violation → `invalid_transition` with the allowed targets. Archived statuses in exceptions don't count; archiving removes them from the list.

**Configuration** (`workflowStates.*`, owner only, `ops/workflow.ts`):

| Function | Arguments | Returns |
|---|---|---|
| `workflowStates.create` | `{ teamId, name, type, color?, description? }`: name unique per team (case-insensitive), at most 30 statuses, at most one triage status; position at the end of the type | `{ stateId }` |
| `workflowStates.update` | `{ stateId, name?, color? \| null, description? \| null }` (colour `#rrggbb`; `null` = colour of the status kind). The type is fixed. | `{ stateId }` |
| `workflowStates.reorder` | `{ teamId, stateIds }`: statuses of one type only; missing ones of the same type go to the end | `{ count }` |
| `workflowStates.archive` | `{ stateId, moveTo? }`: if the status has issues (trash included), `moveTo` is required; they move (history per issue), more than 200 in the background (`archiveRest`). Blocked for the configured default and the last status of the types unstarted, completed, canceled. Exceptions pointing to the status are dropped. | `{ stateId, moved, more }` |
| `workflowStates.restore` | `{ stateId }` | `{ stateId }` |
| `workflowStates.setWorkflow` | `{ teamId, strict?, exceptions?, defaultStateId? \| null }`: default only backlog, planned or started | `{ teamId }` |

**Migrations** (`migrations.ts`, one-off, safe to rerun):
- `priorityClearClosed`: completed, canceled and duplicate issues lose their priority (history row, actor `system`, new `updatedAt`). Without `apply: true` it only counts. How to run it: [`operations.md`](../operations.md#importing-from-linear).
- `workflowBackfill` creates the default statuses for teams without statuses and sets `stateId` on all issues that lack one, matching the status kind. Paged (500 per call, reschedules itself). `status`, `updatedAt` and the history stay unchanged.
- `workflowVerify` (action) checks all issues (status exists, belongs to the team, status kind matches) and returns the counts per team and status, numbers only. `ok: true` = done.
- Only needed for data created before teams had their own statuses: deploy, run `node tooling/cloud.mjs run migrations:workflowBackfill`, wait until no scheduled follow-up pages remain (Convex dashboard → Scheduled Functions), run `migrations:workflowVerify` until it reports `"ok": true`, then deploy the web app.

### comments, relations

| Function | Arguments | Returns |
|---|---|---|
| `comments.page` (query) | `{ issueId, before: Id<'comments'>, limit? ≤ 100 }` | `{ comments, hasMore }`: the non-removed comments **before** `before` (the oldest one already loaded), the newest 100 of those, in chronological order; at most about 1 million characters per page. For loading more after `issues.detail` (`commentsHasMore`); the UI does not use it yet |
| `comments.add` | `{ issueId, body, requestId? }` | `{ commentId }` |
| `comments.edit` | `{ commentId, body, requestId? }` | `{ commentId, changed }` |
| `comments.remove` | `{ commentId, requestId? }` (soft: `deletedAt`) | `{ commentId }` |
| `relations.add` | `{ fromId, toId, type: 'blocks'|'related'|'duplicate', markDuplicate?, requestId? }` | `{ relationId }` |
| `relations.remove` | `{ relationId, requestId? }` | `{ relationId }` |

Relations: no self-reference, no second relation of the same type between the same issues (in either direction). With `duplicate`, `markDuplicate` sets the `from` issue to status `duplicate`. History on both issues.

### sprints

| Function | Arguments | Returns |
|---|---|---|
| `sprints.list` (query) | – | all sprints, newest first |
| `sprints.items` (query) | `{ sprintId }` | `[{ _id, issueId, kind, carriedFrom, addedAt, addedBy, removedAt, outcome }]` (all entries of the sprint, removed ones included; `null` instead of missing) |
| `sprints.capacitySuggestion` (query) | – | `{ capacity: number | null, basis: [{ sprintId, number, name, donePoints }] }` |
| `sprints.create` | `{ name?, goal?, startDate?, endDate?, capacity?, requestId? }` | `{ id, number }` |
| `sprints.update` | `{ sprintId, name?, goal?, startDate?, endDate?, capacity? | null, retro? }` | `{ sprintId }` |
| `sprints.add` | `{ sprintId, issueIds[1..500], requestId? }` | `{ added, kind: 'planned'|'late' }` |
| `sprints.remove` | `{ sprintId, issueIds, requestId? }` | `{ removed }` |
| `sprints.start` | `{ sprintId }` | `{ sprintId, startedAt }` |
| `sprints.close` | `{ sprintId, decisions: [{ issueId, outcome: 'next'|'backlog'|'canceled' }], nextSprintId?, requestId? }` | `{ sprintId, nextSprintId | null, counts: { done, next, backlog, canceled } }` |

**Sprint rules:**

- Sprints span all teams, on purpose (one person, one week, one capacity; [decisions](../decisions.md#one-sprint-for-all-teams)). A new sprint is in state `planning`, by default 14 days from the next Monday (Europe/Berlin), named "Sprint <number>", numbered sequentially.
- **Start:** only `sprints.start` makes a sprint active, and only from `planning`. If one is already running → `conflict`. Without a start there is no running sprint.
- **Adding:** in `planning` → `kind: 'planned'`, in `active` → `'late'` (whether the owner or an agent adds it), `closed` → `invalid`. An issue belongs to at most one sprint that is not closed; moving it closes the old entry (`removedAt`), unless the old sprint is closed: then its entry stays unchanged. Deleted issues cannot be added.
- **Reopened:** an issue that still points to a closed sprint can be detached with `issues.update` `{ sprintId: null }` or put into a new sprint via `sprints.add`. The entry in the closed sprint (`outcome`, `points`) stays as it is in both cases. `sprints.remove` on a closed sprint stays `invalid`.
- **Close:** `sprints.close` only for the active sprint. EVERY open issue (triage … in_review) needs a decision, otherwise `invalid` with `missing: Id[]` and the identifiers in the message. Decisions for issues outside the sprint → `invalid`. Completed issues get `outcome: 'done'`, canceled ones and duplicates `'canceled'`; they stay assigned to the closed sprint (`issue.sprintId` keeps pointing to it).
  - `next` → into `nextSprintId` (must be in `planning`) or a newly created planned sprint, there as `planned` with `carriedFrom`.
  - `backlog` → out of the sprint, status unchanged.
  - `canceled` → out of the sprint, status `canceled`.
  - Nothing is moved automatically.
- **Capacity:** suggestion = average of the completed points of the last 3 closed sprints with `source: 'xlr8'` (by `closedAt`), rounded to one decimal. Every entry with `outcome: 'done'` counts with the `points` recorded at close (older entries without `points`: the issue's current estimate). Later changes to the issue (reopened, new estimate, permanently deleted) don't change the value. Imported Linear cycles don't count.
- The client classifies planned/late via `sprints.items`; the issue buckets only carry `sprintId`.

### teams, projects, labels, labelGroups

| Function | Arguments | Returns |
|---|---|---|
| `teams.create` | `{ key, name, hue?, dormant?, wiki?: 'on' \| 'only' }` (key is upper-cased) | `{ teamId, key }` |
| `teams.update` | `{ teamId, key?, name?, hue?, dormant?, wiki?: 'on' \| 'only' \| null }` (`'only'` only without open issues and active recurrences, `null` only without pages) | `{ teamId }` |
| `teams.reorder` | `{ teamIds }` (missing ones go to the end) | `{ count }` |
| `teams.generateLogoUploadUrl` | – | upload URL (string) |
| `teams.setLogo` (action) | `{ teamId, storageId, variant: 'light'|'dark' }` | `{ teamId, contentType }` |
| `teams.removeLogo` | `{ teamId, variant }` | `{ teamId, removed }` |
| `projects.create` | `{ teamId, name, state? = 'active' }` | `{ projectId }` |
| `projects.update` | `{ projectId, name?, state? }` (team cannot be changed) | `{ projectId }` |
| `projects.reorder` | `{ teamId, projectIds }` | `{ count }` |
| `labelGroups.create` | `{ name, exclusive, hue?, teamId? }` | `{ groupId }` |
| `labelGroups.update` | `{ groupId, name?, exclusive?, hue? }` | `{ groupId }` |
| `labels.create` | `{ name, hue, groupId?, teamId? }` | `{ labelId }` |
| `labels.update` | `{ labelId, name?, hue?, groupId? | null, archived? }` | `{ labelId }` |

**Logo upload:** `generateLogoUploadUrl` → `fetch(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })` → `{ storageId }` → `teams.setLogo`. Checks: SVG or PNG, content matches the content type, at most 256 KB, square (PNG: IHDR; SVG: `viewBox` or `width`/`height`). SVG must pass an **allowlist** (`lib/logo.ts`): only shape, text, gradient, mask and filter elements (no `script`, `foreignObject`, `a`, `set`/`animate…`, `iframe` …) and only known presentation attributes (no `on…`). Before the check, namespace prefixes are stripped (`<s:script>` is a `script`), character references are resolved and whitespace and control characters are removed from values (`java&#9;script:`). References (`href`, `xlink:href`, `url()`) only to `#anchor`, for `<image>` also `data:image/png`; CSS without `@import`, escapes and external `url()`. DOCTYPE/ENTITY, CDATA outside `<style>`, processing instructions other than the XML declaration, and malformed files are rejected. Save Inkscape exports with their own namespaces (`inkscape:`, `sodipodi:`) as "plain SVG". Rejected files are deleted. The previous logo is deleted when it is replaced. Logos are always displayed via `<img>`; the URL in `meta.get` points to `GET /logo/<storageId>` (below), not to the storage URL.

### files (images)

| Function | Arguments | Returns |
|---|---|---|
| `files.generateUploadUrl` | – | upload URL (string) |
| `files.register` (action) | `{ storageId }` | `{ url, contentType, size }`: `url` = `<site>/img/<token>` for the Markdown |

**Upload:** `generateUploadUrl` → `fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type }, body })` → `{ storageId }` → `files.register`. Checks: PNG, JPEG, WebP or GIF (detected from the first bytes, never SVG), content matches the declared type, at most 5 MB (`LIMITS.imageMaxBytes`). Rejected files are deleted. Only the owner uploads; the test switch rejects here too. The UI shrinks images in the browser first (longest edge 2560 px, WebP; JPEGs are always re-encoded so that location and device data from the camera metadata don't travel along). Agents don't upload; they see images as Markdown links `![name](<site>/img/<token>)` in descriptions and comments.

**Access (design decision):** `<img>` sends no auth header, so an authenticated endpoint would only work with cookies or with URLs the app has re-signed on every display. Both cost function calls and make the Markdown useless for agents and the import (expiring links). So: **unguessable URLs.** The token is 32 random bytes (256 bits, generated in the action, not in a mutation); anyone who doesn't know it from a text they are allowed to read can't find the image. Raw storage IDs and unknown tokens return 404. The token does not expire; whoever shares a link shares the image. Deleted images (below) are gone immediately. The app sends no full referrer to other sites (`strict-origin-when-cross-origin`), and images themselves load with `referrerpolicy="no-referrer"`.

**References and cleanup** (`ops/files.ts`): every write path for texts calls `syncFileRefs(ctx, owner, text)`, with `null` on delete: descriptions (`ops/bodies.ts`, so also MCP, import, recurrences), comments (add, edit, remove; import), earlier revisions (import), recurrence templates, permanent deletion of an issue, text and earlier revisions of knowledge pages (`ops/wiki.ts`). The same image in several places stays as long as any text references it. Without a reference the file gets `deleteAfter`: 7 days after a fresh upload (drafts only live in the browser), 1 day after removal from the last text (so undo still works). If a reference comes back before then, `deleteAfter` is cleared. The cron `sweep-files` then deletes the file and the entry. Issues in the trash keep their images until permanent deletion.

**Storage:** `ops.status().storage` = `{ files, bytes, images, imageBytes, orphaned, capped }` (all files in Convex storage, logos included; counted up to 8000 per table, `capped` beyond that). Convex free plan: 1 GB storage, 1 GB data transfer per month.

### agents

| Function | Arguments | Returns |
|---|---|---|
| `agents.create` (action) | `{ name }` | `{ agentId, key, keyPrefix }`: `key` = `xlr8_` + 32 random bytes base64url, only appears in this response |
| `agents.revoke` | `{ agentId }` | `{ agentId }`; for connectors all tokens are deleted as well |
| `agents.list` (query) | – | `[{ _id, name, keyPrefix, connector, createdAt, revokedAt, revokedReason, lastUsedAt }]` (never the hash; newest first) |
| `oauth.arm` | `{ on }` | `{ armedUntil }`: accept new connectors for 15 minutes, or switch off immediately |
| `oauth.request` (query) | `{ request }` | consent page: `{ state: 'unknown' }` or `{ state, app, appName, clientName, clientKnown, redirectHost, createdAt, expiresAt, armedUntil, suggestedName }` |
| `oauth.decide` (action) | `{ request, approve, name? }` | `{ redirect }`: return URL to the app with the code or `error=access_denied`, `state`, `iss`. Errors: not armed (`access_denied`), expired (`invalid`), already decided (`conflict`), OAuth off (`invalid`) |

`request` is the public request ID from the consent page URL (`/oauth/consent?request=…`; the old `/oauth/freigabe?anfrage=…` still works). Both functions also accept the legacy argument name `anfrage` from older app builds.

Internal, for MCP: `internal.agents.authenticate({ keyHash, now? })` → `{ agentId, name, actor }` (`keyHash` = hash of a key or access token; unknown, revoked or expired at `now` → `access_denied`); `internal.agents.consumeRate({ agentId })` → `{ minute, day }` or `rate_limited`. Calls rejected for exceeding the limit don't count; calls that fail on business rules or invalid arguments do. `lastUsedAt` is written at most once per minute. The shared functions for this live in `ops/agents.ts`; the MCP server is described in [`mcp.md`](mcp.md).

### recurrences

| Function | Arguments | Returns |
|---|---|---|
| `recurrences.list` (query) | – | all templates |
| `recurrences.create` | `{ teamId, title, description?, priority?, labelIds?, projectId?, estimate?, cadence: 'weekly'|'monthly', weekday? (1 = Mon … 7 = Sun), monthDay? (1–28), startDate?, sourceIssueId? }` | `{ recurrenceId }` |
| `recurrences.update` | `{ recurrenceId, title?, description? | null, priority?, labelIds?, projectId? | null, estimate? | null, cadence?, weekday? | null, monthDay? | null, active? }` | `{ recurrenceId }` |
| `recurrences.remove` | `{ recurrenceId }` | `{ recurrenceId }` |

The hourly cron creates exactly one issue for each active template with `nextDate ≤ today` (calendar day in Europe/Berlin): status `todo`, `dueDate` = due date, `recurrenceId`, actor `system`. Uniqueness via `recurrenceRuns` (template, due date). Then `nextDate` moves to the next due date. Missed due dates are not all caught up; at most one is. If creating the issue fails on a business rule (e.g. an archived label), the template is paused (`active: false`).

### wiki (knowledge base)

Pages per team. In code `wiki`/`article`; in the UI "Knowledge", "Page", "Topic" (German UI: "Wissen", "Seite", "Thema"). Pages are only read while the knowledge area is open; `meta.get` only returns `teams.wiki`. All mutations take an optional `requestId`.

| Function | Arguments | Returns |
|---|---|---|
| `wiki.list` (query) | `{ teamId }` | `{ articles, topics, truncated }`: all pages outside the trash (without text, at most 2000) and the team's topics |
| `wiki.get` (query) | `{ id }` (string from the URL) | `null` or `{ article, team: { id, key, name, wiki }, body: { markdown, version, updatedAt, updatedBy }, sources, path: [{ id, title }], children: [{ id, title, rank }] }`; also for pages in the trash (`article.deletedAt`) |
| `wiki.projectCounts` (query) | `{ teamId }` | `{ [projectId]: count }`: pages per project outside the trash (project overview) |
| `wiki.trash` (query) | `{ teamId }` | per delete operation `{ id, title, deletedAt, pages, parentId }`, newest first |
| `wiki.revisions` (query) | `{ articleId, before?, limit? ≤ 20 }` | `{ revisions: [{ id, title, version, at, actor, savedAt, chars, preview }], hasMore }`, newest first; `before` = `savedAt` of the last one |
| `wiki.revision` (query) | `{ revisionId }` | the revision with full text, or `null` |
| `wiki.backlinks` (query) | `{ articleId }` | `{ issues, pages, mentions }`: issues and pages that link to the page (trash excluded), and issues the page itself mentions |
| `wiki.forIssue` (query) | `{ issueId }` | `[{ id, title, teamId, via: 'linked' \| 'mentions' }]`: pages the issue links to, or pages that mention the issue |
| `wiki.search` (query) | `{ q, teamId?, limit? ≤ 50 }` | `[{ id, title, teamId, parentId, match: 'title' \| 'text', snippet? }]`; hits containing all words first (title before text), trash excluded |
| `wiki.create` | `{ teamId, title, markdown?, parentId?, projectId?, topicIds?, sources? }` | `{ articleId }` (at the end of its level, text version 1) |
| `wiki.update` | `{ id, title?, projectId? \| null, topicIds? }` | `{ articleId, changed }` |
| `wiki.move` | `{ id, parentId \| null, beforeId?, afterId? }` (without neighbours: to the end) | `{ articleId, rank }` |
| `wiki.setBody` | `{ id, markdown, baseVersion }` | `{ version, changed }`; wrong version → `conflict` |
| `wiki.restoreRevision` | `{ revisionId, baseVersion }` | `{ version, changed }`: the revision's text as a new version |
| `wiki.remove` | `{ id }` | `{ articleId, removed, deletedAt }`: page with all sub-pages into the trash (owner only) |
| `wiki.restore` | `{ id }` | `{ articleId, restored, movedToTop }`: back with the same sub-pages; if the parent page is still in the trash, to the top level (owner only) |
| `wiki.addSources` | `{ articleId, sources: [{ url?, title?, author?, publishedAt?, accessedAt?, note? }] }` | `{ sourceIds }` (at the end; missing `accessedAt` = today) |
| `wiki.updateSource` | `{ sourceId, patch }` (`null` clears a field) | `{ sourceId, changed }` |
| `wiki.removeSource` | `{ sourceId }` | `{ sourceId }` |
| `wiki.reorderSources` | `{ articleId, sourceIds }` (missing ones go to the end) | `{ articleId }` |
| `wiki.createTopic` | `{ teamId, name, hue? }` | `{ topicId }` |
| `wiki.updateTopic` | `{ topicId, name?, hue?, archived? }` | `{ topicId }` |

**Revisions:** before a non-empty text is overwritten, it is saved if the last revision is older than 10 minutes, a different actor writes than last time, an agent or the import writes, or a revision is being restored. At most 100 revisions per page; the oldest is dropped. Revisions keep their images (own `fileRefs`). `articles.updatedAt` changes at most once per minute on text changes so the team's page list stays calm while typing; `articleBodies.updatedAt` has the exact time.

**Limits:** 200,000 characters of text, 2000 pages per team in the list, 20 levels, 500 pages per delete operation, 100 sources and 20 topics per page, 500 topics per team (`WIKI` in `shared/constants.ts`).

**Links** (`ops/links.ts`, `shared/links.ts`): every write path for a text calls `syncArticleLinks`, just like `syncFileRefs` (description via `ops/bodies.ts`, adding/editing/removing comments, import, Linear files, page text). From issue texts, links to `/wiki/<id>` (`ARTICLE_PATH`) and the older `/wissen/<id>` count; from pages, also links `/issue/ACME-106` and bare identifiers of known teams (upper case, not inside code; "UTF-8" doesn't count). The `issueId` is stored, so a team move breaks nothing. An issue text without "/wissen/" and without old links costs one index query. Permanently deleting an issue or a page removes the links in both directions. Existing texts are not scanned retroactively.

**Permanent deletion** (`purgeArticle`): text, search text, revisions, sources and image references; Linear links get `purgedAt`; a tombstone is written to `articleTombstones`. Sub-pages that were not deleted with it move to the top level.

### githubPr (pull requests in Selfbound)

Types in `shared/pullRequests.ts` (`PrView`, `PrDetail`, `PrItem`, `PrCheck`, `PrSummary`, `GithubConnection`). Access to GitHub only via `GITHUB_TOKEN` (the instance's fine-grained PAT, [`operations.md`](../operations.md#github)); the token never leaves the backend and appears in no message.

| Function | Arguments | Returns |
|---|---|---|
| `githubPr.view` (query) | `{ repo, number }` | `PrView \| null` (null: PR unknown). `detail` is null until there has been a successful fetch; `error` is set even then |
| `githubPr.summaries` (query) | `{ prIds }` (at most 20, more are cut off) | `PrSummary[]` in input order; unknown ones are missing |
| `githubPr.status` (query) | – | `{ configured }` |
| `githubPr.refresh` (action) | `{ prIds, maxAgeMs? }` (at most 10; default 60 s) | `{ refreshed, error? }`. Only fetches PRs whose last fetch is older than `maxAgeMs` and that no other call is currently fetching (`fetchingSince`, valid for 30 s); sets `viewedAt` (at most every 5 min). Without a token `{ refreshed: 0, error }` |
| `githubPr.merge` (action) | `{ prId, method: 'merge'\|'squash'\|'rebase', deleteBranch }` | `{ merged: true, branchDeleted, message? }`. Merges with `sha` = known head commit. Deletes the branch only if `headBranchDeletable`; if the repo deletes it itself (`deleteBranchOnMerge`), `branchDeleted: true` without a separate call. Then fetches the state right away: on return the PR is `merged` and the merge transition (below) has run |
| `githubPr.setState` (action) | `{ prId, state: 'open'\|'closed' }` | `{ state }`; refetches right after |
| `githubPr.comment` (action) | `{ prId, body }` (trimmed, 1–65536 characters) | `{ url }`; refetches right after |
| `githubPr.connection` (query) | – | `GithubConnection`: `{ configured, login?, checkedAt?, repos: [{ repo, hook: 'ok'\|'created'\|'updated'\|'missing'\|'outdated'\|'error', error? }], error?, local, manage, canWrite }` |
| `githubPr.ensureWebhooks` (action) | – | `GithubConnection` after a check now |

Action errors: `ConvexError { code, message, status }` with an English message; `rejected` (token missing, invalid or lacking permission, GitHub unreachable), `not_found`, `conflict` (405/409, with GitHub's message), `invalid` (422), `rate_limited`.

**Fetch** (`lib/githubApi.ts` `fetchPullRequest`, in parallel): PR with `full+json` (`body_html`), repo (merge methods, `delete_branch_on_merge`), issue comments, reviews (without PENDING; reviews without text stay), review comments (`line ?? original_line`, `in_reply_to_id`, no `diff_hunk`), at most 3 pages of 100 each; if there are more, the last three pages (the newest entries, via `rel="last"`). Checks for the head commit: jobs of the GitHub Actions runs (`/actions/runs?head_sha=` and `/jobs`, name "Workflow / Job", key `check:<job-id>` = check run ID), commit statuses (newest per context), check runs (`/check-runs`; a fine-grained token always gets 403 here, which is silently skipped) and check runs from webhook deliveries (`githubCheckRuns`, third-party apps). Merge by key: completed beats running, otherwise the later end; per name only the newest. At most 150 checks (failed and running ones are kept). If a permission for Actions, statuses or the branch is missing, the hint goes into `error` and the rest is current. If the fetch itself fails, `store` only sets `error` and `fetchedAt`; the old state stays. The action trims before `store` (argument size): description 300 kB, entries 3 MB in total (oldest trimmed first), checks 150.

**Store** (`githubPr.store` → `ops/githubPr.ts` `storeSnapshot`, one transaction): a fetch that started before the stored one (smaller `fetchedAt`) is discarded. Rewrite media (below), trim `bodyHtml` to 300 kB and each entry to 150 kB (all entries together at most 3 MB, newest first; note "… truncated, view on GitHub"), at most 300 entries (the newest). Reconcile entries by `key`: insert new ones, replace changed ones, delete vanished ones. `summary` (`comments` = comments and review comments, `review` = last decision per reviewer) for `summaries`. Update `pullRequests`: title, branch, `headSha`, `updatedAt`; state only if GitHub's `updated_at` is not older; `merged` stays `merged`. Open PR with mergeability `unknown`: retry in 3 s, at most twice (`mergeRetries`).

**Merge transition:** when a fetch sees a merged PR that is not yet `merged` in `pullRequests`, it sets `merged` and triggers the same effect as the webhook (`closeIssuesOnMerge` in `ops/github.ts`: issues with `closes` → done, notification `pr_merged`). Webhook and fetch both run as mutations and check the stored state; whoever comes first closes, the other sees "already merged". If the merge happened more than a day ago (e.g. a PR imported from Linear without a webhook), the fetch only updates the state and closes nothing.

**Fetches triggered by webhooks** (to save GitHub quota; webhooks deliver from all repos): only for PRs with at least one link in `issuePullRequests` or with `viewedAt` within the last 30 minutes. Delay 2.5 s (`pull_request`, comments, reviews) or 20 s (`check_run`, `check_suite`, `workflow_run`, `status`). `pullRequestDetails.refreshAt` holds the next scheduled time (the document is created for this even without a snapshot if needed); if the pending fetch runs no later than the new time, nothing is scheduled, otherwise the earlier one is added. `refreshOne({ prId, since })` claims the fetch (`claim`): if one has finished since `since` or one is running, it is skipped. `check_run` also puts the check into `data.checks` immediately if the head commit matches. Without `GITHUB_TOKEN` nothing is scheduled.

**Media** (`lib/githubMedia.ts`, proxy in `http.ts`): in `body_html` and entry HTML, `<img|video|source src|srcset|poster|data-canonical-src>` and links to media (png, jpg, gif, webp, svg, mp4, mov, webm) are rewritten when the browser can't load them without being signed in to GitHub: repo files of the PR's repo (`raw.githubusercontent.com/…`, `github.com/…/blob|raw/…`; blob links without `?raw=true` stay links) and uploaded attachments (`private-user-images.githubusercontent.com`, signature valid for 5 min). New URL: `<CONVEX_SITE_URL>/ghmedia/<mediaKey>/<index>`. `mediaKey` (32 random bytes) is fixed per PR, `media[index]` = `{ kind: 'repo'|'attachment', url, signedAt?, source?, resolved?, resolvedAt?, resigningAt? }`; at most 300; entries keep their index. A video link alone in its paragraph also gets a `<video controls preload="metadata">`. Other repos and hosts stay unchanged.

### ops, admin, seed

| Function | Arguments | Returns |
|---|---|---|
| `ops.status` (query) | – | `{ backup: { value: { ok, at, bytes, sha256, tables, documents, files, run }, at } | null, lastImport` ({ run, status, phase, startedAt, finishedAt, counts, deviations, error })`, agents: [Agent & { callsToday }]` (Agent: `keyPrefix`, or `null` for connectors, `connector: { app } | null`, `revokedReason`)`, connectors: { enabled, url }, connectorsArmedUntil, github: { event, receivedAt } | null` (last accepted delivery)`, sprintAudit: { value: { ok, problems, sprints, items, startedAt, error? }, at } | null, seed, storage` (file storage, see [images](#files-images))`, testSwitches, rejectWrites }` |
| `admin.setRejectWrites` | `{ value }` | `{ rejectWrites }` (only with `XLR8_TEST_SWITCHES=1`) |
| `seed.status`, `seed.reset`, `seed.insertBase`, `seed.insertIssues`, `seed.insertLinks`, `seed.finish` | see `convex/seed.ts` | owner only AND only with `XLR8_ALLOW_SEED=1` |

## HTTP endpoints (`convex/http.ts`)

Served under the site URL (locally the backend port + 1, in the cloud `https://<deployment>.convex.site`).

| Path | Behaviour |
|---|---|
| `POST /mcp` | Bearer key (format `xlr8_` + 43 characters, otherwise 401 immediately) or OAuth access token (`xlr8_at_…`) → SHA-256 → `internal.agents.authenticate` (failure → 401; for keys without `WWW-Authenticate`, for a missing bearer and for access tokens with it, if OAuth is on), then `handleMcpHttp` (`lib/mcp/endpoint.ts`). Read tools: `internal.mcp.countCall` (mutation, rate limit), then `internal.mcp.read` (query, cacheable). Write tools: **one** mutation `internal.mcp.call` (key, rate limit, idempotency, operation, result). Revoked between authentication and call → 401. Details: [`mcp.md`](mcp.md) |
| `GET`/`DELETE /mcp` | 405 |
| `GET /.well-known/oauth-protected-resource[/mcp]`, `GET /.well-known/oauth-authorization-server` | OAuth metadata for connectors (only with `XLR8_APP_URL`, otherwise 404). Other `/.well-known/*` → 404 |
| `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke` | OAuth for connectors (claude.ai, ChatGPT), only with `XLR8_APP_URL`. Details: [`mcp.md`](mcp.md#oauth-for-connectors) |
| `POST /github` | Read the raw body, verify `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET` (during rotation also `GITHUB_WEBHOOK_SECRET_PREVIOUS`) → otherwise 401. `ping` → 200. Otherwise `internal.github.applyDelivery` |
| `GET /logo/<storageId>` | Team logo, no sign-in (like a storage URL; `<img>` sends no token). Only files a team uses as its logo and that pass the logo check, otherwise 404. Response with `Content-Type` from the check (`image/svg+xml` or `image/png`), `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /img/<token>` | Image from a description or comment, no sign-in (the token is the access protection, see above). Unknown token → 404. `Content-Type` from the upload check, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Referrer-Policy: no-referrer`, `Cache-Control: private, max-age=31536000, immutable` (not in shared caches) |
| `GET /ghmedia/<mediaKey>/<index>` | Media from a PR, no sign-in (the key is the access protection, as with `/img`). Repo file: Contents API → fresh `download_url` (for private repos with a short-lived `token` parameter). Attachment: signed URL from the last fetch if younger than 4 min; otherwise refetch the post (description or comment/review, `source`) with `full+json` and store the fresh URLs of all its attachments (`github.com/user-attachments` cannot be resolved with a fine-grained token). The detail caches the `download_url` for 60 s (`resolved`). While one call is refetching a post (`resigningAt` on all attachments of that post, valid for 10 s), parallel calls wait up to 4 s for its result. Response `302` with `Cache-Control: private, max-age=60` (or the remaining cache time; `private, no-store` if the target is valid for less than 60 s), `Referrer-Policy: no-referrer`; no bytes pass through Convex. Assumption: GitHub's `token` parameter on a `download_url` stays valid for more than 2 minutes. Unknown or error → 404 without details |
| `GET /health` | `health.status` as JSON, no data |

If a mutation fails on write conflicts (Convex retried several times and gave up), the HTTP action retries up to six times with a random pause. Found in the concurrency test; important for GitHub, which does not retry failed deliveries on its own.

### GitHub webhook (`ops/github.ts`)

`internal.github.applyDelivery({ deliveryId, event, payload })` in one transaction:

1. `githubDeliveries.by_delivery`: already there → `{ duplicate: true }`, no effect.
2. `analyzePullRequestEvent` (`lib/github.ts`) with the team keys and only those old identifiers that appear in the PR. The payload is first reduced to the fields that are read (GitHub fields such as `_links` are not valid Convex values).
3. Create or update `pullRequests` by (`repo`, `number`). An older delivery (`updated_at`) overwrites nothing; `merged` stays `merged`.
4. Create `issuePullRequests` per identifier; existing ones are only raised from `closes: false` to `true`, never removed. History `pull_request` with actor `github`.
5. On merge, i.e. only on the **transition** of the stored PR state to `merged`: all links of the PR with `closes` → status `done` via `applyPatch` (actor `github`). Never for `done`, `canceled`, `duplicate` or issues in the trash. Further deliveries for an already merged PR (including a "Redeliver" after the 30-day list has expired, or a merged PR imported from Linear) close nothing; an issue reopened in the meantime stays open.
6. Schedule a fetch (debounced, see above). `pull_request` with **any** action (including `synchronize`, `labeled` …) updates `headSha`; link analysis stays limited to `opened`, `edited`, `reopened`, `ready_for_review`, `converted_to_draft`, `closed`. Also `issue_comment` (only with `issue.pull_request`), `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_run`, `check_suite`, `workflow_run` (PR via `pull_requests[].number` with its base in this repo, otherwise via `head_sha`) and `status` (via `sha` → `pullRequests.by_repo_head`). Only PRs that exist in `pullRequests`; otherwise `ignored`. `check_run` also stores the run in `githubCheckRuns` (a late "still running" delivery does not overwrite a result). Team keys are only read for `pull_request`.
7. Special case, merge through Selfbound before the `edited` delivery: if a new link with `closes` is created for an already merged PR (or `closes` is raised) and `mergedAt` is less than 10 minutes ago, it still closes its issue (as on the transition).

Returns `{ duplicate, kind: 'pull_request'|'ping'|'ignored'|'refresh', pr?, linked[], closed[], refresh? }` (`refresh`: PRs for which a fetch is scheduled or pending). The cron `requests-aufraeumen` deletes deliveries and `githubCheckRuns` after 30 days.

**Webhooks in all repos** (`githubPr.ensureWebhooks`, cron `github-webhooks`): checks all non-archived repos owned by the token's user (`/user/repos?affiliation=owner`, up to 300; optionally filtered with `GITHUB_REPOS` = "owner/name" or "owner/*", comma-separated) for a hook pointing to `<CONVEX_SITE_URL>/github` (or `<XLR8_PUBLIC_SITE_URL>/github`). If missing, creates it (`content_type: json`, secret = `GITHUB_WEBHOOK_SECRET`, events as above); other events or inactive → fixed via PATCH. Hooks are only created and changed with `GITHUB_MANAGE_WEBHOOKS=1`, not on a local backend (`isLocalDeployment`) and only with `GITHUB_WEBHOOK_SECRET`; otherwise only checked (`missing`/`outdated`). If the token lacks the "Webhooks" permission, the check stops after the first repo with a message. Result in `opsStatus.githubConnection`.

### Linear import (`importer.ts`, `ops/import.ts`)

`internal.importer.process({ run, notes? })` (action, started by `tooling/linear-import/index.ts push`) starts the run and waits up to 8 minutes for it to finish (after that `status: 'running'`, and `push` keeps waiting via `importer.summary`):

1. `importer.start` creates `importRuns` (`running`, `phase: 'scan'`) and schedules the first step. If a fresh run is already in progress → error.
2. Each step is its own function scheduled via the scheduler (`importer.step` → mutation `importer.advance`) and processes **one** page; phase, cursor, `maxNumbers` and `heartbeatAt` are stored on the run, and the next step is scheduled in the same transaction.
3. Phases: `scan` (highest Linear number per team), then paginated over `importStaging.by_run_kind` (`numItems` 100 issues or 200 others, `maximumBytesRead` 1 MB): `team`, `labelGroup`, `label`, `project`, `sprint`, `issue`, then `parent`, `comment`, `relation`, `pullRequest`, `link`. Each row yields `created`, `updated`, `unchanged` or `skipped`; the counts are in `importRuns.counts[step]`.
4. `cleanup`: delete the run's staging rows, then `done`. If a step throws → immediately `failed` with the error (staging stays). No progress for 15 minutes → `failed` (on the next start and via the cron `fail-stale-imports`).

Rules: matching via `linearLinks` (kind + Linear ID → Selfbound ID + checksum). Same checksum → untouched (for issues, `order`, `updatedAt`, `url` don't count). Issues: three-way merge per field against `linearLinks.base` (changed only in Linear → apply, old value in the history, old description in full in `bodyRevisions`; changed only in Selfbound → stays; changed in both → Selfbound wins, `importConflicts`). Permanently deleted issues (`purgedAt`) don't come back. Details: [`import.md`](import.md). Never touched: logos, team order and keys, Selfbound sprints and `sprintId`, `rank`, `reviewedAt`, `seq`, `deletedAt`, removed comments and relations. Teams, label groups, labels and projects that already exist in Selfbound with the same key or name are adopted instead of duplicated. If a Linear identifier collides with a Selfbound issue: Linear keeps the identifier, the Selfbound issue gets the next number after all of the team's Linear numbers, an alias and a history row (`identifier`), and an entry in `importConflicts`. Cycles become closed sprints (`source: 'linear'`, number from the shared counter); entries `kind: 'imported'` with `removedAt` (end of the sprint) and `outcome`; `issue.sprintId` stays empty. Only `ops/sprints.ts` writes these entries (`setImportedSprintItem`).

### Notifications (`push.ts`, `ops/notify.ts`, `lib/webpush.ts`)

Web Push without an extra package: `lib/webpush.ts` encrypts per RFC 8291 (aes128gcm) and signs the VAPID JWT (RFC 8292, ES256) with WebCrypto; this runs in the normal Convex runtime (no `"use node"`). Keys: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`tooling/vapid.mjs`). Notification texts are English by default and German when the Convex env var `XLR8_LOCALE=de` is set.

Tables: `pushSubscriptions` (one device per endpoint), `pushSettings` (one row, only deviations from the defaults), `pushEvents` (outbox, unique `key`, 7 days), `pushPresence` (devices with the app visibly open and in use).

1. **Event:** `notify(ctx, { kind, key, title, body, url, group?, tag?, issueId?, bundle? })` in the same transaction as the change. Disabled or `key` already present → nothing. Otherwise an entry `pending` and `push.deliver` in 10 s (only if none is already waiting). Callers: `createIssuesCore` and `addCommentCore` (only actor `agent`), `applyGithubDelivery` (`pr_linked` for new links, `pr_merged` on the transition to merged), cron `push-morning` (`due`, `sprint_end`, `snooze`; Berlin hour ≥ `morningHour`, once a day via a `key` containing the day; dormant teams don't count). The `snooze` event is one per returned issue (`key` = issue and day, `group` = the day, so several arrive as one message "N snoozed issues are back"); switching it off keeps the inbox return. The import, migrations and the owner's own changes send nothing.
2. **Delivery:** `push.claim` takes over all waiting entries in one mutation (never twice). If a device is active (`pushPresence.activeUntil` > now), they become `in_app` (the app shows them via `push.recent`) and `push.confirmInApp` checks after 45 s: if no app has confirmed them with `push.seen`, they go out as push after all (`retry`). Otherwise `bundleMessages`: the same `group` in the same delivery = one message (`bundle.title` with `{n}`), the same `tag` replaces on the device. `push.deliver` sends each message to each device (`Urgency: high`, `Topic` from the tag, TTL 24 h), `push.finish` records results: 404/410 removes the subscription, other errors count `failures`.
3. **Public** (owner only): `push.config`, `subscribe`, `unsubscribe`, `removeDevice`, `setEvent`, `presence`, `recent`, `seen`, `sendTest` (action, immediately to this device, no presence check). Plus `issues.share` (share target: issue in the inbox, team's triage status).

New event: add an entry to `shared/notifyEvents.ts` (label, hint, default) and a `notify` call where it happens. The settings page shows it automatically. Tests: `test/push.test.ts`, `test/lib/webpush.test.ts` (decrypts like a browser).

### Operations

`internal.opsStatus.recordBackup({ at, bytes?, sha256?, tables?, documents?, files?, run? })`: called by the backup workflow via `convex run` after a successful backup; writes `opsStatus.backup`. See [`backup.md`](../backup.md).

## Crons (UTC)

| Name | When | What |
|---|---|---|
| `run-recurrences` | hourly :05 | `maintenance.runDueRecurrences` |
| `audit-sprints` | daily 01:15 | `maintenance.auditSprints` (action): one query per page of 10 sprints (`maintenance.auditSprintPage`), Linear sprints skipped → `opsStatus.auditSprints` `{ ok, problems, sprints, items, startedAt }`; if a page fails: `{ ok: false, error, … }` |
| `purge-trash` | daily 02:30 | `maintenance.purgeTrash`: issues and knowledge pages older than 30 days (25 per run, for pages at most 40 revisions; reschedules itself) |
| `cleanup-requests` | daily 02:45 | `maintenance.cleanup`: `requests`, `githubDeliveries` and `githubCheckRuns` older than 30 days, `rateWindows` older than 2 days, `pushEvents` older than 7 days, `pushPresence` older than one day |
| `sweep-files` | daily 03:00 | `files.sweep`: delete unreferenced images once `deleteAfter` has passed (100 per run, reschedules itself) |
| `fail-stale-imports` | hourly :20 | `importer.failStale`: import runs without progress for 15 minutes → `failed` |
| `push-morning` | hourly :00 | `push.morning`: from the configured Berlin hour (default 8), once a day a combined "due/overdue" and "sprint ends tomorrow/today" notification; also returns snoozed issues whose day has come (inbox entry, push `snooze`) |
| `github-webhooks` | daily 03:30 | `githubPr.ensureWebhooksDaily`: check webhooks in all repos owned by the token's user, create missing ones (only with `GITHUB_MANAGE_WEBHOOKS=1` and the secret, never locally; nothing without `GITHUB_TOKEN`) |
| `cleanup-oauth` | hourly :35 | `oauth.cleanup`: expired tokens, OAuth requests one day after expiry, never-approved clients after one hour (500 per run, reschedules itself) |

The cron names are internal identifiers in `convex/crons.ts`.

## Convex limits

Queries go through indexes. Unbounded `.collect()` only happens on small sets (one bucket, the entries of one issue or sprint). Reference data and lists have fixed upper bounds (`take`). Cleanup jobs run in pages and reschedule themselves. The seed sends 100 issues per call.

## Test data

`data/generate.ts` generates deterministic data (fixed seed, reference time 2026-10-08 12:00 UTC) with invented content only:

- 10 teams (ORB, NOVA, PX, FLUX, KITE, ZEN, MOSAIK active; RIFF, LUMA, QB dormant), 3 of which use estimates.
- Label groups "Type" (single choice) and "Area", workspace labels, one team label; 0–4 projects per team.
- Data sets `small` (440 issues) and `large` (10,000). Status distribution roughly 56 % open, 34 % done, 7 % canceled, 3 % duplicates; dormant teams mostly closed.
- Descriptions of 0.5–3 KB Markdown with headings, 0–10 comments (owner and agents), history, relations, sub-issues, due dates, ranks in random order, issues in the trash, unreviewed agent issues.
- Sprints 1–3 closed (done, carried over, back to backlog, canceled), sprint 4 active (planned, late, carried over from 3), sprint 5 in planning.
- 2 agents (keys local only, stored as hashes), 2 recurrences, 5 old identifiers `PIX-n`.

## Running and testing locally

```sh
pnpm install
node tooling/local.mjs --port 13420 --seed small --no-wait   # anonymous Convex, local sign-in, test data
node tooling/local.mjs --port 13420 --seed large --reset --no-wait
pnpm --filter @selfbound/backend test        # Vitest + convex-test (edge-runtime)
pnpm --filter @selfbound/backend typecheck   # tsc 7 for convex/ and for scripts/, data/, test/
pnpm --filter @selfbound/backend test:integration   # fresh backend on 13490: import, MCP, concurrency
```

`local.mjs` sets `XLR8_DEV_JWKS`, `XLR8_OWNER_IDS`, `XLR8_ALLOW_SEED=1` and `XLR8_TEST_SWITCHES=1` in the local backend and writes `app/.env.local` with the URL and a local token. On start, Convex regenerates `convex/_generated` (it is checked in). The seed skips if the same data set is already complete, and refuses any non-local URL. Rough timings (on a busy machine, order of magnitude only): `small` on an empty backend under 1 s, `large` 27–75 s; clearing after `large` (`seed.reset`, 2000 documents per call because of the read limits) takes one to one and a half minutes.

Tests (`backend/test/`): regression tests from an earlier backend review (`regressions.test.ts`, one block per finding), MCP over HTTP (`mcp.test.ts`), GitHub webhook (`github.test.ts`), pull requests in Selfbound with a mocked GitHub (`githubPr.test.ts`: scheduling and debouncing fetches, reconciling entries, trimming, merge transition, actions, media proxy, webhooks in all repos; building blocks in `lib/githubApi.test.ts`), import with retry, collision and update (`import.test.ts`), sign-in sweep over all modules, issues (create, numbering with batches of 50 and parallel calls, update, compare-and-set with label sets, undo, parent cycles, budget, rank), idempotency, description versioning, trash and permanent deletion, relations, comments, search, identifiers, test switches, sprints (start/add/close rules, one active sprint, invariant after every operation, capacity, nightly audit), teams and team permissions, logo validation, images (type check, serving, references in several places, cleanup after the grace period and after permanent deletion, `files.test.ts`), agent keys and rate limit, recurrences (month boundaries, DST, idempotency), calendar days against `Intl`, generator and seed.
