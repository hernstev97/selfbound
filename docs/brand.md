# Logo and brand assets

Two source files in `brand/` define the logo. Everything else is generated from them with
`node tooling/brand.mjs` (needs `rsvg-convert` and ImageMagick) and copied to the app, the landing page
and the docs site. **To swap the logo, replace these two files and run the script.**

| Source | Purpose |
| --- | --- |
| `brand/logo.svg` | the logo as shown in headers, sign-in screen, consent page, docs hero and social image (wordmark, or symbol + wordmark) |
| `brand/mark.svg` | the compact symbol: favicon, app and notification icons, loading screen, animated landing page background |

Requirements for both files: outlined shapes only (`<path>`; no `<text>`, strokes, gradients, masks or
transforms), one colour (it is replaced by `currentColor`, black or white), a `viewBox` that includes the
padding you want, `fill-rule` set on the paths when it is not `nonzero`. The script stops with a message if
a file does not fit. Square symbols work best; other proportions are fitted without stretching.

The current files are a **temporary wordmark**: "Selfbound" in Inter Variable (weight 700, tracking −2.5 %),
converted to outlines, and the letter "S" as the symbol. They are placeholders until the final logo exists.

## What the script writes

| File | Purpose |
| --- | --- |
| `app/public/brand/selfbound-logo.svg`, `selfbound-mark.svg` | `fill="currentColor"`, takes the surrounding text colour |
| `app/public/brand/…-black.svg`, `…-white.svg` | fixed colour for places without CSS (black on light, white on dark backgrounds) |
| `app/public/favicon.svg` | symbol with padding, black or white depending on `prefers-color-scheme` |
| `app/public/favicon.ico`, `favicon-16/32/48.png` | fallback: white symbol on a dark rounded square (readable in light and dark tabs) |
| `app/public/apple-touch-icon.png` | 180 × 180, full square (iOS rounds the corners itself) |
| `app/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | web manifest (`site.webmanifest`, also written by the script) |
| `app/public/badge-96.png` | notification status bar icon (white on transparent) |
| `app/public/brand/og-image.png` | 1200 × 630, social preview image (`og:image`, `twitter:image`) |
| `app/public/brand/clerk-logo.png` | 512 × 512, for uploading in the Clerk dashboard (application logo) |
| `app/src/lib/brand.ts` | the shapes for the inline SVG (`components/Logo.svelte`): sidebar (logo), sign-in and consent screens (logo), loading screen (mark) |
| `site/public/…` | favicons, `brand/selfbound-logo.svg`, `selfbound-mark.svg`, `brand/og.png` for the landing page |
| `docs-site/public/…`, `docs-site/src/assets/logo-light.svg`, `logo-dark.svg` | favicons, social image and header logo of the docs |

Two places carry the logo's aspect ratio as a number: the `.logo` rule in `app/src/welcome/welcome.css` and in
`site/src/style.css` (`aspect-ratio: 6.13 / 1`, plus the header height). If a new logo has another ratio,
`app/test/brand.test.ts` fails until both are updated. The logo sizes elsewhere are set by height
(`Logo.svelte` `height`, the docs hero in `docs-site/src/components/Hero.astro`); check them once with the new logo.

After a logo change, also upload `app/public/brand/clerk-logo.png` in the Clerk dashboard and check the
installed app icon (the browser caches manifest icons).

`app/test/brand.test.ts` makes sure the sources, the generated files, the copies and the inline paths stay in sync.
