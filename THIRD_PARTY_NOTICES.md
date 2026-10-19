# Third-party notices

Selfbound is licensed under the [GNU Affero General Public License v3.0](LICENSE). It contains and ships
software and other material from third parties, each under its own license. This file says where those
notices are. It is not legal advice.

## In every build of the app

The build writes the complete list of third-party material that ends up in the app and on the sign-in page,
with each license text, to:

- `/third-party-notices.txt`: for people. Linked from Settings › About and the sign-in page footer.
- `/third-party-notices.json`: the same, machine-readable.

The list comes from the files in the bundle, not from `package.json`, so it names exactly what is shipped:
npm packages (libraries and fonts), the bundled color themes and the bundled syntax grammars
(`app/vite.notices.ts`). The build stops if something shipped has no license or a license outside the
allowlist of AGPL-3.0-compatible licenses in that file. To see the list for the current code, run
`pnpm build` and open `app/dist/third-party-notices.txt`.

## In this repository

| Material | Where | License |
|---|---|---|
| Color themes (Catppuccin, Dracula, Nord, Tokyo Night, Gruvbox, Solarized, GitHub, One Dark Pro, Darcula) | `app/src/themes/*/theme.json`, unmodified originals | MIT; each folder has its `LICENSE`, sources and versions in [SOURCES.md](app/src/themes/SOURCES.md) |

Everything else from third parties comes in as npm packages at install time, with its license in the package.
Syntax grammars come from Shiki's `@shikijs/langs`; their original licenses are in the NOTICE file of the
`tm-grammars` package.

## Source code of an instance

The AGPL-3.0 (section 13) asks that people using a changed version over the network can get its source
code. Each instance links its source in Settings › About and on the sign-in page. The link points to this
repository unless the instance sets `sourceUrl` (`SELFBOUND_SOURCE_URL`) at build time; whoever runs a changed
version sets it to their own repository. See [docs/operations.md](docs/operations.md#instance-settings).
