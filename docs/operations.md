# Operations

Running an XLR8 instance in production: configuration, deploys, integrations and troubleshooting. To
set up a new instance from scratch, start with [self-hosting.md](self-hosting.md). Backups:
[backup.md](backup.md).

The examples use the placeholders `xlr8.example.com` (app), `mcp.xlr8.example.com` (optional custom MCP
address), `clerk.xlr8.example.com` (Clerk) and `happy-otter-123` (Convex production deployment).

## What runs where

| Part | Production | Local development |
|---|---|---|
| App (static SPA) | static host, e.g. Vercel: `https://xlr8.example.com` | `http://127.0.0.1:5412` |
| Backend (database and functions) | Convex Cloud: `https://happy-otter-123.convex.cloud` | local Convex, `http://127.0.0.1:13410` |
| HTTP endpoints (MCP, GitHub, health) | `https://happy-otter-123.convex.site`, optionally also a custom address such as `https://mcp.xlr8.example.com` | `http://127.0.0.1:13411` |
| Landing page | `https://xlr8.example.com/` for visitors who are not signed in (`welcome.html`) | `http://127.0.0.1:5412/welcome` |
| Sign-in | Clerk production instance, embedded form at `https://xlr8.example.com/sign-in`; only the user ids in `XLR8_OWNER_IDS` get in | local test sign-in (`tooling/dev-auth.mjs`), no account needed |
| Backup | nightly GitHub Actions workflow ([backup.md](backup.md)) | – |

Start locally: `pnpm dev` (same as `node tooling/local.mjs --seed small --app dev`). Stop with Ctrl+C.

## Instance settings

The deploy tools (`tooling/deploy-web.mjs`, `tooling/cloud.mjs`, `tooling/vapid.mjs`, the Linear import with
`--prod`) read the non-secret settings of your instance from `deploy/instance.json` (gitignored; copy
`deploy/instance.example.json`) or, if that file does not exist, from `~/.config/xlr8/instance.json` (handy
with several worktrees). Every field can be overridden by an environment variable (`tooling/instance.mjs`):

| Field | Env override | Example | Used for |
|---|---|---|---|
| `convexDeployment` | `XLR8_CONVEX_DEPLOYMENT` | `happy-otter-123` | Convex URLs baked into the build; deploy key check |
| `appUrl` | `XLR8_APP_URL` | `https://xlr8.example.com` | absolute URLs in the build (`XLR8_PUBLIC_URL`, og tags), redirect target for `redirectHosts`, default VAPID subject |
| `clerkPublishableKey` | `XLR8_CLERK_PUBLISHABLE_KEY` | `pk_live_…`, or `host=pk_live_…,host2=pk_live_…` | Clerk in the browser |
| `vercelProject` | `XLR8_VERCEL_PROJECT` | `xlr8` | `vercel link` |
| `vercelScope` | `XLR8_VERCEL_SCOPE` | your Vercel team slug | `vercel link` / `vercel deploy` |
| `mcpHosts` | `XLR8_MCP_HOSTS` | `["mcp.xlr8.example.com"]` | hosts forwarded to Convex (custom MCP address) |
| `redirectHosts` | `XLR8_REDIRECT_HOSTS` | `["old.example.org"]` | old domains redirected to `appUrl` |
| `branchPrefix` | `VITE_XLR8_BRANCH_PREFIX` | `jane` | optional prefix of suggested Git branch names |

Nothing in this file is secret: these values end up in the browser or in public DNS anyway. Secrets
(deploy keys, tokens) never go into it.

## Deploying

- **Backend:** `node tooling/cloud.mjs deploy`. `tooling/cloud.mjs` runs the Convex CLI against
  production with the deploy key from `~/.config/xlr8/convex-deploy-key` (must be mode 600; another path via
  `XLR8_CONVEX_DEPLOY_KEY_FILE`). It refuses a
  key that belongs to a different deployment than `convexDeployment`, runs the CLI with its own `HOME`
  (so it never sees other Convex logins) and never prints the key. Any Convex CLI command works:
  `node tooling/cloud.mjs env list`, `node tooling/cloud.mjs run <function> '<json>'`.
  Plain `npx convex deploy` in `backend/` with `CONVEX_DEPLOY_KEY` set works too.
