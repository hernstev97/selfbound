# Selfbound docs site

Public user documentation for docs.selfbound.kiumu.app, built with [Starlight](https://starlight.astro.build).
The internal architecture and operations docs stay in `docs/`.

```sh
pnpm --filter @selfbound/docs dev        # http://127.0.0.1:5420/
pnpm --filter @selfbound/docs build      # into docs-site/dist/
node docs-site/scripts/deploy.mjs   # build + Vercel preview deploy (--prod for production)
```

| Path | Content |
|---|---|
| `src/content/docs/` | pages (Markdown/MDX); the sidebar is in `astro.config.mjs` |
| `src/styles/theme.css` | Selfbound's colours, type and components mapped onto Starlight |
| `src/components/` | `Kbd`, `Planned`, `Screenshot`, generated `ShortcutTable` and `McpTools`, overrides for `Hero` and `Footer` |
| `src/assets/screenshots/` | app screenshots with demo data, `<name>-light.png` / `<name>-dark.png` |
| `launch.mjs` | `INDEXABLE`: the one switch that removes `noindex` (meta tag, robots.txt, `X-Robots-Tag`) at launch |

`src/pages/impressum.astro` and `datenschutz.astro` are the imprint and privacy policy of this host (German,
binding). The operator's name and address are not in the repository: they are read at build time from
`~/.config/selfbound/site-legal.json`, see [site/README.md](../site/README.md#imprint-privacy-policy-and-visitor-statistics).
A `--prod` deploy fails without that file. The docs run no visitor statistics and set no cookies; the privacy
text says so and names the two entries Starlight keeps in the browser (colour theme, chosen tab). Change the
text together with any code that changes this.

Generated from the code, so they change with it: keyboard shortcuts (`core/src/app/actions.ts`,
`core/src/app/sprints.ts`) and the MCP tool reference (`backend/convex/lib/mcp/tools.ts`).

Only document what the code does. Mark features that do not exist yet with `<Planned issue="…">`.

Screenshots: start the app with sample data (`node tooling/local.mjs --seed small --reset --app dev`), then
`node docs-site/scripts/capture-screenshots.mjs` (`--only board,list` for a subset). The script refuses
non-local backends.
