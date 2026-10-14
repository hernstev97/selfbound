# MCP server for agents

Code: `backend/convex/http.ts`, `backend/convex/mcp.ts`, `backend/convex/ops/mcp.ts`, `backend/convex/ops/move.ts`, `backend/convex/lib/mcp/*`; OAuth: `backend/convex/lib/oauth/*`, `backend/convex/ops/oauth.ts`, `backend/convex/oauth.ts`

Agents (such as Claude Code or Codex) read and change issues over MCP. They use the same operations as the UI (`ops/*.ts`); only the authentication in front is different. Claude (claude.ai, desktop, mobile) and ChatGPT connect as a **connector** via OAuth (see [OAuth for connectors](#oauth-for-connectors)); to XLR8, every connector is just another agent.

## Endpoint

| What | Value |
|---|---|
| URL | `<site>/mcp`. Locally `http://127.0.0.1:<port+1>/mcp` (with `--port 13480` that is `13481`). In production, either a custom domain such as `https://mcp.xlr8.example.com/mcp` (for connectors, see [Custom MCP domain](#custom-mcp-domain)) or the Convex site URL `https://happy-otter-123.convex.site/mcp` (fine for key-based agents) |
| Transport | Streamable HTTP, JSON responses only (no SSE), stateless (no session ID) |
| Protocol | 2024-11-05 through 2025-11-25 with `initialize`, plus 2026-07-28 without handshake (`server/discover`) |
| Required fields in 2026-07-28 | Every result carries `resultType: "complete"`. `server/discover` and `tools/list` are "cacheable" and also need `ttlMs` (integer ≥ 0) and `cacheScope` (`public`/`private`); if they are missing, Claude Code rejects the whole response. We send `ttlMs: 60000`, `cacheScope: "public"` (`CACHE_HINTS` in `protocol.ts`; the tool list is the same for every agent). `tools/call` and `ping` don't need them. Contract test: `test/lib/mcp/protocol.test.ts`, "contract: required fields per method". |
| Authentication | Agents: `Authorization: Bearer xlr8_…` (key created in the app, stored only as SHA-256). Connectors: `Authorization: Bearer xlr8_at_…` (OAuth access token, valid for 1 hour) |
| Unknown or revoked key | `401` with a JSON-RPC error, **without** `WWW-Authenticate`. This way a key-based client (Claude Code, Codex) never starts an OAuth flow. A key revoked between authentication and the tool call also gets `401` (not a tool error). |
| No bearer, foreign bearer, access token invalid, expired or revoked | `401` **with** `WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource/mcp", scope="xlr8"` (plus `error="invalid_token"` if a token was presented). This makes claude.ai and ChatGPT sign in or refresh their token. Only when OAuth is enabled (`XLR8_APP_URL`); otherwise same as for keys. |
| Key format | `xlr8_` + 43 base64url characters (`^xlr8_[A-Za-z0-9_-]{43}$`), access tokens `xlr8_at_` + 43 characters. Bearers starting with `xlr8_` that match neither format get `401` without a database query. |
| `Origin` | Always allowed when absent; otherwise only `https://claude.ai`, `https://claude.com`, `https://chatgpt.com` (in case their servers send one). Anything else gets `403`. |
| `GET`, `DELETE` | `405` |
| Rate limit | 120 tool calls per minute and 5000 per day, per agent. Above that: tool error `rate_limited` with `retryAfterMs`. Failed calls count too, including calls with invalid arguments or an unknown tool. |

## How a tool call runs

Code: `backend/convex/lib/mcp/endpoint.ts` (tested without Convex in `test/lib/mcp/endpoint.test.ts`), wired up in `convex/http.ts`.

1. HTTP action: read the key or access token, check the format, hash with SHA-256, call `internal.agents.authenticate` (one query; looks among keys first, then among access tokens, and checks their expiry). Failure → 401. All further internal functions only receive this hash.
2. `handleMcpHttp` validates JSON-RPC and the arguments against the tool's schema (English error messages with the path). If that fails, `internal.mcp.countFailedCall` still counts the call.
3. **Read tool** (`readOnlyHint`): first `internal.mcp.countCall` (small mutation: check revocation and expiry, count the call), then `internal.mcp.read` (a **query**: check the key again, run the tool). The action passes the calendar day (Europe/Berlin) as the argument `today`, so the query doesn't depend on the clock. For the same reason `read` does not check access token expiry; `countCall` did that right before.
4. **Write tool:** **one** internal mutation `internal.mcp.call` does everything in one transaction: check key and revocation again, count the call, idempotency (requestId), run the operation with actor `{kind: 'agent', agentId}`, store the result. If it fails for a business reason, everything is rolled back; `countFailedCall` then counts the call.
5. If a mutation fails because of write conflicts (many concurrent changes to the same issue), the action retries up to six times. That is safe because a failed mutation wrote nothing.

**Why read tools run as a query:** Convex caches query results. If an agent calls the same tool with the same arguments again and the data it read hasn't changed, the database reads nothing. A reading mutation is also retried on every concurrent change to a document it read; a query is not. The cost is one more function call (action, authenticate, count, read = 4 instead of 3). At 5000 calls a day that is at most 20,000 of the roughly 33,000 function calls per day on the Convex free plan. Counting and reading are no longer atomic: if the key is revoked in between, the query rejects the call (401).

**Errors:** Business errors (unknown identifier, conflict, trash, rate limit) come back as a tool result with `isError: true` and plain text `code: message`, so the model can correct itself. An unexpected error reads "Internal error …; retrying with the same requestId is safe".

**Idempotency:** `requestId` is required for `create_issues`, `add_comment`, `create_article` and `update_article`, and optional for `update_issue`, `set_status` and `move_issues` (setting the same values again changes nothing; with a requestId, a retry after a lost response returns the original result instead of a conflict with the agent's own change). The **whole** tool is wrapped in the check, keyed on the agent's raw arguments (team key, label and project names, identifiers): a retry returns the stored result even if a name no longer resolves (label archived, issue in the trash). Same requestId with different arguments → error. Each agent has its own namespace; the requestId is recorded in the history.

**Archived labels:** Agents cannot assign them (`list_labels` doesn't show them). If an archived label is already on the issue, `update_issue` may keep listing it in `labels`.

**Permissions:** There is no tool for teams or logos. Agents can create issues, change them, set status, move them to another team, and comment. Issues created by agents without an explicit status land in triage (the team's triage status) and appear in the owner's inbox until the owner dismisses the entry. So do changes by agents to existing issues (status, comment, description, any field): one entry per issue, however many changes. `get_issue` reports `reviewedBySteven` (legacy field name; it refers to the owner): true unless an unread inbox entry is waiting; a new change by an agent makes it false again.

## Tools

Responses are lean: identifier, title, status (name within the team) and `statusType` (triage, backlog, unstarted, started, completed, canceled), priority (word), team, and only when set: labels, project, estimate, due date, `snoozedUntil`, sprint, parent.

| Tool | Kind | Purpose | Key arguments |
|---|---|---|---|
| `search_issues` | read | Full text over title and description (search indexes). Descriptions only if title matches are not enough, and only their beginning (8000 characters, table `bodySearch`) | `q`, `team?`, `includeClosed?` (default true), `limit?` ≤ 50 |
| `list_issues` | read | Lists with filters, sorted by priority, then due date | `filter?`, `team?`, `status?[]`, `label?`, `project?`, `dueWithinDays?` (7), `snoozed?`, `limit?` ≤ 100 |
| `get_issue` | read | One issue with description (and its version), comments, relations, sub-issues, PRs, last 20 history entries | `identifier` (old identifiers work too) or `id` |
| `create_issues` | write | 1–50 issues in one transaction | `requestId`, `issues[]: { team, title, description?, status?, priority?, labels?, project?, estimate?, dueDate?, parent? }` |
| `update_issue` | write | Change fields of one issue | `identifier`, fields, `expected?`, `description` + `expectedDescriptionVersion`, `requestId?` |
| `set_status` | write | Status for 1–50 issues | `identifiers[]`, `status`, `requestId?` |
| `list_statuses` | read | Statuses per team in workflow order: name, type, key, default | `team?` |
| `list_inbox` | read | The owner's open inbox entries, newest first: issue brief, `kind` (`created`/`changed`/`snoozed`), `unread`, who created it, and the latest change per field (`field`, `to`, `by`, `at`). Agents cannot read or remove entries | `unreadOnly?`, `limit?` (default 50, max 100) |
| `move_issues` | write | Move 1–50 issues to another team (one transaction) | `identifiers[]` (old identifiers work too), `team`, `requestId?` |
| `add_comment` | write | Comment (Markdown) | `requestId`, `identifier`, `body` |
| `get_current_sprint` | read | Active sprint (otherwise the next planned one): goal, date range, points done/total, planned and added later | – |
| `list_teams` | read | Teams with key, name, dormant flag | `includeDormant?` (default true) |
| `list_projects` | read | Projects with team and state | `team?`, `includeClosed?` |
| `list_labels` | read | Labels with group (single choice?) and scope (workspace/team) | `team?` |
| `search_articles` | read | Full text over title and full text of knowledge pages; hits with the path of parent pages and a snippet | `q`, `team?`, `limit?` ≤ 50 |
| `list_articles` | read | Page tree of a team (without text) and its topics | `team`, `project?`, `topic?` |
| `get_article` | read | One page: Markdown with `version`, sources, topics, project, path, child pages, who changed it when | `id` |
| `create_article` | write | Create a page, optionally as a child page, with project, topics (unknown ones are created) and sources | `requestId`, `team`, `title`, `markdown?`, `parent?`, `project?`, `topics?[]`, `sources?[]` |
| `update_article` | write | Title, parent page, project, topics; replace the text (`markdown` + `expectedVersion`) or append to it (`append`); add sources | `requestId`, `id`, … |

**Images** appear in descriptions and comments as Markdown `![name](<site>/img/<token>)`. Agents can fetch the URL (no key needed) and reuse images from other texts by copying the line. There is no upload over MCP. Drive videos are plain links (`https://drive.google.com/file/d/<ID>/view`); the app shows them as a player when they stand alone on a line.

**Statuses:** Each team has its own statuses. Agents pass `status` either as the **name** of a status in the issue's team (case-insensitive, see `list_statuses`) or as the **key** of a status kind (`triage`, `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`, `duplicate`). With a key, the team's matching status applies, and an issue that already has a status of that kind stays where it is. `set_status` across several teams resolves per team. Unknown name → `invalid` with all valid names of the team. `list_issues` `status[]` accepts names, keys and types (`unstarted`, `started`, `completed` …). In the history (`recentHistory`), status changes appear as `field: "status"` with names.

**Strict order:** `list_statuses` shows `strictOrder`, the rules and the exceptions (names) per team. For a team with strict order, `get_issue` also returns `allowedStatuses` (names the issue may move to now). A disallowed change (including `create_issues` with a starting status outside triage, backlog or planned) fails with `invalid_transition: KIU-12: status "Todo" → "Done" is not allowed (team KIU requires the workflow order). Allowed: "In Progress", "Canceled", "Duplicate".` and `{ identifier, from, to, allowed }`. `set_status` over several issues then changes none of them (one transaction).

### Knowledge

Teams can have a knowledge area (`list_teams` → `wiki`: `"on"` alongside issues, `"only"` knowledge only, `null` none). The tools use the same operations as the UI (`ops/wiki.ts`, rules in [backend.md](backend.md#wiki-knowledge-base)).

- **Text:** `get_article` returns `markdown` and `version`. `update_article` replaces the text only with `expectedVersion`; if it doesn't match, the result is `conflict` and nothing is written. For knowledge that grows over time there is `append` without a version (adds a blank line before). Every change by an agent first saves the old text as a version, which the owner can restore.
- **Sources:** `{ url?, title?, author?, publishedAt? (YYYY, YYYY-MM, YYYY-MM-DD), accessedAt? (default today), note? }`, at least `url` or `title`.
- **Topics** are given by name (case-insensitive); the tool creates unknown ones in the team and lists them under `createdTopics`.
- **Deleting** is not possible over MCP (only the owner, in the UI).
- **Knowledge only:** Teams with `wiki: "only"` are left out of the `assigned` filter; `create_issues` and `move_issues` into them fail with `invalid` ("holds knowledge only").
- **References:** `get_issue` lists under `knowledge` the pages the issue links to or that mention it (`id`, `title`, `team`, `via`).

### `move_issues`: change team

A separate tool instead of a `team` field in `update_issue`: the move affects several issues at once, changes the identifier, and has consequences the agent should see in the result; `update_issue` stays a compare-and-set for one issue. Same operation as the UI (`moveIssuesToTeamCore` in `ops/move.ts`; rules in [backend.md](backend.md): new number in the target team, the old identifier stays as an alias, status mapped to the target team, project and team labels are dropped).

- **All or nothing:** An unknown identifier (`not_found`, names all missing ones) or an issue in the trash (`invalid`) fails the whole call; nothing is moved. Duplicate identifiers (including old and new identifier of the same issue) count once. The target team's strict order does not apply (same as in the UI).
- **Result:** `team`; per moved issue `previousIdentifier`, `identifier`, `status` and `previousStatus` (names in the respective team) and `removed: { project, labels }` (name of the dropped project or `null`, names of the dropped team labels); `unchanged` (identifiers already in the target team); `note` (the rules in one sentence); `warnings` (`dormant_team` if the target team is dormant). History: one `teamId` entry (shown in `get_issue` → `recentHistory` as old and new identifier), plus `projectId`, `stateId`, `labelIds` where applicable, with the agent as actor and the `requestId`.
- **Idempotency:** Like `set_status`: `requestId` is optional; with it, a retry returns the stored result (raw arguments, even if the identifiers have changed since). Without `requestId` a retry is harmless: the issues are already in the target team and are listed under `unchanged` with their new identifier. Old identifiers keep resolving in all tools (`get_issue` lists them under `previousIdentifiers`).
- Rate limit and permissions as for the other write tools.

### `list_issues` filters

All filters run over indexes, not over all issues. Deleted issues never appear. Filters are combined with AND.

| `filter` | Meaning | Index |
|---|---|---|
| (none) | all open issues (triage through in review) | `by_team_priority`, one priority at a time |
| `assigned` | open (backlog, todo, in progress, in review), not triage, team not dormant. There is a single user and no assignee field, so "assigned to me" means exactly this. | `by_team_priority` |
| `due` | open and due by today + `dueWithinDays`, overdue included | `by_status_due` (extended), open statuses only |
| `overdue` | open and due before today | `by_status_due` (extended), open statuses only |
| `in_progress` | in progress or in review | `by_team_priority` |
| `done_today` | completed today (calendar day in Europe/Berlin) | `by_status_completed` (extended) |
| `triage` | triage | `by_team_priority` |
| `sprint` | in the active sprint | `by_sprint` |
| `project` (argument) | issues of a project | `by_project` (extended) |

`team` and `status` without `filter` also run over `by_team_priority`, one priority at a time; reading stops after the priority level in which `limit` is exceeded. **Closed statuses** (`done`, `canceled`, `duplicate`) appear only if `status` names them, most recently changed first (`by_status`), and only as many are read as still fit into the response (`limit + 1`). `label` is checked afterwards (labels are a list and can't be indexed). **Hard read limit:** if a query reads 1000 issues (about 0.5 MB), it stops and returns `truncated: true` with a hint to narrow the filter. `more: true` means there are more matches than `limit`.

### Data read per call

Estimated with the test datasets (`backend/data/generate.ts`: `small` 440 issues, `large` 10,000) and a measured issue document of about 475 bytes. Every call also reads master data (teams, labels, projects, roughly 10 KB) and the counters (agent and two counter rows, under 1 KB). The numbers are the amount read from the database, not the response size.

| Call | Issues read (small / large) | Data read (large) |
|---|---|---|
| `list_issues` `filter: assigned`, `limit: 50` | 79 / 152 | about 80 KB |
| `list_issues` without filter or with `team` | 91 / 164–196 | 90–105 KB |
| `list_issues` `label: …` | 225 / 943 | up to 475 KB (limit 1000 issues) |
| `list_issues` `filter: overdue` / `due` | 7–13 / 123–211 | 70–110 KB |
| `list_issues` `status: [done]`, `limit: 50` | 51 | about 35 KB, independent of the number of completed issues (large: 3748) |
| `search_issues` `limit: 20` | up to 40 title matches, if needed up to 40 search texts | 20–120 KB |
| `get_issue` | 1 issue, description (average 1.9 KB, at most 200,000 characters), up to 101 comments, 20 history entries, relations | 15–30 KB typical |
| `get_current_sprint` | entries and issues of the sprint (up to 48) | about 35 KB |
| `list_teams`, `list_labels`, `list_projects` | – | 3–10 KB |

On the Convex free plan (1 GB database I/O per month) that is roughly 10,000 typical read calls of 100 KB each. Repeated identical calls with no change in between are served from the query cache and read nothing.

### `update_issue`: compare-and-set per field

- Only the fields passed change. `null` removes project, estimate, due date, snooze or parent.
- `snoozedUntil` (YYYY-MM-DD, after today in Europe/Berlin) snoozes an open issue: the owner's lists no longer show it, and on that day, in the morning, it returns to the inbox with a push notification. `null` unsnoozes. Moving the issue to done, canceled or duplicate ends the snooze (`changed` then includes `snoozedUntil`). `list_issues` and `get_issue` show `snoozedUntil`; `snoozed: true` lists only snoozed issues, `false` only the others (without it, snoozed issues are listed like any other).
- `expected` holds the values the agent last saw (labels as a set, case-insensitive). If a field has changed in the meantime, **that field is not written**; the others are. The result lists it under `conflicts` with expected and current value and a message.
- The description changes only with `expectedDescriptionVersion` (from `get_issue`). If the version doesn't match, `description` is listed under `conflicts` and nothing is overwritten.
- `changed` lists the fields that actually changed, `warnings` the priority budget warning.

### Priority budget warning

If a team ends up with more than 1 open urgent or more than 3 open high issues, the result of `create_issues` and `update_issue` contains a warning (`warnings[].code = 'budget_warning'`). The change is saved anyway.

### Priority is cleared on completion

When an issue moves to a status of kind completed or canceled (`done`, `canceled`, `duplicate`; the status kind decides, not the name), the backend sets its priority to "none". The rule lives in `applyPatch` and therefore applies to `set_status`, `update_issue` and `create_issues` with a closed status just as it does to the UI, the board, GitHub merges and sprint completion. A priority passed in the same call is ignored. Reopened issues stay at "none".

So that agents aren't surprised, the result names every removed priority in `warnings` (`create_issues`, `update_issue`, `set_status`; for `set_status` only when there is something to report):

```json
{"code":"priority_cleared","identifier":"KIU-106","priority":"high","message":"KIU-106 is now completed: its priority (high) was removed because only open issues carry a priority. Reopening the issue does not restore it; set it again if needed."}
```

`priority` is the value before removal (for `create_issues`, the requested one). `changed` of `update_issue` then includes `priority`, and `issue.priority` is `none`. The history records the change as a separate `priority` entry with the same actor (the agent) and the same `requestId` as the status change.

## Examples

Call (JSON-RPC over HTTP POST):

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_issues","arguments":{"filter":"assigned","team":"KIU","limit":5}}}
```

Response (shortened, `structuredContent`):

```json
{"count":2,"more":true,"issues":[
  {"identifier":"KIU-106","title":"Build search field","status":"In Progress","statusType":"started","priority":"high","team":"KIU","labels":["Feature"],"sprint":"Sprint 4"},
  {"identifier":"KIU-98","title":"Check import","status":"Todo","statusType":"unstarted","priority":"medium","team":"KIU","dueDate":"2026-10-12"}]}
```

Create with retry protection:

```json
{"name":"create_issues","arguments":{"requestId":"7f9c2e1a-0b4d-4c3e-9a51-2d6f0c8b1e77","issues":[
  {"team":"KIU","title":"Investigate webhook error","priority":"urgent","labels":["Bug"],"parent":"KIU-100"}]}}
```

```json
{"created":[{"identifier":"KIU-107","title":"Investigate webhook error","status":"Triage","statusType":"triage","priority":"urgent","team":"KIU","labels":["Bug"],"parent":"KIU-100"}],
 "warnings":[{"code":"budget_warning","team":"KIU","priority":"urgent","open":2,"budget":1,"message":"Priority budget exceeded: …"}]}
```

Change only if the status still matches:

```json
{"name":"update_issue","arguments":{"requestId":"b1d0…","identifier":"KIU-106","status":"in_review","expected":{"status":"in_progress"}}}
```

```json
{"identifier":"KIU-106","changed":["status"],"conflicts":[],"warnings":[],"issue":{"identifier":"KIU-106","status":"In Review", "…": "…"}}
```

If the owner has changed the status in the meantime:

```json
{"identifier":"KIU-106","changed":[],"conflicts":[{"field":"status","expected":"in_progress","actual":"Done"}],
 "message":"Not written because the value changed in the meantime: status (expected \"in_progress\", now \"Done\"). Read the issue again (get_issue) and decide.", "…": "…"}
```

## OAuth for connectors

claude.ai and ChatGPT only accept custom connectors with OAuth 2.1. XLR8 acts as its own authorization server, small and without a library. Sign-in goes through the web app's existing Clerk login.

**Why not Clerk as the authorization server?** Clerk can do it (DCR, CIMD, PKCE) but doesn't fit the requirements. Its access tokens are fixed at 1 day, refresh tokens never expire, and whether they rotate is not documented. Redirect URIs of clients registered via DCR can't be restricted to known hosts. Whether Clerk supports `resource` (RFC 8707) and `iss` (RFC 9207) is not documented, and ChatGPT needs `iss`. XLR8 would still have had to build revocation and listing per connector itself.

### Flow

1. The owner clicks "Connect connector" in **Settings → Agents**. XLR8 then accepts new connectors for 15 minutes ("armed", `opsStatus.oauthArmed`).
2. The owner enters the MCP URL in claude.ai or ChatGPT. The client calls `/mcp` without a token and gets `401` with `WWW-Authenticate`. It then loads the metadata and registers (`POST /oauth/register`, only while armed). Then it opens `GET /oauth/authorize` in the browser (PKCE S256, `resource`).
3. `/oauth/authorize` checks client, redirect URI, PKCE and `resource`. The endpoint then stores the request (`oauthRequests`) and redirects to `<XLR8_APP_URL>/oauth/consent?request=<id>`, the web app's consent page (via the Clerk login first if needed). The old path `/oauth/freigabe?anfrage=<id>` still works.
4. The consent page (`app/src/pages/OAuthConsent.svelte`, a separate lazily loaded chunk without the app shell) shows the app, the redirect host, the request's age and an editable name. The owner chooses Allow or Deny. The owner action `oauth.decide` creates the code and builds the redirect URL **on the server** from the stored redirect URI (`code` or `error`, `state`, `iss`). The page navigates there. The first approval disarms XLR8 again.
5. The client exchanges the code at `POST /oauth/token` (PKCE verifier, redirect URI, client). Only now is the connector created as a row in `agents` (`connector: { app, clientId }`, no key), together with an access token (1 hour) and a refresh token (30 days).
6. Tool calls work as with keys: rate limit per agent, actor `{kind: 'agent', agentId}`, the history shows the connector name.

### Endpoints

Only with `XLR8_APP_URL` set (otherwise `404`). The base is `XLR8_PUBLIC_SITE_URL`, else `CONVEX_SITE_URL`; never the address of the request. Code: `lib/oauth/http.ts`, pure checks in `lib/oauth/core.ts`, database in `ops/oauth.ts`.

| Path | Content |
|---|---|
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728: `resource` = `<base>/mcp` (exactly the URL you enter in claude.ai), `authorization_servers: [<base>]`, `scopes_supported: ["xlr8"]` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: `issuer` = `<base>`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: none, client_secret_basic, client_secret_post`, `authorization_response_iss_parameter_supported: true`, scopes `xlr8`, `offline_access`. No CIMD. Other `/.well-known/*` (e.g. `openid-configuration`) → 404 |
| `POST /oauth/register` | RFC 7591, only while armed. Redirect URIs only `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/<id>`; the app is derived from that alone. At most 20 unapproved clients (oldest are evicted), deleted after 1 hour |
| `GET /oauth/authorize` | Unknown client or wrong redirect URI → error page without redirect. After that, errors go to the client, always with `iss`. A new request from the same client replaces the open one. Requests are valid for 15 minutes |
| `POST /oauth/token` | `authorization_code` (code valid 5 minutes, single use; redeeming it twice revokes the connector) and `refresh_token` (rotation; a redeemed refresh token stays valid for 60 s, e.g. for retries or a second device; reuse after that revokes the connector). Form or JSON. Errors `invalid_grant`, `invalid_client` (401), `invalid_target`, `unsupported_grant_type` |
| `POST /oauth/revoke` | RFC 7009: revokes the token's connector (reason `client`, disconnected by the app), nothing else. Always 200 |

CORS `*` on metadata, `register`, `token`, `revoke` (with `OPTIONS`). There are no cookies, so this is harmless.

### Data

| Table | Content |
|---|---|
| `oauthClients` | `clientId` (`xlr8-<app>-…`), `app` (`claude`/`chatgpt`), `clientName`, `redirectUris`, `authMethod`, `secretHash?`, `approvedAt?` |
| `oauthRequests` | Sign-in request: `publicId` (in the consent page URL), client, redirect URI, `state`, `codeChallenge`, status `pending`/`approved`/`denied`/`redeemed`/`failed`; after approval `name`, `codeHash`, `codeExpiresAt`; after redemption `agentId` |
| `oauthTokens` | `hash`, `kind` (`access`/`refresh`), `agentId` (= the "family" of one sign-in), `clientId`, `expiresAt`, `rotatedAt?`. Redeemed refresh tokens are kept for a day so that reuse is detected |
| `agents` (fields `connector`, `revokedReason`) | One connector per connection; `keyHash`/`keyPrefix` are absent. Revocation reason `owner`, `code_reuse`, `refresh_reuse`, `client` |

Hourly cleanup (`crons.ts`, `oauth.cleanup`): expired tokens, requests one day after expiry, never-approved clients after one hour.

### Security

- **Owner only.** Approval goes only through `oauth.decide` (owner action behind Clerk and `XLR8_OWNER_IDS`). CSRF is ruled out because Convex authenticates with a JWT, not a cookie. Clickjacking is prevented by `X-Frame-Options: DENY` (Vercel). "Allow" becomes active only after one second and has no autofocus.
- **Arming against planted links.** An attacker could send the owner an authorize link from the attacker's own claude.ai or ChatGPT account. One click on "Allow" would give them access. Neither a warning nor a browser cookie prevents that. So registration and approval only work in the 15 minutes after "Connect connector", and the first approval disarms again. The consent page deliberately does not offer to arm. Side effect: without signing in, nobody can create anything that persists, so no IP limits are needed.
- **No open redirect.** Client and redirect URI are checked exactly before any redirect happens. The server builds the redirect URL from the stored URI; the consent page takes only the request ID from its URL.
- **Secrets.** Codes, access and refresh tokens and client secrets are 32 random bytes with a prefix (`xlr8_ac_`, `xlr8_at_`, `xlr8_rt_`, `xlr8_cs_`). They exist in plain text only in the HTTP action or in `oauth.decide`; the database stores SHA-256. The OAuth handlers log nothing. The hash comparison doesn't need constant time because it compares SHA-256 of a 256-bit secret.
- **Revocation.** Revoking in the settings (`agents.revoke`) sets `revokedAt` and deletes all of the connector's tokens. This takes effect immediately, including for refresh. A new connection creates a new agent; old ones remain as the source in the history.
- **Resource.** Access tokens are opaque and valid only for this one server; `resource` must match at authorize and token.

### Differences between claude.ai and ChatGPT

| | claude.ai (also desktop, mobile) | ChatGPT |
|---|---|---|
| Redirect | `https://claude.ai/api/mcp/auth_callback` (possibly `claude.com` in the future) | `https://chatgpt.com/connector_platform_oauth_redirect`, because XLR8 returns `iss` and `issuer` exactly matches the entry in `authorization_servers`; otherwise `…/connector/oauth/<id>` |
| Registration | DCR, creates a new client for every new connection. CIMD only if the server offers it (XLR8 doesn't) | DCR, once per connection |
| Starting sign-in | only HTTP `401` with `WWW-Authenticate` | same (whole server protected) |
| Scopes | from the 401 response (`xlr8`), plus `offline_access` | `xlr8` |
| Refresh | on 401 and up to 5 minutes before expiry; the token is shared between devices (hence the 60 s grace period) | not documented in detail |
| Tool annotations | recommended | `readOnlyHint`, `destructiveHint`, `openWorldHint` required (all set) |
| Mobile | create the connector on the web, then it works in the app too | create on the web |

Sources: MCP specification 2026-07-28 (Authorization), https://claude.com/docs/connectors/building/authentication, https://developers.openai.com/apps-sdk/build/auth.

### Custom MCP domain

The Convex site URL works as is, but a custom domain gives connectors a stable, readable address. The static host can forward all requests for a host (`mcpHosts` in the instance settings; `tooling/deploy-web.mjs` writes the rewrite into `deploy/web/vercel.json`) such as `mcp.xlr8.example.com` to the deployment's Convex site URL (`https://happy-otter-123.convex.site`). Set `XLR8_PUBLIC_SITE_URL` to that address so the OAuth metadata names it; the connector URL is then `https://mcp.xlr8.example.com/mcp`. Key-based agents can keep using the Convex URL; all addresses reach the same backend. Setup: [operations.md](../operations.md#custom-mcp-address).

**One address.** `XLR8_PUBLIC_SITE_URL` names exactly one address; issuer, `resource` and the `resource_metadata` in the 401 challenge always come from it, whichever host a request arrived through. The address is a connector's identity: if you change it, existing connectors must reconnect, because `resource` and `issuer` change. Access tokens, refresh tokens and clients are not bound to an address, so key-based agents and tokens keep working on the Convex URL as well.

## Tests

- `backend/test/mcp.test.ts` (convex-test via `t.fetch`): handshake, 401/405/404, every tool (`move_issues`: identifiers, dropped fields, status, alias, idempotency, trash, dormant team), all filters, compare-and-set, description with version, requestId, trash, revocation, rate limit, counting of failed calls.
- `backend/test/regressions.test.ts`: archived labels, read limits with 3100 completed issues, `read` as a query, retry with requestId after archiving or trashing, counting invalid calls.
- `backend/test/lib/mcp/endpoint.test.ts`: key format, order of count/read, 401 on revocation between authentication and call, separation of keys (401 without challenge) and access tokens (401 with `WWW-Authenticate`).
- `backend/test/lib/mcp/*`: protocol and argument validation without a database, plus the official MCP SDK client against a local test server.
- `backend/test/integration/mcp.mjs` (`pnpm --filter @xlr8/backend test:integration`): SDK client and `scripts/mcp-smoke.ts` against the real local endpoint.
- OAuth: `backend/test/lib/oauth.test.ts` (metadata, redirect allowlist with attack cases, authorize checks, PKCE, client authentication), `backend/test/oauth.test.ts` (full flow via `t.fetch`, rotation and grace period, code reuse, expiry after one hour, revocation, denial, not armed, cleanup), `backend/test/integration/oauth.mjs` (official SDK client signs in like claude.ai: DCR, PKCE, `resource`, `iss`, refresh with `auth()`, revocation) and `e2e/tests/oauth.spec.ts` (consent page in the browser, redirect to claude.ai intercepted, revoking the connector in the settings).

Setting up Claude Code and Codex, and connectors in claude.ai and ChatGPT: [operations.md](../operations.md).
