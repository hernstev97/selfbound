# Landing page

The public page for Selfbound (static HTML, one stylesheet, one small script for the background motion). It is
a separate Vite project, not part of the app build: nothing from `app/`, `core/` or `backend/` is
loaded, and the app loads nothing from here. The app's own start page (`app/welcome.html`) is only a
plain sign-in.

```sh
pnpm site:dev      # http://127.0.0.1:5413/
pnpm site:build    # site/dist/
pnpm --filter @selfbound/site preview   # http://127.0.0.1:5403/
```

## Content and settings

- Text and structure: `index.html`. Styles: `src/style.css`. Background: `src/raster.ts` (a dot grid as one
  WebGL 2 fragment shader with the Selfbound star; a still image with reduced motion or without WebGL 2).
- `site.config.json`: `listed` (see below), `github` (repository) and `docs` (documentation site, base URL; a few links point to pages below it) are filled into the links of `index.html`.
- Screenshots in `src/assets/` show the app with the sample data of `pnpm dev` (English UI), 1280 and
  2560 px wide, dark and light. `src/assets/demo-light.mp4` and `demo-dark.mp4` (about 30 s, 1280 × 800, no
  sound, 0.7 MB each) are the demo video: `src/main.ts` loads the one for the color scheme after the page has
  loaded, lays it over the hero screenshot, plays it only while visible and not with reduced motion, and the
  button under it pauses it. Record it with `e2e/tools/demo-video.mjs`, compress it with the `pr-media` skill's
  `compress.sh medium`. `public/brand/social.png` is the link preview image (`e2e/tools/social-image.mjs`). `public/` holds copies of the logo, mark and icons from
  `app/public/`; refresh them there when the brand files change.

## Imprint, privacy policy and visitor statistics

`impressum.html` and `datenschutz.html` are the imprint (§ 5 DDG, § 18 Abs. 1 MStV) and the privacy policy
(German text is binding, with a short English note), linked from the footers of the page and of the docs
(`docs-site/src/pages/`, same texts for its own host). They name a person and a postal address, so the
details are **not in this repository**. They are filled in at build time from a file outside it:

```json
// ~/.config/selfbound/site-legal.json  ($XDG_CONFIG_HOME/selfbound/, or the path in SELFBOUND_SITE_LEGAL_FILE)
{ "name": "…", "street": "…", "postalCode": "…", "city": "…", "country": "…", "email": "…", "phone": "optional" }
```

The build **fails** if the file is missing or incomplete when the site is listed or for a production deploy
(`node tooling/deploy-site.mjs --prod` sets `SELFBOUND_SITE_REQUIRE_LEGAL=1`); other builds show visible
placeholders. Loader and tests: `tooling/site-legal.mjs`, `site/test/legal.test.ts`.

When `listed` is true (and only then) the built `index.html` loads
[Vercel Web Analytics](https://vercel.com/docs/analytics/privacy-policy) and
[Speed Insights](https://vercel.com/docs/speed-insights/privacy-policy) from `/_vercel/insights/script.js` and
`/_vercel/speed-insights/script.js`, the CSP gets `connect-src 'self'`, and the privacy policy gets its section
on them (it always describes exactly what the build does). Neither product sets cookies; the imprint and
privacy pages do not load them. Enable both products once in the Vercel dashboard of the landing project,
otherwise the two paths answer 404. Not on the docs site and never in the app. The plan limits (Hobby: 50,000
events a month, Speed Insights 10,000 events in 30 days, collection pauses above that) are on Vercel's
pricing pages for [Web Analytics](https://vercel.com/docs/analytics/limits-and-pricing) and
[Speed Insights](https://vercel.com/docs/speed-insights/limits-and-pricing).

## Unlisted until launch

`"listed": false` in `site.config.json` keeps the page out of search engines three ways: a
`<meta name="robots" content="noindex, nofollow">`, an `X-Robots-Tag` header (in the generated
`vercel.json`) and a `robots.txt` that disallows everything. Nothing in the app or the repository links
to the page. **To launch, set `"listed": true`**, deploy, and set `SELFBOUND_SITE_URL` for the build so
canonical, link-preview tags and the sitemap are written. `SELFBOUND_SITE_LISTED=1` overrides the setting for a
single build.

## Deploy

A separate Vercel project that only serves the built files (no build on Vercel, not connected to the Git repository):

```sh
node tooling/deploy-site.mjs           # preview deployment, prints the preview URL
node tooling/deploy-site.mjs --prod    # production deployment (to the project's domains)
node tooling/deploy-site.mjs --build   # build into deploy/site/ only
```

The landing page project serves the site's own domains. Vercel Authentication on it covers
previews only ("all except custom domains"), so the custom domains and the production `vercel.app` address are
public but unlisted (see above). Moving a domain between projects is a manual step (dashboard or
`POST /v1/projects/<project>/domains/<domain>/move`); the deploy script never touches domains or DNS.

Needs `vercelScope` and `siteVercelProject` (optional: `siteUrl`) in the instance settings, see
[docs/operations.md](../docs/operations.md#instance-settings).

## Checks

`pnpm --filter @selfbound/site typecheck` and `pnpm --filter @selfbound/site test` (both also run as part of the
root `pnpm typecheck` and `pnpm test`).
