// Build-time settings of the landing page. One switch decides whether search engines may list it
// (`listed` in site.config.json, or XLR8_SITE_LISTED=1 for a single build): off means a robots meta
// tag, an X-Robots-Tag header and a robots.txt that disallows everything.
import type { Plugin } from 'vite';

export interface SiteConfig {
  listed: boolean;
  github: string;
  docs: string;
}

export interface SiteSettings extends SiteConfig {
  /** Public origin for canonical and link-preview URLs, from XLR8_SITE_URL; without it those tags are left out */
  url?: string;
}

export function siteSettings(config: SiteConfig, env: Record<string, string | undefined>): SiteSettings {
  const url = env.XLR8_SITE_URL?.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^/\s]+$/.test(url)) throw new Error(`XLR8_SITE_URL must be an origin like https://example.com, got "${url}"`);
  const flag = env.XLR8_SITE_LISTED?.trim().toLowerCase();
  const listed = flag ? ['1', 'true', 'yes'].includes(flag) : config.listed;
  return { ...config, listed, url: url || undefined };
}

const URL_LINE = /^[ \t]*<[^>]*__SITE_URL__[^>]*>\n?/gm;

/** Fills the placeholders in index.html: absolute URLs (or no tag at all) and the robots tag. */
export function siteHtml(html: string, s: SiteSettings): string {
  const out = s.url ? html.replaceAll('__SITE_URL__', s.url) : html.replace(URL_LINE, '');
  const robots = s.listed ? '' : '<meta name="robots" content="noindex, nofollow" />\n    ';
  return out.replace('<!--robots-->', robots).replaceAll('__GITHUB__', s.github).replaceAll('__DOCS__', s.docs);
}

export function robotsTxt(s: SiteSettings): string {
  if (!s.listed) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\n${s.url ? `\nSitemap: ${s.url}/sitemap.xml\n` : ''}`;
}

export function sitemapXml(s: SiteSettings): string | undefined {
  if (!s.listed || !s.url) return undefined;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${s.url}/</loc></url></urlset>\n`;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function vercelConfig(s: SiteSettings) {
  const all = [
    { key: 'Content-Security-Policy', value: CSP },
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
    transformIndexHtml: { order: 'pre', handler: (html) => siteHtml(html, s) },
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
