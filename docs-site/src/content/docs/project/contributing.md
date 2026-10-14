---
title: Contributing
description: How to propose changes to Selfbound, run it locally, and which rules a pull request has to follow.
sidebar:
  order: 1
---

Selfbound is early and maintained by one person, so focused contributions help most. This page gives an overview. The authoritative rules are in [CONTRIBUTING.md](https://github.com/hernstev97/xlr8/blob/main/CONTRIBUTING.md) and, for coding agents, [AGENTS.md](https://github.com/hernstev97/xlr8/blob/main/AGENTS.md) in the repository.

## Issue first, then pull request

- **Bugs and ideas:** open an [issue on GitHub](https://github.com/hernstev97/xlr8/issues).
- **Anything larger than a small fix:** open an issue before you write code, so you and the maintainer can agree on the approach first.
- **Security problems:** never in a public issue. See [Security](/project/security/).

## Run it locally

You need Node 24 and pnpm 11. No accounts are required:

```sh
pnpm install
pnpm dev          # http://127.0.0.1:5412/
```

`pnpm dev` starts a local Convex backend, loads sample data and serves the app. [Try it locally](/start/try-locally/) has the details.

## Before you open a pull request

Run the checks:

```sh
pnpm typecheck                 # types for all packages
pnpm test                      # unit tests
node tooling/i18n-check.mjs    # every UI string has a German entry
pnpm e2e                       # browser tests with their own backend
```

CI runs the types, the unit and integration tests, the browser tests and a quick performance run on every pull request. A pull request needs a green `check` job and a review from the maintainer.

## Rules that matter

- **English everywhere:** code, comments, identifiers, tests, docs, commit messages and pull request texts.
- **UI text goes through `t()`** (or `tn()`, `tc()`, `translated()`) from `core/src/i18n.ts`, with the English text as the key. Add the German entry in `app/src/locales/de/` or `core/src/locales/de.ts`. If you don't speak German, add the English text as the entry and say so in the pull request.
- **Speed is a feature.** The budget is 100 ms (p95) per interaction with 10,000 issues, and the start bundle may grow by at most 5 % over the baseline. Load rarely used code lazily with dynamic `import()`, and avoid per-row work in list rendering. `node perf/run.ts --quick` gives a quick reading.
- **Keyboard first.** Every new action gets an entry in the command menu (`core/src/app/actions.ts`) and, where it fits, a shortcut.
- **Stored names stay.** Production data depends on them: do not rename Convex tables, fields, stored enum values, function names, HTTP routes, MCP tool names or parameters, or browser storage keys without a migration.
- **No secrets, personal data or real production values** in code, tests, fixtures, logs or screenshots.
- **Comments** are short and explain why. Match the style of the surrounding code.
- **Commit messages and pull request titles** are short and imperative, such as "Keep focus in the create dialog after Esc".

## Architecture docs

For larger changes, read the internal architecture notes first:

- [Frontend](https://github.com/hernstev97/xlr8/blob/main/docs/architecture/frontend.md): structure, data flow, extension points, translations and the performance rules
- [Backend](https://github.com/hernstev97/xlr8/blob/main/docs/architecture/backend.md): Convex tables and rules, public functions, error codes and the sprint rules
- [MCP](https://github.com/hernstev97/xlr8/blob/main/docs/architecture/mcp.md): the MCP endpoint, its tools and OAuth for connectors
- [Import](https://github.com/hernstev97/xlr8/blob/main/docs/architecture/import.md): the import from Linear, format and processing

## License of contributions

By contributing, you agree that your contribution is licensed under the AGPL-3.0, like the rest of the project. See [License](/project/license/).
