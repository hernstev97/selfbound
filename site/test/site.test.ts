// The "listed" switch and the placeholders of index.html.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { robotsTxt, siteHtml, siteSettings, sitemapXml, vercelConfig, type SiteConfig } from '../site.plugin.ts';

const config: SiteConfig = { listed: false, github: 'https://github.com/example/xlr8', docs: 'https://docs.example.com' };
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const headerValue = (cfg: ReturnType<typeof vercelConfig>, key: string) => cfg.headers[0]!.headers.find((h) => h.key === key)?.value;

describe('siteSettings', () => {
  it('is unlisted by default, XLR8_SITE_LISTED overrides the config for one build', () => {
    expect(siteSettings(config, {}).listed).toBe(false);
    expect(siteSettings(config, { XLR8_SITE_LISTED: '1' }).listed).toBe(true);
    expect(siteSettings({ ...config, listed: true }, {}).listed).toBe(true);
    expect(siteSettings({ ...config, listed: true }, { XLR8_SITE_LISTED: '0' }).listed).toBe(false);
  });
  it('takes the public URL as an origin only', () => {
    expect(siteSettings(config, { XLR8_SITE_URL: 'https://example.com/' }).url).toBe('https://example.com');
    expect(() => siteSettings(config, { XLR8_SITE_URL: 'example.com' })).toThrow('XLR8_SITE_URL');
    expect(() => siteSettings(config, { XLR8_SITE_URL: 'https://example.com/x' })).toThrow('XLR8_SITE_URL');
  });
});

describe('unlisted (default)', () => {
  const s = siteSettings(config, {});
  it('blocks crawlers three ways', () => {
    expect(siteHtml(html, s)).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(robotsTxt(s)).toBe('User-agent: *\nDisallow: /\n');
    expect(headerValue(vercelConfig(s), 'X-Robots-Tag')).toBe('noindex, nofollow');
    expect(sitemapXml(s)).toBeUndefined();
  });
});

describe('listed', () => {
  const s = siteSettings({ ...config, listed: true }, { XLR8_SITE_URL: 'https://example.com' });
  it('lets crawlers in', () => {
    expect(siteHtml(html, s)).not.toContain('noindex');
    expect(robotsTxt(s)).toContain('Allow: /');
    expect(robotsTxt(s)).toContain('Sitemap: https://example.com/sitemap.xml');
    expect(headerValue(vercelConfig(s), 'X-Robots-Tag')).toBeUndefined();
    expect(sitemapXml(s)).toContain('<loc>https://example.com/</loc>');
  });
});

describe('index.html', () => {
  it('leaves link-preview tags out without a public URL, makes them absolute with one', () => {
    const without = siteHtml(html, siteSettings(config, {}));
    expect(without).not.toMatch(/__SITE_URL__|og:image"|og:url|twitter:image|rel="canonical"/);
    const withUrl = siteHtml(html, siteSettings(config, { XLR8_SITE_URL: 'https://example.com' }));
    expect(withUrl).toContain('<meta property="og:image" content="https://example.com/brand/og.png" />');
    expect(withUrl).toContain('<link rel="canonical" href="https://example.com/" />');
  });
  it('fills in the repository and docs links and leaves no placeholder behind', () => {
    const out = siteHtml(html, siteSettings(config, { XLR8_SITE_URL: 'https://example.com' }));
    expect(out).toContain('href="https://github.com/example/xlr8"');
    expect(out).toContain('href="https://docs.example.com"');
    expect(out).not.toMatch(/__[A-Z_]+__|<!--robots-->/);
  });
  it('has no inline script or style, so the strict CSP holds', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle="|<style/);
  });
  it('has one h1 and keeps the credit line', () => {
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('Product, design and review by <strong>Steven Hernandez</strong>');
  });
});
