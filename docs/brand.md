# Logo and brand assets

Four source files in `brand/` define the logo. Everything else is generated from them with
`node tooling/brand.mjs` (needs `rsvg-convert` and ImageMagick) and copied to the app, the landing page
and the docs site. **To swap the logo, replace these files and run the script.**

| Source | Purpose |
| --- | --- |
| `brand/symbol.svg` | the symbol: app icons, loading screen, animated landing page background |
| `brand/wordmark.svg` | the lettering "Selfbound" |
| `brand/lockup.svg` | symbol + wordmark: sidebar, sign-in and consent screens, landing and docs headers, social image |
| `brand/favicon.svg` | the symbol simplified for 16 px: favicons |

Requirements: outlined shapes only (`<path>`, optionally with a `translate`/`scale` transform; no `<text>`,
strokes, gradients or masks), one colour (it is replaced), a `viewBox` that includes the padding you want,
`fill-rule` on the paths when it is not `nonzero`. The script stops with a message if a file does not fit.

## Colours

Only two: **white** `#FFFFFF` (`--text-strong`) and **ink** `#070707`, the dark theme's `--bg-app`
(`oklch(0.129 0.0009 286)` in sRGB). Both are constants at the top of `tooling/brand.mjs`; the generated
SVGs come as `-ink` (dark shapes, for light backgrounds), `-paper` (white shapes, for dark backgrounds) and
`currentColor`. All PNGs are paper-coloured symbols on an ink tile. `app/test/brand.test.ts` checks that no
other colour appears.

## What the script writes

| File | Purpose |
| --- | --- |
| `app/public/brand/selfbound-{symbol,wordmark,lockup}.svg` | `fill="currentColor"`, takes the surrounding text colour |
| `app/public/brand/…-ink.svg`, `…-paper.svg` | fixed colour for places without CSS |
| `app/public/favicon.svg` | simplified symbol, ink or paper depending on `prefers-color-scheme` |
| `app/public/favicon.ico`, `favicon-16/32/48.png` | simplified symbol filling an ink tile; its gap lands on whole pixels at 16, 32 and 48 px |
| `app/public/apple-touch-icon.png` | 180 × 180, full square (iOS rounds the corners itself) |
| `app/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | web manifest (`site.webmanifest`, also written by the script); the maskable one keeps the symbol inside the 80 % safe zone |
| `app/public/badge-96.png` | notification status bar icon (paper on transparent) |
| `app/public/brand/og-image.png` | 1200 × 630, social preview image (`og:image`, `twitter:image`) |
| `app/public/brand/clerk-logo.png` | 512 × 512, for uploading in the Clerk dashboard (application logo) |
| `app/src/lib/brand.ts` | the shapes for the inline SVG (`components/Logo.svelte`): sidebar, sign-in and consent screens (lockup), loading screen (symbol) |
| `site/public/…` | favicons, `brand/selfbound-lockup.svg`, `selfbound-symbol.svg`, `brand/og.png` for the landing page |
| `docs-site/public/…`, `docs-site/src/assets/logo-light.svg`, `logo-dark.svg` | favicons, social image and header logo of the docs (ink and paper lockup) |

The app-icon proportions (symbol 56 % of the tile, corner radius 22.5 %) are constants in the script.

Two places carry the lockup's aspect ratio as a number: the `.logo` rule in `app/src/welcome/welcome.css` and
in `site/src/style.css` (`aspect-ratio: 7.2085 / 1`, plus the header height). If a new lockup has another ratio,
`app/test/brand.test.ts` fails until both are updated. Other sizes are set by height (`Logo.svelte` `height`,
the docs hero in `docs-site/src/components/Hero.astro`); check them once with new files.

The README shows the lockup from `app/public/brand/selfbound-lockup-{ink,paper}.svg`. After a logo change, also
upload `app/public/brand/clerk-logo.png` in the Clerk dashboard and check the installed app icon (browsers
cache manifest icons). The screenshots in `docs-site/src/assets/screenshots/`, `docs/images/` and
`site/src/assets/` show the sidebar logo and have to be recaptured (`docs-site/scripts/capture-screenshots.mjs`).
