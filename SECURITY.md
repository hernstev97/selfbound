# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
(<https://github.com/hernstev97/xlr8-public/security/advisories/new>).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an
answer within a week. XLR8 is maintained by one person in their spare time, so fixes may take a while;
you will be kept informed and credited unless you prefer otherwise.

## Scope

- The code in this repository: backend functions and HTTP endpoints (MCP, OAuth, GitHub webhook),
  the web app, the service worker, and the tooling.
- Not in scope: instances run by other people, and the services XLR8 builds on (Convex, Clerk, Vercel,
  GitHub). Report issues there to the respective vendor.

## Supported versions

Only the latest commit on `main` is supported. There are no releases yet.

## For self-hosters

Each instance is single-owner: access is limited to the Clerk user ids in `XLR8_OWNER_IDS`. Keep
deploy keys, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` and VAPID private keys in your Convex environment
or CI secrets, never in the repository. See [docs/operations.md](docs/operations.md).
