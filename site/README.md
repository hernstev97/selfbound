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
  2560 px wide, dark and light. `public/` holds copies of the logo, mark and icons from
  `app/public/`; refresh them there when the brand files change.

## Unlisted until launch

`"listed": false` in `site.config.json` keeps the page out of search engines three ways: a
`<meta name="robots" content="noindex, nofollow">`, an `X-Robots-Tag` header (in the generated
`vercel.json`) and a `robots.txt` that disallows everything. Nothing in the app or the repository links
to the page. **To launch, set `"listed": true`**, deploy, and set `XLR8_SITE_URL` for the build so
canonical, link-preview tags and the sitemap are written. `XLR8_SITE_LISTED=1` overrides the setting for a
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
