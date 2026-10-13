import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Preloads the font for the first list (Inter latin) in parallel with JS and CSS. */
export function preloadFont(): Plugin {
  return {
    name: 'xlr8-preload-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find((f) => /inter-latin-wght-normal-[\w-]+\.woff2$/.test(f));
        if (!file) return [];
        return [{ tag: 'link', attrs: { rel: 'preload', href: `/${file}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head-prepend' }];
      },
    },
  };
}

/**
 * Start page and sign-in live in welcome.html, a separate build (vite.welcome.config.ts). In
 * production Vercel routes requests (deploy/web/vercel.json); locally the dev and preview servers
 * serve welcome.html under /welcome and /sign-in. Locally `/` stays the app.
 */
export function welcomeRoutes(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const m = req.url?.match(/^\/(?:sign-in|welcome)\/?(\?.*)?$/);
    if (m) req.url = `/welcome.html${m[1] ?? ''}`;
    next();
  };
  return {
    name: 'xlr8-welcome-routes',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

/**
 * With Clerk (production): opening an app URL without the "signed in" marker cookie goes straight to
 * sign-in and back to the same URL afterwards, without loading the app first. One comparison on the
 * cookie string, no measurable startup cost. Not included with the test sign-in (local, tests).
 */
export function signedOutGuard(on: boolean): Plugin {
  return {
    name: 'xlr8-signed-out-guard',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        if (!on || !ctx.filename.endsWith('index.html')) return [];
        const code = `if(!/(?:^|; )xlr8_signed_in=1/.test(document.cookie)){var p=location.pathname+location.search+location.hash;location.replace('/sign-in'+(p==='/'?'':'?redirect_url='+encodeURIComponent(p)))}`;
        return [{ tag: 'script', children: code, injectTo: 'head-prepend' }];
      },
    },
  };
}

/**
 * Service worker (push only) and version file as /sw.js and /version.json. The build id is in sw.js
 * (so the browser detects every new version), in version.json and as __XLR8_BUILD__ in the app code
 * (compared after a deploy, app/src/lib/pwa/index.ts).
 */
export function pwaFiles(build: string): Plugin {
  const source = fileURLToPath(new URL('./sw/sw.js', import.meta.url));
  return {
    name: 'xlr8-pwa-files',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(source, 'utf8').replaceAll('__XLR8_BUILD__', build) });
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build })}\n` });
    },
  };
}

/** Tags whose value must be an absolute URL: link previews (og:image, twitter:image), og:url, canonical. */
const URL_TAG = /[ \t]*<(?:meta\s+(?:property|name)="(?:og:url|og:image|twitter:image)"\s+content|link\s+rel="canonical"\s+href)="([^"]*)"[^>]*>\n?/g;
/** Details of og:image, meaningless without it. */
const IMAGE_DETAIL_TAG = /[ \t]*<meta\s+property="og:image:(?:width|height|alt|type)"[^>]*>\n?/g;

/**
 * Makes the link-preview URLs in an HTML page absolute. The page writes them as paths
 * (`content="/brand/og-image.png"`); with `base` (e.g. https://xlr8.example.com) they become
 * absolute. Without `base` the tags are removed, together with og:image:width/height/alt: crawlers
 * need absolute URLs, so no tag is better than a wrong one.
 */
export function publicUrlHtml(html: string, base: string | undefined): string {
  const origin = base?.trim().replace(/\/+$/, '');
  if (!origin) return html.replace(URL_TAG, '').replace(IMAGE_DETAIL_TAG, '');
  return html.replace(URL_TAG, (tag, value: string) => {
    if (/^[a-z][\w+.-]*:/i.test(value)) return tag;
    const path = value.startsWith('/') ? value : `/${value}`;
    return tag.replace(`"${value}"`, `"${origin}${path}"`);
  });
}

/**
 * Build-time public URL of the instance (`XLR8_PUBLIC_URL`, e.g. https://xlr8.example.com) for the
 * absolute URLs in index.html and welcome.html, see publicUrlHtml().
 */
export function publicUrl(base: string | undefined): Plugin {
  if (base && !/^https?:\/\/[^/\s]+\/?$/.test(base.trim())) throw new Error(`XLR8_PUBLIC_URL must be an origin like https://xlr8.example.com, got "${base}"`);
  return {
    name: 'xlr8-public-url',
    transformIndexHtml: { order: 'pre', handler: (html) => publicUrlHtml(html, base) },
  };
}
