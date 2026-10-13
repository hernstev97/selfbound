# Contributing

Thanks for your interest. XLR8 is early and maintained by one person, so please keep changes focused.

- **Bugs and ideas:** open an issue. For anything larger than a small fix, open an issue before you
  write code, so we can agree on the approach.
- **Security issues:** never in public issues, see [SECURITY.md](SECURITY.md).

## Setup

Node 24 and pnpm 11. `pnpm install`, then `pnpm dev` (local Convex backend, no accounts). Details in
[README.md](README.md).

## Before you open a pull request

```sh
pnpm typecheck
pnpm test
node tooling/i18n-check.mjs
pnpm e2e            # browser tests; CI runs them too
```

CI (job `check`) runs types, unit and integration tests, the browser tests and a quick performance run
on every pull request. A pull request needs a green `check` and a review from the maintainer.

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
