# Report: preparing the public release

Date: 2026-10-13. Scope: what may be published, English and i18n, the new repository with its rules,
and the preparation (not the execution) of moving the maintainer's own instance.

## Summary

- The repository starts with a fresh history: one start commit, no history from the private repository.
- Removed before publishing: archived prototypes and benchmarks, all measurement results, audit
  reports and research notes with screenshots, private follow-up lists, the maintainer's personal
  agent skills. Production values (deployment name, domains, Clerk key, Vercel team) moved out of the
  code into instance settings (`tooling/instance.mjs`, `deploy/instance.json`, gitignored).
- Code, comments, tests, docs and agent notes are in English. The UI is English by default and German
  on request (browser language or Settings › General › Language); only the active language is loaded.
- License AGPL-3.0. README, SECURITY, CONTRIBUTING, CODEOWNERS, issue and PR templates, Dependabot,
  CodeQL. Actions pinned to commit SHAs, `GITHUB_TOKEN` read-only by default.
- Rules that GitHub only offers on public repositories (or paid plans) are scripted in
  `tooling/github-repo-settings.sh` and take effect when the repository is made public.

## 1. Audit: what may be public

Method: full-text search over every tracked file for secrets (key and token patterns of Clerk, GitHub,
AWS, Slack, age, PEM), personal data (names, mail addresses, account and deployment names, owner ids,
domains, home paths), references to private projects, and a manual review of images, fixtures and
generated data. The same search runs again on the final tree before the start commit (section 7).

### Findings and decisions

| Area | Finding | Decision |
|---|---|---|
| Secrets | No private key, token or secret in code, config, tests or fixtures. Test keys are obvious fakes (`pk_test_x`, fake JWKS generated at runtime). The Clerk *publishable* key of production was in the deploy script; it is public by design but identifies the instance. | Moved to instance settings. |
| Production identifiers | Convex deployment name, app and MCP domains, redirect domain, Clerk frontend API host, Vercel team and project in deploy scripts, `vercel.json`, the Linear import push script, a VAPID default and HTML meta tags. | Instance settings (`deploy/instance.json` or `~/.config/xlr8/instance.json`), Convex env vars (`XLR8_APP_URL`, `VAPID_SUBJECT`) and the build env `XLR8_PUBLIC_URL`. `vercel.json` is generic; host rules are generated at deploy time. |
| Owner ids | Owner access already came from the env var `XLR8_OWNER_IDS`; no Clerk user id in the code. | No change. |
| Personal names | The maintainer's name and GitHub/Git logins as defaults (branch prefix), in sample data, test fixtures (GitHub webhook payloads), MCP server instructions, comments. Names of private agents. | Replaced with neutral samples or configuration (`VITE_XLR8_BRANCH_PREFIX`, `XLR8_OWNER_NAME`). The copyright line and the credit on the landing page keep the author's name on purpose. |
| Stored owner kind | The actor kind for the owner is stored in production data under a legacy value. | Kept as stored value (renaming needs a data migration), referenced through a named constant in code. |
| Private projects | Sample team and company names from private projects in seed data and tests; Linear workspace URLs in fixtures. | Replaced. |
| Measurements | `perf/results/` held runs with machine details (CPU, GPU state, load). | Not published, now gitignored. `perf/baseline.json` stays (CI needs it); it names only the CPU model. |
| Screenshots | Audit reports and research notes contained screenshots, some with real issue data. App screenshots on the landing page and OG images show sample data only (checked). | Reports, research and their media not published. Landing page images kept. |
| Third-party material | Sound values of a commercial UI sound kit were replaced before (own values), but remain in the private history. Notes comparing with Linear's UI. | Fresh history (main reason for not publishing the old repository). Comparison notes and research removed; Linear stays only where the importer needs it. |
| Agent skills | `.agents/skills/` held the maintainer's personal skills (a private assistant with personal workflow details, writing and PR helpers), installed from a private skills collection; origin and licence not clear for all. | None published. `AGENTS.md` and `CLAUDE.md` now carry the project rules for coding agents. |
| Paths | Home directory paths appeared only in private notes and measurement logs. | Removed with them; the final scan finds none. |

## 2. English and i18n

- All code, comments, identifiers, tests, scripts and docs translated. User-visible URL paths are
  English; the old German paths stay as aliases so bookmarks keep working.
- i18n in gettext style (`core/src/i18n.ts`): the English text is the key, so English needs no
  dictionary. German is one lazily loaded chunk (`app/src/locales/de/`, `core/src/locales/de.ts`),
  fetched before the app mounts only when German is active. Language choice: Settings › General ›
  Language (Automatic, English, Deutsch), default from the browser language.
- `tooling/i18n-check.mjs` (in CI) fails on UI keys without German, on placeholder mismatches and
  on conflicting translations. Strings translated before the dictionary loads are reported at runtime
  (`[i18n]` warning), and an e2e test switches to German and checks for it.
- Backend texts read outside the UI: push notifications follow `XLR8_LOCALE` (default English); the
  owner's name in MCP output comes from `XLR8_OWNER_NAME`.

## 3. Repository and rules

FILLED IN BELOW

## 4. CI

FILLED IN BELOW

## 5. Tempo

FILLED IN BELOW

## 6. Moving the maintainer's instance

Prepared separately in the private repository (it names production values): order of steps, script,
rollback. Nothing was executed. One technical point belongs here because it is generic:
`backend/convex/repoRename.ts` with `tooling/rename-github-repo.mjs` moves stored GitHub references when
a repository is renamed and its old name is reused, which ends GitHub's redirect.

## 7. Open points

FILLED IN BELOW
