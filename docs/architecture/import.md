# Importing from Linear: format and processing

The importer copies a Linear workspace into Selfbound. It only reads from Linear; nothing is ever written back.

## Overview

1. **Fetch (local, `tooling/linear-import/`).** `node tooling/linear-import/index.ts fetch` reads your Linear data through the GraphQL API and writes a snapshot outside the repository.
2. **Upload and 3. Process** in one command: `node tooling/linear-import/index.ts push <dir>`. After a typed confirmation, `staging.jsonl` is loaded in batches into the staging table via `convex run importer:stage`, then the internal action `importer.process` starts the run. The run is a chain of scheduled steps (one batch per step) and deletes the staging rows at the end; `push` waits until it is finished.

Each run records its counts and deviations in `importRuns` (conflicts in `importConflicts`); `push` prints them, and `summary.json` holds the notes from fetching. Only counts and identifiers, never titles or text.

## What changes when importing from Linear

This is the user-facing summary. It applies to the first import and to every later import.

### Stays the same

- **Identifiers** such as `ACME-106` are kept. Old identifiers (for example after an issue moved to another team in Linear) keep working: in search, in `/issue/…`, in MCP and in the GitHub webhook.
- Title, description, status, priority, labels, project, estimate, due date, parent, relations, comments, and the created / started / completed / canceled timestamps.
- Issue order follows the creation date in Linear.

### Changes

