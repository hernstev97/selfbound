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
generated data. The same search ran again on the final tree of the start commit: it finds only the
intended mentions (copyright line, author credit, the legacy stored owner value and the code owner).

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

| Rule | State while private | After going public |
|---|---|---|
| Merges: squash or rebase only, branches deleted after merge | active | active |
| `GITHUB_TOKEN` read-only by default, permissions per job in every workflow | active | active |
| Actions pinned to commit SHAs, enforced (`sha_pinning_required`); allowed: GitHub-owned and `pnpm/action-setup` | active | active |
| Fork PRs: no workflows, no secrets, no write tokens (private-repo setting) | active | replaced by: approval required for all outside contributors |
| Dependabot alerts and security updates; version updates grouped weekly with a 7-day cooldown (`.github/dependabot.yml`) | active | active |
| Ruleset `main`: PRs only, required check `check` and CodeQL results, no force push, no deletion, linear history; admins may bypass only when merging a PR | not available (GitHub Free) | `tooling/github-repo-settings.sh` |
| Issue-first contributions: PRs from non-collaborators without an issue labeled `accepted` are closed with a friendly note (`.github/workflows/pr-policy.yml`, `pull_request_target`, never checks out PR code) | active once the repository is public and Actions minutes exist | same |
| Branch names `<type>/<issue>-<slug>`: CI check `branch-name`, required in ruleset `main`. No GitHub branch-name ruleset: GitHub rejects `branch_name_pattern` (HTTP 422) for a personal account's repository, so the check is the enforcement | check runs with Actions | `tooling/github-repo-settings.sh` |
| Secret scanning with push protection (incl. non-provider patterns, validity checks) | not available | same script |
| Private vulnerability reporting | not available | same script |
| CodeQL (`security-extended`, JavaScript/TypeScript and Actions) | workflow skips itself | runs on push, PR and weekly |

Bypass: the ruleset allows repository admins (only the maintainer) to bypass, in pull-request mode only,
so even the maintainer cannot push directly to `main`. Required reviews are set to 0 on purpose: with a
single maintainer, own pull requests could otherwise never be merged without bypassing all checks.
`CODEOWNERS` still requests the maintainer's review on every outside pull request, and only the
maintainer can merge. `strict_required_status_checks_policy` is off (no forced rebase before each merge).

Files: `LICENSE` (AGPL-3.0, GitHub's canonical text), `README.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`AGENTS.md` + `CLAUDE.md`, `.github/CODEOWNERS`, issue forms (bug, feature; blank issues off, security
link), PR template.

Backup workflow: kept (generic, inactive without secrets). In a public repository its logs and artifacts
are public; the archive is encrypted, but manifest and restore summary are not. The workflow says so,
and the maintainer runs backups from a private copy.

## 4. CI

`ci.yml` as before (types, unit tests, integration with a local backend, Playwright, quick performance
run with the start-bundle budget), plus a translation check (`node tooling/i18n-check.mjs`), SHA-pinned
actions, `persist-credentials: false`, `permissions: {}` at workflow level, and `workflow_dispatch`.

**The new repository's CI has not run yet.** GitHub did not start the job of the start commit: the
account's Actions budget for private repositories is used up ("recent account payments have failed or
your spending limit needs to be increased"), which is the reason for going public in the first place.
It runs once the repository is public (`gh workflow run CI -R <repo>`).

The same checks, run locally on the final tree (via `tooling/quiet.sh`):

| Check | Result |
|---|---|
| `pnpm typecheck` (+ `tsc -p test/lib`, `tsc -p ../tooling/linear-import`) | 0 errors |
| `node tooling/i18n-check.mjs` | 1353 keys, 0 errors, 0 warnings |
| `pnpm test` | backend 469 passed (11 skipped), core 249, app 174 |
| `pnpm --filter @selfbound/backend test:lib` | 217 passed (11 skipped) |
| `test:integration` (local backend: import, Linear files, MCP, OAuth, concurrency) | all passed |
| `pnpm e2e` | 243 passed, 0 failed (incl. the new German-locale test) |
| quick performance run | not run locally (no measurement runs on the maintainer's machine during this work); first run in CI |

## 5. Tempo

Touched: startup (language chosen before the app instance is created; German loads one extra chunk,
English loads nothing extra), every UI string (a `t()` call; lookups are a plain property read, English
returns the key), list rows (fixed row texts translated once and cached), seed data (English texts
change the generated dataset slightly: same counts, descriptions 2.6 % and titles 14 % shorter, which
may shift timings a little against the old baseline).

Start bundle, measured statically with `perf/bundle.ts` on a perf-like build (no timing run):

| Build | Start bundle (brotli) |
|---|---|
| Baseline (`perf/baseline.json`) | 122,751 B |
| Old `main` before this work | 119.4 kB |
| This tree | 121.6 kB (+1.8 % vs old main, about +1.4 % vs baseline; CI fails at +5 %) |
| German dictionary chunk (loaded only for German) | 80.6 kB raw, 23.4 kB brotli |

A first build put the German core dictionary into the start chunk through the manual chunk rule in
`app/vite.config.ts` (+6.5 %); the rule now excludes `core/src/locales/`. Performance metric names are
English now, so `perf/ab.ts` and `perf/idle.ts` cannot compare runs from before and after this change;
the CI comparison uses the renamed keys in `perf/baseline.json`. Timing values from CI follow with the
first run after going public.

## 6. Moving the maintainer's instance

Prepared separately in the private repository (it names production values): order of steps, script,
rollback. Nothing was executed. One technical point belongs here because it is generic:
`backend/convex/repoRename.ts` with `tooling/rename-github-repo.mjs` moves stored GitHub references when
a repository is renamed and its old name is reused, which ends GitHub's redirect.

## 7. Open points

- CI of the new repository: first run after going public (section 4).
- Stored legacy values kept to avoid data migrations: actor kind `'steven'` (owner) and the MCP result
  field `reviewedBySteven`. Both are documented; renaming needs a migration and a deprecation period.
- Time zone: calendar days (due dates, sprints, importer) are fixed to Europe/Berlin; a setting is needed
  for users elsewhere.
- Backend business errors are English only; the German UI shows them in English.
- The landing page (`app/welcome.html`) carries the author credit and copyright line; review the wording
  for self-hosted instances.
- Search keywords in the command menu contain German synonyms (search data, intentionally kept).
- XLR8-47 (setup script) remains open: hard-coded values are now configuration, `docs/self-hosting.md`
  describes the manual setup; the interactive script is not written yet.
