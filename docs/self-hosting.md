# Self-hosting

From zero to a running Selfbound instance. Selfbound is single-user: one owner (or a short list of Clerk user ids)
per instance. Day-to-day operation (integrations, troubleshooting) is in [operations.md](operations.md).

## Try it locally first

No account needed:

```sh
pnpm install
pnpm dev
```

`pnpm dev` (`node tooling/local.mjs --seed small --app dev`) starts an anonymous local Convex backend on
`127.0.0.1:13410` (HTTP endpoints on `13411`), configures a local test sign-in (`tooling/dev-auth.mjs`),
loads a small set of sample data and starts the app at `http://127.0.0.1:5412`. Stop with Ctrl+C.
`--seed large` loads more data and `--reset` reseeds; all options are listed at the top of
`tooling/local.mjs`.

## What you need

- Node.js 24 and pnpm (version in `package.json` → `packageManager`; `corepack enable` provides it).
- A [Convex](https://convex.dev) account (database and backend functions; the free plan is enough for
  one person).
- A [Clerk](https://clerk.com) account (sign-in). A Clerk production instance needs a domain you control,
  because Clerk serves its Frontend API from `clerk.<your domain>`.
- A static host for the web app. The repo ships tooling and routing rules for
  [Vercel](https://vercel.com); any host that supports host- and cookie-based rewrites works (see
  [Hosting elsewhere](#hosting-elsewhere)).
- Optional: a GitHub repository for the nightly backup ([backup.md](backup.md)) and a GitHub token for
  the pull request integration.

The examples use `selfbound.example.com` for the app, `clerk.selfbound.example.com` for Clerk and
`happy-otter-123` for the Convex production deployment. Replace them with your own values.

## 1. Clerk

1. Create an application in the [Clerk dashboard](https://dashboard.clerk.com) and switch to (or create)
   the **Production** instance. Add your domain (`selfbound.example.com`) and the DNS records Clerk shows.
   Optional: upload `app/public/brand/clerk-logo.png` as the application logo.
2. **JWT template:** Configure → JWT templates → New template → **Convex**. Keep the name `convex`: the app
   requests tokens with `getToken({ template: 'convex' })` and the backend expects the audience `convex`
   (`backend/convex/auth.config.ts`).
3. Note two values (Configure → API keys / Domains):
   - the **publishable key** (`pk_live_…`), for the web app;
   - the **Frontend API URL** (`https://clerk.selfbound.example.com`), the token issuer for the backend.
4. **Create your user:** Users → Create user (or sign up once before restricting sign-ups). Copy the
   **user id** (`user_…`) from the user's page.
5. **Restrict sign-ups:** Configure → Restrictions → Sign-up mode → **Restricted**.
6. **Paths:** Configure → Developers → Paths: `<SignIn />` "Sign-in page on application domain" →
   `https://selfbound.example.com/sign-in`; Signing out "Page on application domain" →
   `https://selfbound.example.com/`. See [operations.md](operations.md#clerk-settings).

To try Selfbound out, a Clerk **development** instance is fine: it needs no domain, its publishable key is
`pk_test_…` and its issuer `https://<slug>.clerk.accounts.dev`. Use a production instance for real use:
development instances are meant for testing and show a development badge.

## 2. Convex

1. Create a project in the [Convex dashboard](https://dashboard.convex.dev). Its **production**
   deployment has a name like `happy-otter-123`; the app talks to `https://happy-otter-123.convex.cloud`,
   the HTTP endpoints (MCP, GitHub webhook, health) live at `https://happy-otter-123.convex.site`.
2. Create a **production deploy key** (project settings → Deploy keys) and store it in
   `~/.config/xlr8/convex-deploy-key` with mode 600 (`tooling/cloud.mjs` refuses files others can read):
   ```sh
   mkdir -p ~/.config/xlr8 && (umask 077; cat > ~/.config/xlr8/convex-deploy-key)   # paste, Enter, Ctrl+D
   ```
3. Copy `deploy/instance.example.json` to `deploy/instance.json` (or `~/.config/xlr8/instance.json`) and fill in `convexDeployment`, `appUrl`,
   `clerkPublishableKey`, and for Vercel `vercelProject` and `vercelScope`. Leave `mcpHosts` and
   `redirectHosts` empty unless you need them ([operations.md](operations.md#instance-settings)).

### Environment variables

Set these on the production deployment **before the first deploy** (`auth.config.ts` reads
`CLERK_JWT_ISSUER_DOMAIN` and `XLR8_DEV_JWKS`, and the deploy fails if they are missing). Use the Convex
dashboard (Settings → Environment Variables) or `node tooling/cloud.mjs env set NAME value`:

| Variable | Value | Required |
|---|---|---|
| `CLERK_JWT_ISSUER_DOMAIN` | Clerk Frontend API URL, e.g. `https://clerk.selfbound.example.com` (no trailing slash) | yes |
| `XLR8_DEV_JWKS` | `none` (disables the local test sign-in) | yes |
| `XLR8_OWNER_IDS` | `<issuer>\|<user id>`, e.g. `https://clerk.selfbound.example.com\|user_2abc…`. Several owners separated by commas. Empty means nobody gets in | yes |
| `XLR8_APP_URL` | `https://selfbound.example.com`. Turns on OAuth for connectors (claude.ai, ChatGPT) | no |
| `XLR8_PUBLIC_SITE_URL` | custom address for MCP/OAuth instead of `…convex.site`, e.g. `https://mcp.selfbound.example.com` | no |
| `XLR8_OWNER_NAME` | fallback for the owner's display name in MCP output until you set a name in Settings → Profile (default `Owner`) | no |
| `XLR8_LOCALE` | `de` for German push notification texts and German default status names of new teams (default English) | no |
| `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_MANAGE_WEBHOOKS`, `GITHUB_REPOS`, `GITHUB_WEBHOOK_SECRET_PREVIOUS` | pull request integration, see [operations.md](operations.md#github) | no |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push; set them with `node tooling/vapid.mjs` | no |

Never set `XLR8_ALLOW_SEED` or `XLR8_TEST_SWITCHES` in production. Full reference:
[operations.md](operations.md#backend-environment-variables).

`XLR8_OWNER_IDS` holds Convex `tokenIdentifier`s: the token's issuer (`iss`), a `|`, and the Clerk user id
(`sub`). The issuer must match exactly what Clerk puts into its tokens, which is the Frontend API URL.

## 3. Deploy the backend

```sh
node tooling/cloud.mjs deploy
```

or, without the wrapper:

```sh
cd backend
read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY   # paste the deploy key, Enter
npx convex deploy
```

Then open `https://happy-otter-123.convex.site/health`. Expect `"ok": true`, `"clerk": true`,
`"devAuth": false`, `"local": false`.

`tooling/cloud.mjs` refuses a deploy key that does not belong to `convexDeployment`. To keep the key
elsewhere, point `XLR8_CONVEX_DEPLOY_KEY_FILE` at it.

## 4. Build and deploy the web app

### With Vercel

Install and log in to the [Vercel CLI](https://vercel.com/docs/cli) (`vercel login`), then:

```sh
node tooling/deploy-web.mjs
```

It builds the app with `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_CLERK_PUBLISHABLE_KEY`,
`VITE_XLR8_BRANCH_PREFIX` and `XLR8_PUBLIC_URL` derived from the instance settings, checks the bundle (no
local test token or local address, production URL present, sign-in page does not load the app), copies
the result to `deploy/web/`, writes `deploy/web/vercel.json` from `deploy/vercel.base.json` plus the host
rules for `mcpHosts` and `redirectHosts`, links the folder to your Vercel project on first use and deploys it to
production as a static site. `--build` stops after building. Then add `selfbound.example.com` as a domain of
the Vercel project.

### Hosting elsewhere

Build by hand:

```sh
VITE_CONVEX_URL=https://happy-otter-123.convex.cloud \
VITE_CONVEX_SITE_URL=https://happy-otter-123.convex.site \
VITE_CLERK_PUBLISHABLE_KEY=pk_live_… \
XLR8_PUBLIC_URL=https://selfbound.example.com \
pnpm --filter @selfbound/app build
mv app/dist/index.html app/dist/app.html
```

Make sure `app/.env.local` (written by `pnpm dev`) does not leak a `VITE_DEV_TOKEN` into the build: set
`VITE_DEV_TOKEN=` (empty) in the build command or delete the file. Upload `app/dist/` and reproduce the
rules from `deploy/vercel.base.json`:

1. `/` **without** the cookie `xlr8_signed_in` → serve `/welcome.html` (the sign-in page). The app sets the
   cookie after sign-in and removes it on sign-out; it only selects the page and is not a credential.
2. `/sign-in` → serve `/welcome.html` (the same page: the embedded Clerk form).
3. Every other path except `/assets/…` → serve `/app.html` (single-page app fallback; deep links such as
   `/issue/ACME-106` must work).
4. Optional: a custom MCP host proxied to `https://happy-otter-123.convex.site/<path>`
   ([operations.md](operations.md#custom-mcp-address)); old domains redirected to the app.

Headers: `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`; `no-cache` for `/`,
`/app.html`, `/welcome.html`, `/sw.js`, `/version.json`, `/site.webmanifest`, plus `Vary: Cookie` on `/`.
Recommended on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, HSTS.

The app is named `app.html` instead of `index.html` because many hosts (Vercel included) serve
`index.html` at `/` before evaluating rewrites, which would bypass rule 1.

## 5. First sign-in

1. Open `https://selfbound.example.com/`: the sign-in page appears. Sign in with the user
   from step 1.4.
2. You land in the app with an empty workspace. Create a team to start, or import from Linear
   ([architecture/import.md](architecture/import.md)).
3. **"No access"** after signing in means the backend rejected your identity: check that
   `XLR8_OWNER_IDS` contains exactly `<CLERK_JWT_ISSUER_DOMAIN>|<your user id>` (same issuer spelling, no
   trailing slash). A change to `XLR8_OWNER_IDS` takes effect right away. After changing
   `CLERK_JWT_ISSUER_DOMAIN`, redeploy the backend: `auth.config.ts` is evaluated when functions are pushed.

The UI language follows the browser (English or German) and can be changed in Settings → General.

Calendar days (due dates, sprints, recurrences, the 08:00 morning notifications) are computed in
Europe/Berlin; there is no setting for the time zone yet.

## 6. Connect agents (MCP)

- **Claude Code, Codex and other key-based clients:** Settings → Agents → create a key, then point the
  client at `https://happy-otter-123.convex.site/mcp` with `Authorization: Bearer <key>`
  ([operations.md](operations.md#agents-over-mcp)).
- **claude.ai and ChatGPT** connect as OAuth connectors. They need `XLR8_APP_URL`; a custom MCP address
  (`XLR8_PUBLIC_SITE_URL` plus a host rewrite) is optional
  ([operations.md](operations.md#connectors-in-claudeai-and-chatgpt)).

## 7. Optional extras

- Push notifications: `node tooling/vapid.mjs`, then turn them on per device
  ([operations.md](operations.md#installable-app-and-push-notifications)).
- GitHub pull requests: token, webhook secret, webhooks ([operations.md](operations.md#github)).
- Nightly encrypted backups with a restore test ([backup.md](backup.md)).

## Updating

Pull the new version, then deploy the backend first and the web app second:

```sh
git pull && pnpm install
node tooling/cloud.mjs deploy
node tooling/deploy-web.mjs
```

Open apps notice the new version within about 10 minutes and reload.