| Area | In Linear | In Selfbound |
|---|---|---|
| Files and images | uploaded to Linear | stay links to `uploads.linear.app` and are not copied by the import itself. Signed links (`?signature=…`) expire after minutes and then show nothing. Run the [`files` tool](#files-from-linear) to copy them into Selfbound |
| Other attachments (Figma, links) | attachment on the issue | one comment "Attachments from Linear" on the issue with one line (title and link) per attachment |
| GitHub PRs | attachment from the Linear GitHub app | linked PR on the issue. An imported PR never closes anything; from then on the Selfbound webhook does that |
| Assignee | assignee | dropped: Selfbound is single-user and has no assignee |
| Triage intelligence | Linear's suggestions (e.g. "similar issues") | dropped, including relations of type `similar` |
| Author | Linear user | Linear name plus "(Linear)", e.g. "Jane Doe (Linear)"; bots by their name, e.g. "GitHub (Linear)". The issue itself counts as created by the import |
| Comment threads | replies nested under a comment | one flat list by time; a reply has no reference to the comment it answers |
| Status | custom statuses per team | each Selfbound team has its own statuses, but custom Linear statuses are not created. Mapping goes by type into the eight status kinds (Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate), then to the team's status with the same name or the default status of that kind. A custom status like "Testing" lands in the default "in progress" status and is listed in the report. A status that cannot be mapped aborts the import. See [Status mapping](#status-mapping) |
| Projects | can belong to several teams | belong to exactly one team: the one with the most issues of the project. The report counts these cases |
| Project status | custom project statuses | planned, active, paused, done, canceled |
| Cycles | per team, run automatically | closed sprints named after the cycle (or "`<TEAM>` Cycle n") with source Linear. They do not count toward the capacity of new sprints. An issue appears only in its last cycle |
| Archived issues | hidden | present as normal issues, with their status |
| Deleted issues (trash) | 30 days in Linear's trash | not imported |
| Archived or retired teams | archived | "dormant": not in the sidebar, but in search and lists |
| Archived labels | archived | marked as archived |
| Reviewed | – | imported issues count as reviewed; only new agent issues are "unreviewed" |
| Labels or project from another team | possible (e.g. after a team change) | dropped and counted in the report; in Selfbound, team labels and projects belong to exactly one team |
| Teams, labels, projects that already exist in Selfbound | – | linked to Linear instead of duplicated (same team key or same name) |

The attachments comment is written by the author "Linear (attachments)". Comments whose Linear author is unknown are attributed to "Unknown (Linear)".

### Re-importing

You can run the import again at any time. Every issue field is compared on its own with the value from the previous import:

- **Changed only in Linear:** the Linear value is applied, your old value stays in the history (actor "import"). An overwritten description is kept in full as an earlier revision.
- **Changed only in Selfbound:** your value stays.
- **Changed in both:** your value stays, and the run lists the issue with the field names under conflicts. For the description, the Linear version is kept for comparison.
- A new "last updated" timestamp in Linear alone does not count as a change.
- Issues you permanently deleted in Selfbound do not come back.
- Selfbound-only data (team logos, sprints, rank, "reviewed") is not touched.
- If an issue created in Selfbound collides with a Linear identifier, Linear keeps the identifier; the Selfbound issue gets the next free number, its old identifier becomes an alias, and the report names it.

Details: [Step 3: Process](#step-3-process).

## Step 1: Fetch

- **API key:** `~/.config/xlr8/linear-api-key`, readable only by you (mode 600). If the mode is different, the file is a symlink, empty or missing, the script stops and explains what to do. `--key-file <path>` uses another file.
- **Read-only guard** (`client.ts`, `assertReadOnly`): every document is parsed with `graphql.parse` before it is sent. Exactly one named `OperationDefinition` with `operation === 'query'` is allowed. Mutations, subscriptions, fragments, type definitions and multiple operations in one document are rejected without sending anything.
- **Audit trail:** `operations.jsonl` logs every request sent (operation name, type `query`, time, HTTP status, attempt). `summary.json` counts the requests per operation.
- **Pagination:** `first`/`after`/`pageInfo`. Issues come in pages of 20, with labels, attachments, relations and comments at 25 each. If that is not enough, the script fetches the rest per issue (`XlrIssueCommentsMore` etc.). This keeps every request under Linear's complexity limit.
- **Rate limit:** on HTTP 429 or error code `RATELIMITED` the script waits (`Retry-After`, else `X-RateLimit-Requests-Reset`/`-Complexity-Reset`, else 1, 2, 4 … 60 s) and retries up to 8 times. 5xx and network errors: up to 4 retries. A rejected key stops immediately.
- **Console output:** only counts, identifiers and status names. Titles, descriptions and comments never appear.
- `--dry-run` fetches and checks everything but writes nothing.
- `--map-status "Name=status"` maps a Linear status by hand (repeatable).
- `--out <dir>` changes the output root.

Output in `~/.local/share/xlr8/import/<run>/` (directory 700, files 600; `run` is a timestamp such as `2026-10-08T21-30-00Z`):

| File | Content |
|---|---|
| `snapshot.json` | snapshot, type `ImportSnapshot` from `backend/convex/shared/importTypes.ts` |
| `staging.jsonl` | one line per record for `importStaging` |
| `operations.jsonl` | log of the GraphQL requests |
| `summary.json` | counts, notes, requests per operation |

If the output directory is inside the repository, the script stops before the first request.

## Step 2: Upload and start (`push`)

```sh
node tooling/linear-import/index.ts push ~/.local/share/xlr8/import/<run>    # asks, then uploads + processes
node tooling/linear-import/index.ts push <dir> --yes                          # no prompt (tests only)
node tooling/linear-import/index.ts push <dir> --backend-dir <dir>            # another local backend (tests)
node tooling/linear-import/index.ts push <dir> --prod                         # production, always asks
```

`push` (`tooling/linear-import/push.ts`):

1. reads `staging.jsonl` (exactly one run) and `summary.json` (notes from fetching),
2. shows the target and the number of records per kind and asks you to type `import`. Locally the target comes from `backend/.env.local` and must be `local:…` or `anonymous:…`, otherwise it stops. With `--prod` it shows "PRODUCTION <deployment> (….convex.cloud, app <app URL>)"; `--yes` and `--backend-dir` are not allowed then, and the prompt always appears. The production deployment and app URL come from the instance settings (`convexDeployment`, `appUrl` in `deploy/instance.json`, see `tooling/instance.mjs`); without them `--prod` stops,
3. runs `convex run importer:stage '{"rows": […]}'` in batches of up to 90 KB and 500 rows (a single argument may be at most 128 KiB on Linux; a single larger row stops with its kind and Linear ID). Locally this goes through `tooling/convex.mjs`, with `--prod` through `tooling/cloud.mjs` (deploy key from `~/.config/xlr8/convex-deploy-key`; a key for another deployment stops). `convex import --append` is not used because in production it needs backup permissions (`deployment:backups:view`) that a deploy key does not have,
4. runs `convex run importer:process '{"run": …, "notes": […]}'`. The action waits up to 8 minutes for the run to finish. If it is still running, it returns `status: 'running'` with `runId`, and `push` polls `convex run importer:summary '{"runId": …}'` every 5 s until the run is `done` or `failed`,
5. prints the counts per step (read, new, changed, unchanged, skipped), plus conflicts and deviations. Exit code 0 only on success.

`tooling/convex.mjs` only targets local deployments; production goes exclusively through `tooling/cloud.mjs`. If the production deployment already holds data you care about, take a backup first ([backup.md](../backup.md)).

## Format of `staging.jsonl`

Each line is a document of the `importStaging` table:

```json
{"run":"2026-10-08T21-30-00Z","kind":"issue","linearId":"<Linear ID>","payload":{ … }}
```

- `run`: the run. Several runs can sit side by side; one run is processed at a time.
- `kind` and `payload` (types in `importTypes.ts`):

| kind | payload | Phase |
|---|---|---|
| `team` | `ImportTeam` | 1 |
| `labelGroup` | `ImportLabelGroup` | 1 |
| `label` | `ImportLabel` | 1 |
| `project` | `ImportProject` | 1 |
| `sprint` | `ImportSprint` (from Linear cycles) | 1 |
| `issue` | `ImportIssue` | 1 (parent in phase 2) |
| `comment` | `ImportComment` | 2 |
| `relation` | `ImportRelation` | 2 |
| `pullRequest` | `ImportPullRequest` (`linearId` = attachment ID) | 2 |
| `link` | `ImportLink` (other attachments) | 2 |

- References always use Linear IDs (`teamLinearId`, `parentLinearId` …), never Selfbound IDs.
- Times are milliseconds (UTC); calendar days are `YYYY-MM-DD` in Europe/Berlin (hard-coded in `normalize.ts`). Fields without a value are omitted; there is no `null`. The file is sorted in processing order.
- References to data that is not part of the import (for example a parent in Linear's trash) are already removed by the script and counted as a note.

## Step 3: Process

Code: `backend/convex/importer.ts`, `backend/convex/ops/import.ts`.

Principles:

- **Batches:** at most about 100 issues or 1 MB per mutation, in the order of the table above, via the index `by_run_kind`.
- **Resumable steps:** `importer.start` creates the `importRuns` row (`phase: 'scan'`) and schedules the first step. Each step (`importer.step`, an action that calls the mutation `importer.advance`) processes exactly one batch, stores `phase`, `cursor`, `maxNumbers` and `heartbeatAt` on the run and schedules the next step in the same transaction. Phases: `scan` (highest Linear number per team), then the import steps, then `cleanup` (delete staging rows), then `done`. If a step throws, the run is set to `failed` with the error text. A run without progress for 15 minutes (for example after a backend restart) becomes `failed`: on the next `importer.start`, and hourly via the cron `fail-stale-imports` (`importer.failStale`). While a fresh run is `running`, `start` rejects a second one.
- **Repeatable without duplicates:** before creating anything, look it up in `linearLinks` (`by_kind_linear`). If the entry exists, reconcile instead of creating. `hash` stores a checksum of the payload; if it is unchanged, the record is not touched. For issues, `order`, `updatedAt` and `url` are excluded from the checksum: they change in Linear without any change to the content. A second run right after the first must give the same counts.
- **Three-way merge for issues:** `linearLinks.base` holds, per issue, the last imported Linear values in Selfbound form (title, status, priority, label IDs, project, estimate, due date, parent, plus a checksum of the description). When a payload has changed, each field is decided on its own:

  | Linear since last import | Selfbound since last import | Result |
  |---|---|---|
  | unchanged | any | Selfbound value stays |
  | changed | unchanged | Linear value applied, old value in history (actor `import`) |
  | changed | changed to the same value as Linear | nothing to do |
  | changed | changed differently | Selfbound value stays, entry in `importConflicts` (identifier and field names, no content) |

  Afterwards `base` holds the new Linear values, so the same conflict is reported only once. `startedAt`, `completedAt` and `canceledAt` follow the status (only when the status is applied). If `base` is missing (link created before the merge existed), every difference counts as a conflict: Selfbound wins.
- **Description:** when it is overwritten (only for "changed only in Linear"), the previous version goes **in full** into `bodyRevisions` (`reason: 'import_overwrite'`, with its version). On a conflict the Selfbound version stays, and the Linear version that was not applied is stored in `bodyRevisions` (`reason: 'import_conflict'`). Readable via `issues.revisions`. Why a separate table and not a comment: a description may have 200,000 characters, a comment only 50,000, and an "earlier version" comment would sit in the middle of the conversation and in comment search. A `bodyRevisions` document with at most 200,000 characters (under 800 KB) stays safely below Convex's 1 MiB limit.
- **Permanently deleted:** when emptying the trash purges an imported issue, its `linearLinks` entry gets `purgedAt`. Later runs do not recreate it (`skipped`, deviation "permanently deleted in Selfbound"); its comments, relations, PRs and attachments are skipped too.
- **Actor:** `{kind: 'import'}` for history, `createdBy` and comments.
- **Run:** `importRuns` with counts and deviations (`notes` from `summary.json`), conflicts in `importConflicts`.

### Phase 1

1. **Teams:** `key`, `name`, `dormant`. Color: the Linear hex color is converted to an OKLCH hue (`hue`). `order` follows the order in the snapshot.
2. **Label groups and labels:** groups are always single-select in Linear (`exclusive: true`). Archived labels get `archived: true`.
3. **Projects:** exactly one team (`teamLinearId`). Linear allows several teams; the script picks the team with the most issues in the project. Status: `backlog`/`planned` → `planned`, `started` → `active`, `paused` → `paused`, `completed` → `done`, `canceled` → `canceled`.
4. **Sprints:** `state: 'closed'`, `source: 'linear'`, name from Linear or "`<TEAM>` Cycle 12". Selfbound numbers sprints across all teams, Linear per team: `number` is assigned in `startsAt` order. Linear sprints do not count toward capacity.
5. **Issues** in `order` (= creation date):
   - `seq` = next counter in that order, `bucket = floor(seq / 64)`. On a later import, an already imported issue keeps its `seq`.
   - `teamId` + `number` from Linear, so the identifier stays the same.
   - `issueBodies` with `description` (version 1).
   - `identifierAliases` for every identifier in `previousIdentifiers`.
   - `labelIds` and `projectId` via `linearLinks`, status per the [mapping](#status-mapping). `startedAt`, `completedAt`, `canceledAt` from Linear. `createdBy: {kind: 'import'}`, `reviewedAt` set (counts as reviewed, no inbox entry).
   - Sprint: `sprintItems` with `kind: 'imported'` for `cycleLinearId`. `outcome` by status: done → `done`, canceled/duplicate → `canceled`, otherwise `backlog`. `issue.sprintId` stays empty because the sprint is closed (sprint invariant, see [backend.md](backend.md#invariants)).
   - At the end: team counter = highest number + 1.

### Phase 2

1. **Parent:** `parentLinearId` → `parentId`, only for issues that are new in this run or changed in Linear, with the same three-way merge as the fields (`base.parentId`).
2. **Relations:** `blocks`, `related`, `duplicate`. `from` and `to` as in the payload.
3. **Comments:** flat, by `createdAt` (from Linear). `authorName` as in the payload ("Jane Doe (Linear)", "GitHub (Linear)"), actor `import`. `parentLinearId` (reply in a thread) is not used; the reply simply appears in time order.
4. **PRs:** create or find `pullRequests` by (`repo`, `number`) (an existing PR, e.g. from the webhook, stays unchanged), then `issuePullRequests` with `via: 'import'` and `closes: false`. A PR on two issues gives one PR and two links.
5. **Links (other attachments):** one comment per issue, "**Attachments from Linear**" (actor `import`), with one line `- [Title](URL)` per attachment. Attachments from later runs are appended.

### Processing decisions

- **Batches:** `paginate` over `by_run_kind` with `numItems` (100 issues, otherwise 200) and `maximumBytesRead` 1 MB, one batch per scheduled step. The `scan` phase determines the highest Linear number per team.
- **Unchanged means untouched:** if the payload has not changed since the last run (same checksum in `linearLinks.hash`), the record stays as it is in Selfbound, even if you edited it there. If it changed, issues go through the per-field three-way merge (above); your edits to fields Linear did not touch are kept.
- **Adopt what exists:** a team with the same key, a label group or label with the same name (same team, same group), and a project with the same name in the same team are linked instead of duplicated. Name, dormant and color then come from Linear; key, order and logos stay.
- **Labels and projects from another team** on an issue are dropped (invariants 7 and 8 in [backend.md](backend.md#invariants)) and counted as a deviation. Archived labels stay on imported issues.
- **Timestamps:** `createdAt`, `startedAt`, `completedAt`, `canceledAt` from Linear; `updatedAt` = time of the import (so the app sees the change). `reviewedAt` = import time (counts as reviewed).
- **Removed in Selfbound stays removed:** deleted comments are not restored, removed relations are not recreated. Issues in the Selfbound trash keep `deletedAt`; permanently deleted ones do not come back (`purgedAt`).
- **Team changed in Linear** (new identifier): Selfbound takes over team and number, the old identifier becomes an alias.
- **Deviations** (`importRuns.deviations`): the notes from `summary.json` plus those from processing, only counts and identifiers, at most 1000.

### Status mapping

| Linear type | Name | Selfbound status kind |
|---|---|---|
| `triage` | any | `triage` |
| `backlog` | any | `backlog` |
| `unstarted` | any | `todo` |
| `started` | "In Review" | `in_review` |
| `started` | other | `in_progress` |
| `completed` | any | `done` |
| `canceled` | "Duplicate" | `duplicate` |
| `canceled` | other | `canceled` |
| `duplicate` | any | `duplicate` |
| other type | – | **abort** with a list (team, name, type, issue count) |

Current Linear workspaces return "Duplicate" with its own type `duplicate`, older ones with type `canceled`; both are handled.

Names are compared case-insensitively. Statuses with names other than Linear's defaults (Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate) are mapped by type and named in the report, e.g. `Status "Testing (started)" mapped to in_progress`. `--map-status` overrides any mapping.

Each Selfbound team has its own statuses (`workflowStates`). The table gives the **status kind** (`issue.status`); the backend then picks the team's status with the same name if its kind matches, otherwise the status for that kind (`stateForStatus`: the default status with that kind first). Custom Linear statuses are not created as new Selfbound statuses.

For Linear's default names this means (test "state per team" in `backend/test/import.test.ts`): Triage, Backlog, Todo and In Review hit the Selfbound status of the same name; In Progress, Done, Canceled and Duplicate match the Selfbound default status of that name too (default names in `DEFAULT_STATES`, `backend/convex/shared/workflow.ts`); on a deployment with `XLR8_LOCALE=de` the default names are German, and these four go to the team's default status of their kind. A custom status like "Testing" lands in the default in-progress status.

## Verified field names and open questions

All queries in `queries.ts` validate against Linear's public schema (`packages/sdk/src/schema.graphql` in the `linear/linear` repository). The test `backend/test/lib/linear-import/schema.test.ts` repeats the check when `LINEAR_SCHEMA` points to the schema file. Fields used include `Team.retiredAt`, `IssueLabel.isGroup`/`parent`, `Project.status { type }` (instead of the deprecated `Project.state`), `Project.teams`, `Issue.previousIdentifiers`, `Issue.trashed`, `Issue.botActor`, `Comment.botActor`, `Attachment.sourceType`/`metadata` and `IssueRelation.relatedIssue`.

Not derivable from the schema, so uncertain:

1. **PR attachments:** the format of `Attachment.metadata` is undocumented (`JSONObject`). The script reads the state defensively from `status`/`state`, `merged`/`draft`, `mergedAt`/`closedAt`, and the branch from `branch`/`branchName`/`headRefName`. Without a recognizable state the PR counts as `open` (counted in the report). A PR is recognized by its URL `github.com/<owner>/<repo>/pull/<n>`, not by `sourceType`, whose values are undocumented too.
2. **Cycle end:** `endsAt` is assumed to be the moment the cycle ends, so the last day is the calendar day just before it (Europe/Berlin).
3. **Comments:** `Issue.comments` is assumed to include thread replies (with `parent`). If they are missing there, they are missing from the import.
4. **`includeArchived: true`** is set for all lists. Archived issues come with `archivedAt` and are imported normally. Deleted issues (trash, `trashed`) are not imported.
5. **Rate limit:** according to Linear's docs the limit is signaled with error code `RATELIMITED`; the HTTP status is not clearly documented (400 or 429). The script handles both.
6. **Complexity:** the page sizes (20 issues × 25 nested items) are an estimate, not a measurement. If Linear reports excessive complexity, lower `ISSUE_PAGE_SIZE` or `NESTED_PAGE_SIZE` in `queries.ts`.
7. **Relations:** only `Issue.relations` (outgoing) is read. Since every issue is read, every relation appears once. Type `similar` (Linear's suggestions) is not imported.

## Files from Linear

The import copies text, not the files behind it: descriptions and comments still point to `uploads.linear.app` afterwards. Those files require a Linear login, and signed URLs (`?signature=…`) expire after five minutes. The `files` tool copies them into Selfbound storage and rewrites the references. Every step can be repeated; a second pass changes nothing.

```sh
node tooling/linear-import/index.ts files scan     --prod                  # read only → refs.json
node tooling/linear-import/index.ts files download --prod                  # Linear key, GET only → files/, manifest.json
node tooling/linear-import/index.ts files upload   --prod [--substitute <sha256>=<file> …]
node tooling/linear-import/index.ts files rewrite  --prod [--link <sha256>=<https-url> …]
```

- **Working directory:** `~/.local/share/xlr8/linear-files/prod/` (locally `…/local/`, or `--dir`), directory 700, files 600, never inside the repository. For `download`, `--prod` only selects this directory.
- **scan:** `linearFiles:scan` reads `issueBodies`, `comments`, `bodyRevisions` and `recurrences` page by page. A file is identified by its URL without `?…` and `#…` (`shared/linearFiles.ts`).
- **download:** one `GET` per file with the key from `~/.config/xlr8/linear-api-key` (mode 600, as for fetching), only to `uploads.linear.app`. Stored under the SHA-256 of the content. Files already downloaded are skipped.
- **upload:** the same check as when pasting an image (PNG, JPEG, WebP, GIF up to 5 MB). `linearFiles:uploadUrl` and `linearFiles:register` are internal functions (actor `import`), reachable only with the deploy key. The mapping lives in `linearLinks` (`kind: 'file'`, `linearId` = Linear URL, `localId` = image token); identical content under two URLs is uploaded once. Non-images and oversized files are left out. `--substitute` uploads an edited version instead of the Linear file (for example a smaller GIF).
- **rewrite:** `linearFiles:rewrite` replaces every reference that has a target with `/img/<token>` or with the URL given via `--link` (for example videos hosted elsewhere; a Google Drive link alone on a line is embedded). First a dry run with counts, then the confirmation `rewrite` (always typed in production), then a check with `scan`. Descriptions get a new version and a history line (actor `import`), comments a `comment_edited` line, without `editedAt`. Removed comments are not touched. Image references (`fileRefs`) are created on write; without a reference, the cron deletes a copied image after 7 days like any fresh upload.
- **Later imports:** `linearLinks.base` keeps the old description checksum. A new import therefore sees the description as "changed in Selfbound" and leaves it alone.

## Documents from Linear

`fetch` does not download Linear documents. A document saved as a Markdown copy can be imported on its own as a knowledge page:

```
node tooling/linear-import/index.ts document <copy.md> --team <KEY> [--project <name>] [--accessed <YYYY-MM-DD>] [--prod]
```

`tooling/linear-import/document.ts` parses the copy. Expected layout (the German labels `Linear-ID`, `Projekt in Linear`, `Angelegt`, `Geändert` of older copies are accepted too):

```
# Title
<note line about the copy>
- Linear ID: <uuid>
- Project in Linear: <name>
- Created: <ISO> · Updated: <ISO> · by <name>
- URL: https://linear.app/…
---
<text>
```

Title from the H1; `Linear ID` (re-running does not duplicate); `Project in Linear` (default for `--project`); `Created`/`Updated` (become the page's `createdAt`/`updatedAt`); `URL` (becomes the source "Linear document (original)" with the access date). The text is everything after the first `---` line. On an unknown layout the tool stops. The console shows only lengths, timestamps and identifiers. Confirm by typing `import` (always with `--prod`).

The backend (`importer:importArticle`, `importDocument` in `ops/wiki.ts`, actor `import`) turns on the team's knowledge area if it is off and records the page in `linearLinks` (kind `document`). A second run changes nothing (`unchanged`). A changed copy becomes a new version; the old text stays as a revision. Pages in the trash or permanently deleted pages stay where they are.
