// Build-time settings of the landing page. One switch decides whether search engines may list it
// (`listed` in site.config.json, or SELFBOUND_SITE_LISTED=1 for a single build): off means a robots meta
// tag, an X-Robots-Tag header and a robots.txt that disallows everything. The same switch decides
// whether Vercel Web Analytics and Speed Insights are loaded, so nothing is collected before launch.
import type { Plugin } from 'vite';
// @ts-expect-error plain .mjs without types, shared with docs-site/
import { fillLegal } from '../tooling/site-legal.mjs';
import { envVar } from '../tooling/lib/env.mjs';

export interface Legal {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
  phone?: string;
}

export interface SiteConfig {
  listed: boolean;
  github: string;
  docs: string;
}

export interface SiteSettings extends SiteConfig {
  /** Public origin for canonical and link-preview URLs, from SELFBOUND_SITE_URL; without it those tags are left out */
  url?: string;
  /** Vercel Web Analytics and Speed Insights: on exactly when the site is listed */
  analytics: boolean;
  /** Operator details of the imprint, from outside the repository (tooling/site-legal.mjs) */
  legal: Legal;
}

const NO_LEGAL: Legal = { name: '', street: '', postalCode: '', city: '', country: '', email: '' };

export function siteSettings(config: SiteConfig, env: Record<string, string | undefined>, legal: Legal = NO_LEGAL): SiteSettings {
  const url = envVar('SITE_URL', env)?.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^/\s]+$/.test(url)) throw new Error(`SELFBOUND_SITE_URL must be an origin like https://example.com, got "${url}"`);
  const flag = envVar('SITE_LISTED', env)?.trim().toLowerCase();
  const listed = flag ? ['1', 'true', 'yes'].includes(flag) : config.listed;
  return { ...config, listed, url: url || undefined, analytics: listed, legal };
}

const URL_LINE = /^[ \t]*<[^>]*__SITE_URL__[^>]*>\n?/gm;

// Official scripts of the two Vercel products. Same-origin paths that Vercel serves once the products
// are enabled for the project; with the script-src 'self' policy no inline script is needed.
const ANALYTICS_TAGS = '<script defer src="/_vercel/insights/script.js"></script>\n    <script defer src="/_vercel/speed-insights/script.js"></script>\n    ';
const IF_ANALYTICS = /<!--if:analytics-->([\s\S]*?)<!--\/if:analytics-->\n?/g;

/**
 * Fills the placeholders of the pages: absolute URLs (or no tag at all), the robots tag, the imprint
 * details, and the analytics scripts (<!--analytics-->, only with `scripts`; the dev server leaves them out)
 * and the privacy paragraphs about them (<!--if:analytics-->…<!--/if:analytics-->, always follow the setting,
 * so the text never describes more or less than the build does).
 */
export function siteHtml(html: string, s: SiteSettings, { scripts = true } = {}): string {
  const out = s.url ? html.replaceAll('__SITE_URL__', s.url) : html.replace(URL_LINE, '');
  const robots = s.listed ? '' : '<meta name="robots" content="noindex, nofollow" />\n    ';
  return fillLegal(
    out
      .replace('<!--robots-->', robots)
      .replace('<!--analytics-->', s.analytics && scripts ? ANALYTICS_TAGS : '')
      .replace(IF_ANALYTICS, s.analytics ? '$1' : '')
      .replaceAll('__GITHUB__', s.github)
      .replaceAll('__DOCS__', s.docs),
    s.legal,
  );
}

export function robotsTxt(s: SiteSettings): string {
  if (!s.listed) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\n${s.url ? `\nSitemap: ${s.url}/sitemap.xml\n` : ''}`;
}

export function sitemapXml(s: SiteSettings): string | undefined {
  if (!s.listed || !s.url) return undefined;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${s.url}/</loc></url></urlset>\n`;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The two scripts report to the same origin (/_vercel/insights/…, /_vercel/speed-insights/…).
const CSP_ANALYTICS = CSP.replace("img-src", "connect-src 'self'; img-src");

export function vercelConfig(s: SiteSettings) {
  const all = [
    { key: 'Content-Security-Policy', value: s.analytics ? CSP_ANALYTICS : CSP },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    ...(s.listed ? [] : [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]),
  ];
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    cleanUrls: true,
    trailingSlash: false,
    headers: [
      { source: '/(.*)', headers: all },
      { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ],
  };
}

export function sitePlugin(s: SiteSettings): Plugin {
  return {
    name: 'selfbound-site',
    transformIndexHtml: { order: 'pre', handler: (html, ctx) => siteHtml(html, s, { scripts: !ctx.server }) },
    generateBundle() {
      const emit = (fileName: string, source: string) => this.emitFile({ type: 'asset', fileName, source });
      emit('robots.txt', robotsTxt(s));
      emit('vercel.json', `${JSON.stringify(vercelConfig(s), null, 2)}\n`);
      const sitemap = sitemapXml(s);
      if (sitemap) emit('sitemap.xml', sitemap);
    },
    configureServer: (server) =>
      void server.middlewares.use((req, res, next) => {
        if (req.url === '/robots.txt') {
          res.setHeader('content-type', 'text/plain');
          res.end(robotsTxt(s));
        } else next();
      }),
  };
}
