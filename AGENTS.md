# Notes for coding agents

Selfbound is a keyboard-first issue tracker: Svelte 5 SPA (`app/`), framework-neutral core (`core/`),
Convex backend (`backend/`), Playwright tests (`e2e/`), performance harness (`perf/`). Read
`docs/architecture/frontend.md` and `docs/architecture/backend.md` before larger changes.

## Commands

| Command | Use |
|---|---|
| `pnpm dev` | local Convex backend (no account) + sample data + app on http://127.0.0.1:5412/ |
| `pnpm typecheck` | types for all packages |
| `pnpm test` | unit tests; `pnpm --filter @selfbound/backend test:lib` and `test:integration` for the rest |
| `pnpm e2e` | browser tests with their own backend and build |
| `node tooling/i18n-check.mjs` | every UI string has a German entry |
| `node perf/run.ts --quick` | quick performance run; the full run (`pnpm perf`) needs an idle machine |

On a machine someone is using, run builds and tests through `tooling/quiet.sh <command>` (limited CPU,
low priority). Do not start full performance runs unless asked.

## Rules

- Branch names describe the work: `<type>/<issue>-<slug>` with type `feat|fix|docs|refactor|perf|test|chore|ci`
  (e.g. `feat/self-48-github-issues-import`), or `<type>/<slug>` without an issue. Never a tool, user or
  account prefix (`t3code/`, `claude/`, `codex/`, `aleister/`, user names, e-mail addresses). The CI check
  `branch-name` fails otherwise; rename with `git branch -m`.
- Outside contributions are issue-first (`CONTRIBUTING.md`): a pull request from a non-collaborator must
  refer to an issue the maintainer labeled `accepted`, or it is closed automatically.
- Naming: the product is called Selfbound. The Selfbound team's key is `SELF` (issue ids `SELF-48`) since 2026-10-16. `XLR8` survives only as its previous key
  (`XLR8-48` and `xlr8-48` still resolve), the instance URL `xlr8.kiumu.app` and MCP URL of the maintainer's instance, and the
  Vercel project `xlr8`. The few
  remaining old names (`XLR8_*` env vars, `xlr8:*` storage, `xlr8_` key prefixes, actor kind `steven`) are accepted
  fallbacks, each marked `legacy-xlr8` in code, until the follow-up removes them (`docs/operations.md`, "Moving from
  the XLR8 names"). New code uses only the new names. The repository is `hernstev97/selfbound`; packages are `@selfbound/*`.
- Everything in English: code, comments, identifiers, tests, docs, commit messages, PR texts.
- UI text through `t()`, `tn()`, `tc()` or `translated()` from `core/src/i18n.ts`, with the German
  entry in `app/src/locales/de/*.ts` or `core/src/locales/de.ts`. Never call `t()` at module level.
- Speed: 100 ms p95 per interaction with 10,000 issues; start bundle at most 5 % above
  `perf/baseline.json`. Load rarely used code with dynamic `import()`. Avoid per-row work in list rendering.
- Production data depends on stored names: do not rename Convex tables, fields, stored enum values,
  function names, HTTP routes, MCP tool names or parameters, or browser storage keys without a migration. Renames also keep
  reading the old name as a marked `legacy-xlr8` fallback.
- Business errors in the backend use `fail()` / `invalid()` from `backend/convex/lib/errors.ts` with an
  error code; UI and MCP share the operations in `backend/convex/ops/`.
- Every new action gets a command menu entry (`core/src/app/actions.ts`) and, where it fits, a shortcut.
- No secrets, personal data or real production values in code, tests, fixtures, logs or screenshots.
  Instance-specific values belong in Convex env vars or `deploy/instance.json` (gitignored).
- Keep comments short and about why. Match the surrounding style.