- **Web app:** `node tooling/deploy-web.mjs` builds the app with the production values, checks the
  bundle, copies it to `deploy/web/` and deploys that folder to Vercel as a static site (no build on
  Vercel). `--build` only builds. The checks abort the deploy if the bundle contains a local test token,
  a local Convex address, lacks the production Convex URL, lacks `welcome.html`, or if the landing page's
  entry imports app or Clerk chunks. The app's `index.html` is renamed to `app.html`, see
  [Landing page and sign-in](#landing-page-and-sign-in).

Deploy the backend first when a change touches both: the old app keeps working against a newer backend,
not necessarily the other way round.

### Build-time variables of the app

| Variable | Meaning |
|---|---|
| `VITE_CONVEX_URL` | `https://<deployment>.convex.cloud` |
| `VITE_CONVEX_SITE_URL` | `https://<deployment>.convex.site`; the address shown for MCP in the settings (falls back to one derived from `VITE_CONVEX_URL`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key, or a list `host=key,host=key` (one key per app domain, see [Changing the domain](#changing-the-domain)) |
| `VITE_XLR8_BRANCH_PREFIX` | optional prefix for suggested Git branch names (from `branchPrefix`): `jane` gives `jane/acme-106-title`; without it `acme-106-title` |
| `XLR8_PUBLIC_URL` | public app URL for absolute URLs in `index.html` and `welcome.html` (og tags); read at build time only (from `appUrl`) |
| `XLR8_BUILD_ID` | optional build id for `/version.json` (default: random) |

`VITE_DEV_TOKEN` and `VITE_XLR8_TEST` are for local development and tests only; `deploy-web.mjs` clears them.

## HTTP endpoints

Served by Convex under `https://<deployment>.convex.site` (and any custom MCP address):

| Path | Purpose |
|---|---|
| `/mcp` | agents with a key (Claude Code, Codex, …) and connectors (claude.ai, ChatGPT) |
| `/oauth/…`, `/.well-known/oauth-…` | OAuth for connectors (only with `XLR8_APP_URL`) |
| `/github` | GitHub webhook: pull requests, comments, reviews, checks |
| `/ghmedia/<key>/<n>` | images and videos from PR descriptions of private repos (redirect to a fresh GitHub URL) |
| `/health` | backend status without data, e.g. `{"ok":true,…}` |
| `/img/<token>` | images from descriptions and comments |
| `/logo/<id>` | team logos |

## Landing page and sign-in

Visitors who are not signed in see the landing page at `/`. Signed in, `/` opens the app directly. Deep
links like `/issue/ACME-106` work either way: without a session they lead to sign-in and back. Sign-in
happens at `/sign-in` with the embedded Clerk form, not on Clerk's hosted pages.

How the static host knows "signed in": the cookie `xlr8_signed_in`. The app sets it after sign-in and
deletes it on sign-out. It is not a secret and unlocks nothing; it only decides whether `/` serves the
landing page or the app. If you see the landing page although you are signed in (for example on the
first visit after a deploy), click "Sign in": Clerk recognizes the session and sends you to the app.

`deploy-web.mjs` writes `deploy/web/vercel.json` at build time: the generic rules from
`deploy/vercel.base.json`, with redirect rules for `redirectHosts` and rewrite rules for `mcpHosts` in front.
The resulting rules, in order:

1. Hosts in `redirectHosts` redirect (307, temporary) to the same path on `appUrl`.
2. Hosts in `mcpHosts` are proxied to `https://<deployment>.convex.site/<path>` (see
   [Custom MCP address](#custom-mcp-address)).
3. `/` without the cookie `xlr8_signed_in` serves `/welcome.html`.
4. `/sign-in` serves `/welcome.html` (the landing page script shows the sign-in view).
5. Every other path except `/assets/…` serves `/app.html` (SPA fallback).

The app is deployed as `app.html` rather than `index.html` because Vercel always serves an `index.html`
at `/` before applying rewrites, which would bypass rule 3. Headers: `/assets/*` is immutable for a year;
`/`, `app.html`, `welcome.html`, `sw.js`, `version.json` and `site.webmanifest` are `no-cache` (`/` also
`Vary: Cookie`); all responses get `nosniff`, `X-Frame-Options: DENY`, HSTS, a strict referrer policy and a
permissions policy without camera, microphone and geolocation.

### Clerk settings

The embedded form works without changes in the Clerk dashboard. So that Clerk's own links point to it
and nobody can register:

1. https://dashboard.clerk.com → your application → **Production**.
2. **Configure → Developers → Paths**:
   - **`<SignIn />`**: "Sign-in page on application domain" → `https://xlr8.example.com/sign-in`.
   - **Signing out**: "Page on application domain" → `https://xlr8.example.com/`.
   - Leave `<SignUp />` as is. Save.
3. **Configure → Restrictions → Sign-up mode** → **Restricted**. Only the ids in `XLR8_OWNER_IDS` get
   into XLR8 anyway; this keeps strangers from creating Clerk accounts at all.
4. Check in a private window: `https://xlr8.example.com/` shows the landing page. "Sign in" → sign in →
   you land in the app. Open `https://xlr8.example.com/` again: the app opens directly.

The "Secured by Clerk" badge below the form is only removable on paid Clerk plans.

### Changing the domain

The app picks the Clerk publishable key by host (`VITE_CLERK_PUBLISHABLE_KEY` as a list
`host=key,…`, `app/src/publishableKey.ts`), and `CLERK_JWT_ISSUER_DOMAIN` accepts several issuers. This
lets old and new domains run side by side while Clerk moves:

1. Deploy the app with keys for both hosts and the backend with both issuers (and both issuers' entries
   in `XLR8_OWNER_IDS`). Redeploy the backend after changing `CLERK_JWT_ISSUER_DOMAIN`: `auth.config.ts` is
   evaluated when functions are pushed, not on every request.
2. In the Clerk dashboard: Domains → Configure → Danger zone → "Change domain" (for a subdomain such as
   `xlr8.example.com` choose "Secondary application"; Clerk then lives at `clerk.<subdomain>`). Add the
   new DNS records Clerk shows.
3. Point the old domain at the new one (`redirectHosts`) and remove the old key and issuer.

Expect to sign in again afterwards.

## Backend environment variables

Set in the Convex dashboard (Settings → Environment Variables) or with
`node tooling/cloud.mjs env set NAME value`. They are neither in the code nor in the backup: **keep every
production value in a password manager.**

| Name | Meaning | Production value |
|---|---|---|
| `CLERK_JWT_ISSUER_DOMAIN` | Clerk issuer (Frontend API URL) whose tokens Convex accepts; several separated by commas (only while changing the domain). `none` disables Clerk. **Redeploy the backend after changing it** | `https://clerk.xlr8.example.com` |
| `XLR8_OWNER_IDS` | who gets in: comma-separated `tokenIdentifier`s, each `<Clerk issuer>\|<Clerk user id>`. Empty: nobody | `https://clerk.xlr8.example.com\|user_…`. **When the Clerk domain changes, change the issuer here too**, otherwise the app stays empty after sign-in |
| `XLR8_DEV_JWKS` | public key of the local test sign-in. Must be set (the CLI requires it); `none` disables it | **`none`** |
| `XLR8_APP_URL` | address of the app (hosts the OAuth consent page); turns on connectors (OAuth). Unset: no connectors | `https://xlr8.example.com` |
| `XLR8_PUBLIC_SITE_URL` | optional custom address for MCP and OAuth instead of `…convex.site` (issuer and `resource` for connectors). One address | `https://mcp.xlr8.example.com` |
| `XLR8_OWNER_NAME` | the owner's display name in MCP output (e.g. who wrote a comment). Default `Owner` | e.g. `Jane` |
| `XLR8_LOCALE` | `de`: push notification texts in German, and new teams get German default status names. Default English | unset or `de` |
| `GITHUB_WEBHOOK_SECRET` | verifies that webhook deliveries come from GitHub | long random value |
| `GITHUB_WEBHOOK_SECRET_PREVIOUS` | only while rotating the secret (below) | usually unset |
| `GITHUB_TOKEN` | GitHub API access for the PR view (description, checks, comments, merging) and for managing webhooks. Unset: XLR8 shows only title and state from the webhook | fine-grained personal access token, see [GitHub](#github) |
| `GITHUB_MANAGE_WEBHOOKS` | `1`: XLR8 creates missing webhooks in the token's repos and fixes their events (daily and via a button in Settings → GitHub). Unset: only checks and reports. Never acts on a local backend, and only with `GITHUB_WEBHOOK_SECRET` | `1` |
| `GITHUB_REPOS` | optional: manage only these repos, `owner/name` or `owner/*`, comma-separated. Unset: all repos the token owns | usually unset |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | key pair for Web Push. Unset: no push notifications | set only with `node tooling/vapid.mjs`. No need to keep them: if lost, generate new ones |
| `VAPID_SUBJECT` | contact for push services (`https:` or `mailto:`). Unset: `XLR8_APP_URL` is used; with keys but neither set, sending fails | set by `tooling/vapid.mjs` |
| `XLR8_ALLOW_SEED`, `XLR8_TEST_SWITCHES` | sample data and test switches for local development | **never set in production** |

### Health check

Before and after every production deploy, open `https://<deployment>.convex.site/health`. It must show
`"devAuth": false` and `"local": false`. The local test sign-in only works on a local backend anyway
(Convex reports its address in `CONVEX_CLOUD_URL`; if it does not point to `127.0.0.1` or `localhost`,
the backend rejects such tokens). If `"devAuthConfigured": true` shows up, `XLR8_DEV_JWKS` is still set:
change it to `none`. Further fields: `clerk`, `oauth` (connectors on), `push` (VAPID keys set),
`testSwitches`.

## Installable app and push notifications

XLR8 is an installable PWA with Web Push. Design: [architecture/frontend.md](architecture/frontend.md) and
[architecture/backend.md](architecture/backend.md).

### Push keys (once)

```sh
node tooling/vapid.mjs            # production (through tooling/cloud.mjs)
node tooling/vapid.mjs --local    # local backend (backend/)
```

The script generates a P-256 key pair and stores `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and
`VAPID_PUBLIC_KEY` directly in the Convex environment. The private key never appears in the terminal; it
goes to the Convex CLI through stdin. If keys exist, the script changes nothing; `--force` replaces them,
and every device re-subscribes the next time it opens XLR8. `/health` shows `"push": true` once both keys
are set. The subject defaults to `appUrl` from the instance settings; `--subject <https: or mailto: URL>`
overrides it.

### On a phone (Android, Chrome)

1. Open the app in Chrome and sign in. Menu ⋮ → "Install app" (or "Add to home screen"). XLR8 then starts
   full screen from the home screen.
2. In the app: Settings → Notifications → turn on notifications on this device and allow them.
3. Send a test notification. It arrives right away; tapping it opens XLR8.
4. Sharing: "Share" → XLR8 in another app creates an issue in triage (last used team), with undo.

On desktop (Chrome, Edge, Firefox) the same; installing is optional.

### When a notification is sent

- Which events trigger one is set under Settings → Notifications (for all devices). Morning notifications
  (due today, sprint ending) arrive at 08:00 Europe/Berlin.
- If XLR8 is visibly open and in use on any device (input in the last 3 minutes), no push goes out; the
  app shows an in-app notice with a sound instead. If no app acknowledges the notice within 45 s (window
  just closed), the push is sent after all.
- Several events at once arrive as one notification. The same event never arrives twice (unique key in
  `pushEvents`).

### When no notification arrives

1. Settings → Notifications: "not set up on the server" means the VAPID keys are missing. "Blocked in the
   browser": allow notifications in the browser's site settings or the Android app settings.
2. Under devices, each device shows when it was last notified and the number of failures (error text on
   hover). If the push service reports a subscription as expired (404/410), the backend removes it and
   the device re-subscribes on its next start.
3. Convex logs: function `push:deliver`. The table `pushEvents` holds the last 7 days (`state`: `sent`,
   `in_app`, `skipped`).

### New versions and offline

After a deploy, the app notices the new version via `/version.json` when you return to it (at most every
10 minutes) and reloads if nothing unsaved is open; otherwise it offers a reload. If a chunk of the old
version is missing after a deploy, the app reloads once. The service worker only handles push and serves
no pages, so no stale version can get stuck; the browser picks up a new `/sw.js` on the next start.

Offline with the app open, an "Offline" indicator appears (phone: above the bottom bar, desktop: in the
sidebar); changes wait and go out once the network is back. Opening XLR8 without network shows the
browser's own offline page; an offline page of our own would slow down every start.

## Agents over MCP

Each agent gets its own key. The history then shows who changed what, and you can revoke one agent at a
time. Protocol and tools: [architecture/mcp.md](architecture/mcp.md).

### Create a key

1. In the app: **Settings → Agents**, create a key and give it a name (e.g. "Claude Code").
2. The key (`xlr8_…`) is shown **exactly once**. Copy it into your password manager right away. XLR8 only
   stores a hash and cannot show it again.
3. Lost it? Create a new one and revoke the old one.

### Claude Code

```sh
claude mcp add --transport http xlr8 <address>/mcp --header "Authorization: Bearer <key>"
```

`<address>` is `https://<deployment>.convex.site` or your custom MCP address; locally
`http://127.0.0.1:13411`. With `--scope user` the entry applies to all projects. Check with `/mcp` in
Claude Code: "xlr8" should show as connected.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.xlr8]
url = "<address>/mcp"
bearer_token_env_var = "XLR8_MCP_KEY"
```

and provide the key as the environment variable `XLR8_MCP_KEY`. The exact syntax depends on the Codex
version; `codex mcp --help` shows it.

### Test by hand

```sh
XLR8_MCP_KEY=xlr8_… node backend/scripts/mcp-smoke.ts --url <address>/mcp
```

Prints server name, protocol, the tools and the result of one read call. Never pass the key as an
argument, or it shows up in the process list.

### Revoke a key

**Settings → Agents → Revoke.** From the next call on the agent gets `401`, without a hint to try OAuth.
Revoked keys cannot be restored; create a new key for the same agent.

### Limits

- Per agent (and per connector) at most **120 calls per minute and 5000 per day**. Above that the agent
  gets an error with the waiting time. Failed calls (wrong arguments, unknown tool) count too.
- A tool call costs 3 (write) or 4 (read: count, then a cacheable query) Convex function calls. 5000 calls
  a day are at most 20,000 function calls, well inside the Convex free plan. Data read per call:
  [architecture/mcp.md](architecture/mcp.md).
- The ops page (Settings → Ops) shows each agent's calls today and when it was last seen.

## Connectors in claude.ai and ChatGPT

Claude (web, desktop, mobile) and ChatGPT connect as a **connector** with OAuth instead of a key. Each
connection shows up under **Settings → Agents** as its own entry ("Connector · claude.ai" or
"Connector · ChatGPT"), can be revoked on its own, and its changes carry its name in the history.

### Turn on

```sh
node tooling/cloud.mjs env set XLR8_APP_URL https://xlr8.example.com
node tooling/cloud.mjs env set XLR8_PUBLIC_SITE_URL https://mcp.xlr8.example.com   # optional
```

`/health` then shows `"oauth": true`. Without `XLR8_APP_URL` there are no connectors and the OAuth
endpoints return 404.

### Custom MCP address

By default connectors use `https://<deployment>.convex.site/mcp`. A custom address such as
`https://mcp.xlr8.example.com/mcp` is optional and works through the static host: add the host to
`mcpHosts`, point its DNS (CNAME) at the static host, and set `XLR8_PUBLIC_SITE_URL` to that one
address. The host rewrite forwards every request to Convex. Only the consent page lives under
`XLR8_APP_URL`.

The address is a connector's identity: if you change `XLR8_PUBLIC_SITE_URL`, the issuer changes and
existing connectors must be reconnected.

Agents with a key can use either the Convex address or the custom one.

Check: `https://mcp.xlr8.example.com/.well-known/oauth-protected-resource/mcp` shows
`"resource":"https://mcp.xlr8.example.com/mcp"`, and
`https://mcp.xlr8.example.com/.well-known/oauth-authorization-server` shows
`"issuer":"https://mcp.xlr8.example.com"`.

### Connect

1. In XLR8: **Settings → Agents → connect a connector**. For the next 15 minutes XLR8 accepts new
   connectors; the card shows the address to copy and a countdown. Without this step XLR8 rejects every
   new connection, which protects you from consent links someone else started.
2. **claude.ai** (in the browser): Settings → Connectors → "Add custom connector". Name "XLR8", URL from
   step 1. Leave registration on automatic; client id and secret stay empty. Add, then "Connect".
   **ChatGPT** (in the browser): Settings → Apps (or Connectors) → Advanced → turn on developer mode if
   asked. Then create a custom MCP server: name "XLR8", URL as above, authentication "OAuth", confirm
   that you trust the application.
3. A window opens with the XLR8 sign-in (if needed) and the **consent page**. Check the details: the app
   and the return address (claude.ai or chatgpt.com). Adjust the name (it appears in the history) and
   click **Allow**. The window returns to the app and the tools appear.
4. XLR8 stops accepting new connectors again. For another connection, start step 1 again.

On mobile the connector appears automatically once it is connected on the web.

### Revoke and reconnect

- **Settings → Agents → Revoke** on the connector: the app loses access immediately. To use it again,
  disconnect and reconnect it in the client (after step 1 above). That creates a new entry; the old one
  stays revoked as the source in the history.
- If the client disconnects by itself, the entry shows it as revoked by the app.
- Revoked because a refresh token or authorization code was used twice: XLR8 detected possible theft
  and revoked the connector as a precaution. Reconnect.
- Sessions renew themselves: access tokens are valid for 1 hour and are refreshed by the client; a
  connection lasts 30 days from its last use.

## GitHub

The webhook links pull requests to issues and closes issues when a PR is merged.

**Rules:**

- An identifier like `ACME-106` in the **branch name** links the PR and closes the issue on merge
  (e.g. `acme-106-fix-login` or `jane/acme-106-fix-login`).
- `Fixes ACME-106`, `closes`, `resolves` (and variants, also lists like "Fixes ACME-1, ACME-2") in the
  title or body close on merge.
- An identifier only in the title or body links but does not close. Identifiers in code blocks don't count.
- Old identifiers (after an issue moved teams) work too.
- Links are never removed automatically. Canceled, duplicate and already completed issues are never touched.
- Each delivery takes effect exactly once, even if GitHub retries it. The history shows "GitHub" as the source.

### Pull requests in XLR8

An issue lists its PRs with state, checks, review and comments. Clicking one opens the PR next to the
issue; the expand button opens it full size (`/pr/<owner>/<repo>/<n>`), Esc closes. Inside: description
with images and videos, checks with log links, comments and reviews (bots included), merge (method
selectable, delete branch), close and reopen, comment. Comments and merges appear on GitHub under the
token's account. The code diff is only on GitHub (link to the changed files).

- **Data source:** the webhook reports every change; XLR8 then fetches the current state through the
  GitHub API (`GITHUB_TOKEN`), and again on opening if it is older than 30 s. Without a token XLR8 shows
  only title and state.
- **Which PRs:** every PR a webhook delivery arrived for, i.e. from every repo with the webhook. An issue
  shows the linked ones (identifier in branch, title or body).
- **Settings → GitHub** shows the account, the repos and whether the webhook is installed everywhere.
  Daily at 03:30 UTC XLR8 installs it in new repos itself (with `GITHUB_MANAGE_WEBHOOKS=1`); that needs the
  token permission **Webhooks (read and write)**. Without it the page says so, and new repos need the
  webhook by hand (below).
- **Images and videos from private repos** go through `/ghmedia/…`: XLR8 redirects to a fresh,
  short-lived GitHub URL; the files themselves never pass through Convex. Like `/img/…`, anyone with the
  address can see the file, but only people who can see the PR in XLR8 know it.

### The token

A fine-grained personal access token for all repos whose PRs XLR8 should show. Permissions:

- Pull requests: read and write
- Contents: read and write
- Issues: read and write
- Webhooks: read and write
- Commit statuses: read
- Actions: read
- Metadata: read

Fine-grained tokens have no "Checks" permission; check runs of other apps arrive through the webhook.
Set it without putting it on the command line, e.g.
`node tooling/cloud.mjs env set GITHUB_TOKEN < ~/.config/xlr8/github-token`. Tokens expire (at most after a
year); GitHub emails before that. Renew with the same permissions.

### Add the webhook by hand (per repo)

1. Create a secret: `openssl rand -hex 32`. Store it in the password manager.
2. Set it in the backend as `GITHUB_WEBHOOK_SECRET`.
3. In GitHub: repo → **Settings → Webhooks → Add webhook**
   - Payload URL: `https://<deployment>.convex.site/github`
   - Content type: `application/json`
   - Secret: the same value
   - "Let me select individual events" → **Pull requests**, **Issue comments**, **Pull request reviews**,
     **Pull request review comments**, **Pull request review threads**, **Check runs**, **Check suites**,
     **Statuses**, **Workflow runs**
   - Active, save.
4. GitHub sends a "ping" right away. Under **Recent Deliveries** it must show **200**.
5. Use the same secret for all repos.

### Rotate the secret

Without losing deliveries:

1. Create a new secret.
2. In the backend: copy the old secret to `GITHUB_WEBHOOK_SECRET_PREVIOUS`, set the new one as
   `GITHUB_WEBHOOK_SECRET`. Both are valid now.
3. Enter the new secret in every repo (Settings → Webhooks). The daily sync (`GITHUB_MANAGE_WEBHOOKS=1`)
   does not do this: it only fixes events and the active flag of existing webhooks; only webhooks it
   creates get the current secret.
4. When all repos are switched: delete `GITHUB_WEBHOOK_SECRET_PREVIOUS`.
5. Update the password manager.

## Importing from Linear

The importer only reads from Linear: it technically allows only read queries and logs every request.
Format, rules and what changes: [architecture/import.md](architecture/import.md).

1. Once: create a Linear API key (read access is enough) and save it as `~/.config/xlr8/linear-api-key`
   (mode 600).
2. Fetch: `node tooling/linear-import/index.ts fetch`. The snapshot lands outside the repo in
   `~/.local/share/xlr8/import/<timestamp>/`. The console shows only counts and identifiers.
3. Import: `node tooling/linear-import/index.ts push ~/.local/share/xlr8/import/<timestamp>` (local
   backend) or with `--prod` (production, through `tooling/cloud.mjs`). The script shows target and size
   and asks you to type a confirmation word; in production it always asks (`--yes` is not accepted).
   Then it uploads, processes and reports per kind: read, new, changed, unchanged, skipped, plus
   deviations and conflicts.

Running `push` again with the same data creates no duplicates; everything is then "unchanged". A later
import with fresh data merges field by field (see [architecture/import.md](architecture/import.md)).

**If an import fails:** the script reports the error and the run shows as failed on the ops page.
Processed data stays, the uploaded data stays too. Just run `push` again: existing records are recognized.
A run consists of many small steps the backend schedules one after another; `push` waits for the last
one. A run without progress for 15 minutes (e.g. because the backend restarted) is marked failed: at the
latest after an hour, immediately on the next `push`. Only one run can be active at a time.

<a id="inbox-entries-migration"></a>

**Inbox entries (migration):** the inbox has its own table now. Before the first use after the deploy,
create the entries for what is in the inbox today (issues without `reviewedAt`, with their read marker):

```sh
node tooling/cloud.mjs run migrations:inboxBackfill                  # count only: missing = entries to create
node tooling/cloud.mjs run migrations:inboxBackfill '{"apply":true}' # create them
node tooling/cloud.mjs run migrations:inboxBackfill                  # again: missing must be 0
```

The issues are not changed. Safe to rerun and to run while the app is in use: an issue that already has
an entry is skipped, and after the last page a note makes further runs do nothing (so entries you removed
since never come back; `{"apply":true,"force":true}` ignores the note). It reschedules itself above 500
issues; wait until no scheduled follow-up pages remain, then run the count again.

**Priorities of closed issues:** in XLR8 completing an issue clears its priority. Imported issues that
were already closed keep theirs until you run:

```sh
node tooling/cloud.mjs run migrations:priorityClearClosed                  # count only (status type/priority → count)
node tooling/cloud.mjs run migrations:priorityClearClosed '{"apply":true}' # clear
```

It sets the priority to none, updates `updatedAt` and writes a `priority` history entry with actor
"System". Includes the trash, can run repeatedly, and reschedules itself above 500 issues (without
`apply` it returns a `cursor` for the next call).

## Images and videos

**Images** go into descriptions and comments by pasting (Ctrl+V), dragging a file in or the image button.
PNG, JPEG, WebP and GIF up to 5 MB. The browser shrinks large images first (longest side 2560 px, as
WebP); phone photos lose their camera metadata (location, device) on the way.

- **Who can see images:** every image has an address with a long random token (`…/img/<token>`). It
  cannot be guessed, but anyone who has it sees the image without signing in. Images in the browser
  cannot send a bearer token, so there is no good alternative. Don't share image addresses of private
  images.
- **Cleanup:** an image stays as long as any text references it, even if copied into several issues.
  Removed from the last text, it is deleted after one day (undo works until then). An uploaded but never
  saved image (e.g. in a draft) is deleted after 7 days. A permanently deleted issue (trash after 30 days)
  takes its images along. The nightly file sweep runs at 03:00 UTC.
- **Cost:** the Convex free plan has 1 GB file storage and 1 GB bandwidth per month. A shrunk screenshot
  is usually 50–400 KB, so several thousand fit. The ops page shows storage with a traffic light (yellow
  from 70 %, red from 90 %). Bandwidth is only in the Convex dashboard (Usage). Images are cached in the
  browser for a year.
- **Agents** see images as Markdown links in descriptions and comments. They cannot upload.

**Videos** are not stored in XLR8 (1 GB is too little) but in Google Drive. A Drive link
(`https://drive.google.com/file/d/<ID>/…`) alone on a line renders as a player that loads when scrolled
into view, with "Open in Drive" below it. Links inside a sentence stay links.

| Sharing setting in Drive | Result in the player |
|---|---|
| "Anyone with the link" | plays |
| "Restricted", not signed in to Google | Drive asks to sign in; "Open in Drive" below |
| file does not exist | Drive says the file does not exist |
| "Restricted", signed in to Google in the browser | depends on third-party cookies: expected to play in Chrome and Edge; Firefox, Safari and Brave block the embedded frame, so only "Open in Drive" helps |

Recommendation: share videos for XLR8 as "Anyone with the link"; such a link is as hard to guess as an
image address. A thumbnail fallback does not help, because Drive's thumbnail URL also redirects to
Google sign-in for restricted files.

## Ops page

Settings → Ops shows: last backup, last import (counts, deviations, conflicts), agents with today's
calls, last GitHub delivery, the result of the nightly sprint audit and file storage (images and logos,
out of 1 GB). The backup workflow reports itself there after each successful run. If the sprint audit
itself fails, it shows `ok: false` with `error`.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Agent reports `401` / not signed in | key wrong, revoked, or whitespace when copying | create a new key, replace it in the agent |
| Agent reports `rate_limited` | more than 120 calls per minute | wait (the error says how long); if frequent, check whether the agent is looping |
| Agent reports a `requestId` reused with different arguments | the agent reused a request id | the agent must use a fresh `requestId` per new action |
| GitHub Recent Deliveries shows **401** | secret differs between GitHub and backend | set the secret in both again, then "Redeliver" |
| GitHub shows **500** or a timeout | backend problem | Convex dashboard → Logs, then "Redeliver" in GitHub; duplicates have no effect |
| A merged PR does not close the issue | identifier only in title/body without "Fixes", issue canceled/duplicate, or the PR was merged before (import or redelivery) | intended: only the first merge closes. Complete the issue by hand or add "Fixes ACME-…" to the PR body |
| App stays empty or shows "No access" after sign-in | your `tokenIdentifier` is not in `XLR8_OWNER_IDS` (often the issuer part after a Clerk domain change) | fix `XLR8_OWNER_IDS` |
| `/health` does not answer | backend not running (locally: not started) | locally `pnpm dev`; in the cloud check Convex status |
| Import fails | see [Importing from Linear](#importing-from-linear) | run `push` again |
| App says the server rejects changes | a test switch is on (local only) | turn the test switch off |
| Image not uploaded | not an image (SVG, PDF), larger than 5 MB after shrinking, or no connection | the notice says why; on connection errors retry |
| Drive player says the file does not exist or asks to sign in | video is "Restricted" and the embedded frame sends no Google session | use "Open in Drive" or share as "Anyone with the link" |

## Checks

| Command | What |
|---|---|
| `pnpm --filter @xlr8/backend test` | all backend unit tests (no running backend needed) |
| `pnpm --filter @xlr8/backend test:integration` | starts a fresh local backend on port 13490, tests import (twice), MCP with the official client, logo delivery, `/health` and concurrency, stops it again |
| `node tooling/concurrency-test.mjs --port 13480 --report <file>` | full concurrency test with a report against a running local backend |
