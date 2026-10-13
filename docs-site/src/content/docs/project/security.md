---
title: Security
description: How to report a vulnerability in XLR8, and how an XLR8 instance protects your data.
sidebar:
  order: 3
---

If you found a security problem in XLR8, report it privately. This page also explains how an XLR8 instance keeps your data safe and what you, as a self-hoster, are responsible for.

## Report a vulnerability

Please do not open a public issue. Report it privately through GitHub instead: on the repository, open **Security → Report a vulnerability** ([direct link](https://github.com/hernstev97/xlr8-public/security/advisories/new)).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer within a week. XLR8 is maintained by one person in their spare time, so a fix may take a while; you will be kept informed and credited unless you prefer otherwise.

**In scope:** the code in the repository, including the backend functions and HTTP endpoints (MCP, OAuth, GitHub webhook), the web app, the service worker and the tooling. **Not in scope:** instances run by other people, and the services XLR8 builds on (Convex, Clerk, Vercel, GitHub); report those to the vendor. Only the latest commit on `main` is supported.

The full policy is in [SECURITY.md](https://github.com/hernstev97/xlr8-public/blob/main/SECURITY.md).

## Security model for self-hosters

Every XLR8 instance belongs to one person. There are no user accounts to manage, no roles and no sharing, which keeps the attack surface small.

### Sign-in: one owner

You sign in through Clerk. Convex checks the sign-in token, and then XLR8 checks the account against an allowlist: only the accounts in the `XLR8_OWNER_IDS` environment variable get in. If the list is empty, nobody gets in. Every public backend function goes through this check.

Also set the sign-up mode of your Clerk application to **Restricted**, so strangers cannot even create an account. [Set up Clerk](/start/self-hosting/clerk/) walks you through it.

The local test sign-in that `pnpm dev` uses works only against a backend on your own machine. A cloud backend rejects it, even if it was configured there by mistake.

### Agent keys

Each agent gets its own API key. XLR8 shows the key once, when you create it, and stores only a SHA-256 hash of it, so the key cannot be read back from the database or from a backup. You can revoke each key on its own under **Settings → Agents**. Each agent also has a limit on calls per minute and per day.

### Connectors

claude.ai and ChatGPT connect through OAuth with PKCE instead of a key. XLR8 accepts new connectors only for 15 minutes after you press **Connect connector**, and only after you approve the request on the consent page while signed in. The first approval closes that window again, so a planted consent link leads nowhere. Only redirect addresses of claude.ai and chatgpt.com are accepted.

XLR8 stores only hashes of OAuth codes and tokens. Access tokens expire after an hour, and refresh tokens are replaced every time they are used. If a code is used twice, or an old refresh token shows up again after a short grace period, XLR8 assumes it was stolen and revokes the connector.

### GitHub webhook

Deliveries from GitHub must carry a valid signature made with `GITHUB_WEBHOOK_SECRET`. Without the secret, the backend rejects every delivery. The GitHub token lives only in the backend's environment and never reaches the browser.

### Images and logos

Images in descriptions and comments are served under addresses that contain a long random token. Anyone who has such an address can open the image, so treat image links like the text they appear in. Team logos are checked on upload: only PNG or SVG, and SVGs only with an allowlist of elements, so they cannot carry scripts.

### Settings that must stay off in production

`XLR8_ALLOW_SEED` (sample data) and `XLR8_TEST_SWITCHES` (test switches such as "server rejects changes") are for local development only. **Never set them on a production backend.** **Settings → Ops** shows whether test switches are available on your instance.

Keep deploy keys, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` and the VAPID private key for push notifications in your Convex environment or your CI secrets, never in the repository.

### Web app headers

When you deploy the web app with the included Vercel configuration (`deploy/vercel.base.json`), every response carries security headers: HSTS, `X-Frame-Options: DENY` (no embedding in other sites), `X-Content-Type-Options: nosniff`, a strict referrer policy, and a permissions policy that turns off camera, microphone and location.

### Backups

The repository includes a nightly backup workflow for GitHub Actions. Once you set it up, it exports the whole database, tests that the export can be restored, and encrypts it with [age](https://age-encryption.org) before storing it. Only the holder of your private age key can open a backup; the unencrypted export never leaves the runner. Setup and restore are described in [docs/backup.md](https://github.com/hernstev97/xlr8-public/blob/main/docs/backup.md).
