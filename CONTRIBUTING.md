# Contributing

Thanks for your interest. Selfbound is early and maintained by one person, so contributions work
issue-first. That keeps your time well spent and the project focused.

## How to contribute

1. **Open an issue** (bug or feature form). Describe the problem first; a solution idea is a bonus.
   If you would like to build it yourself, say so in the issue.
2. **Wait for approval.** The maintainer reads the issue and, if it fits, adds the label `accepted`.
   An issue without that label is not a request for a pull request. It may still be answered, planned
   or declined. Declining is about fit, not about you.
3. **Then open a pull request** that mentions the issue in its description ("Closes #123"). Keep it
   focused on that issue.

Pull requests from people who are not collaborators and that do not refer to an open issue labeled
`accepted` are closed automatically with a short note pointing here. Nothing is lost: once the issue is
accepted, reopen the pull request or open a new one. This applies to small fixes too: a one-line
issue is enough and quickly answered.

**Security issues:** never in public issues, see [SECURITY.md](SECURITY.md).

## Setup

Node 24 and pnpm 11. `pnpm install`, then `pnpm dev` (local Convex backend, no accounts). Details in
[README.md](README.md).

## Branch names

A branch name describes the work: `<type>/<issue>-<slug>`, or `<type>/<slug>` without an issue.

- Type: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore` or `ci`.
- Issue: the GitHub issue number or the XLR8 identifier, in lower case. Slug: lower-case words
  separated by hyphens.
- Examples: `feat/xlr8-48-github-issues-import`, `fix/123-focus-after-esc`, `docs/self-hosting-clerk`.
- No prefixes that name a tool or person (`claude/`, `codex/`, `t3code/`, user names), and no e-mail
  addresses. Dependabot branches (`dependabot/…`) are the only exception.

The check `branch-name` on every pull request enforces this. Rename a branch with
`git branch -m <new-name>` and push it again.

## Before you open a pull request

```sh
pnpm typecheck
pnpm test
node tooling/i18n-check.mjs
pnpm e2e            # browser tests; CI runs them too
```

CI (job `check`) runs types, unit and integration tests, the browser tests and a quick performance run
on every pull request. A pull request needs a green `check` and `branch-name` and a review from the maintainer.

## Conventions

- **English** for code, comments, identifiers, tests, docs and commit messages.
- **UI text** goes through `t()` from `core/src/i18n.ts` (English text is the key). Add the German
  translation to the matching file in `app/src/locales/de/` or `core/src/locales/de.ts`. If you don't
  speak German, add the entry with the English text and say so in the pull request.
- **Speed is a feature.** The budget is 100 ms p95 per interaction with 10,000 issues, and the start
  bundle may not grow by more than 5 % without a good reason. Load new, rarely used code lazily.
- **Keyboard first.** New actions get an entry in the command menu (`core/src/app/actions.ts`).
- Keep comments short and about *why*. Match the style of the surrounding code.
- No secrets, personal data or production values in code, tests, fixtures or screenshots.
- Commit messages and pull request titles: short, imperative, explain the change
  ("Keep focus in the create dialog after Esc").

## License

By contributing, you agree that your contribution is licensed under the
[AGPL-3.0](LICENSE), like the rest of the project.
