// The "listed" switch and the placeholders of index.html.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { robotsTxt, siteHtml, siteSettings, sitemapXml, vercelConfig, type Legal, type SiteConfig } from '../site.plugin.ts';

const config: SiteConfig = { listed: false, github: 'https://github.com/example/selfbound', docs: 'https://docs.example.com' };
const page = (name: string) => readFileSync(new URL(`../${name}.html`, import.meta.url), 'utf8');
const html = page('index');
const legal: Legal = { name: 'Erika Beispiel', street: 'Musterweg 1', postalCode: '12345', city: 'Musterstadt', country: 'Deutschland', email: 'kontakt@example.com' };
const ANALYTICS_SCRIPTS = ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js'];
const headerValue = (cfg: ReturnType<typeof vercelConfig>, key: string) => cfg.headers[0]!.headers.find((h) => h.key === key)?.value;

describe('siteSettings', () => {
  it('is unlisted by default, SELFBOUND_SITE_LISTED overrides the config for one build', () => {
    expect(siteSettings(config, {}).listed).toBe(false);
    expect(siteSettings(config, { SELFBOUND_SITE_LISTED: '1' }).listed).toBe(true);
    expect(siteSettings({ ...config, listed: true }, {}).listed).toBe(true);
    expect(siteSettings({ ...config, listed: true }, { SELFBOUND_SITE_LISTED: '0' }).listed).toBe(false);
  });
  it('takes the public URL as an origin only', () => {
    expect(siteSettings(config, { SELFBOUND_SITE_URL: 'https://example.com/' }).url).toBe('https://example.com');
    expect(() => siteSettings(config, { SELFBOUND_SITE_URL: 'example.com' })).toThrow('SELFBOUND_SITE_URL');
    expect(() => siteSettings(config, { SELFBOUND_SITE_URL: 'https://example.com/x' })).toThrow('SELFBOUND_SITE_URL');
  });
});

describe('siteSettings, old variable names', () => {
  // legacy-xlr8: the old names are read as a fallback until the follow-up removes it
  const old = { XLR8_SITE_URL: 'https://example.com/', XLR8_SITE_LISTED: '1' };
  it('still reads them, and the new names win', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(siteSettings(config, old).url).toBe('https://example.com');
    expect(siteSettings(config, old).listed).toBe(true);
    expect(siteSettings(config, { ...old, SELFBOUND_SITE_URL: 'https://new.example.com', SELFBOUND_SITE_LISTED: '0' })).toMatchObject({ url: 'https://new.example.com', listed: false });
    vi.restoreAllMocks();
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
  const s = siteSettings({ ...config, listed: true }, { SELFBOUND_SITE_URL: 'https://example.com' });
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
    const withUrl = siteHtml(html, siteSettings(config, { SELFBOUND_SITE_URL: 'https://example.com' }));
    expect(withUrl).toContain('<meta property="og:image" content="https://example.com/brand/social.png" />');
    expect(withUrl).toContain('<link rel="canonical" href="https://example.com/" />');
  });
  it('fills in the repository and docs links and leaves no placeholder behind', () => {
    const out = siteHtml(html, siteSettings(config, { SELFBOUND_SITE_URL: 'https://example.com' }));
    expect(out).toContain('href="https://github.com/example/selfbound"');
    expect(out).toContain('href="https://docs.example.com"');
    expect(out).not.toMatch(/__[A-Z_]+__|<!--robots-->/);
  });
  it('lets the strict CSP play the self-hosted demo video', () => {
    expect(headerValue(vercelConfig(siteSettings(config, {}, legal)), 'Content-Security-Policy')).toContain("media-src 'self'");
  });
  it('has no inline script or style, so the strict CSP holds', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle="|<style/);
  });
  it('names no competitor (the comparison is about "most popular trackers", basis in CLAIMS.md)', () => {
    expect(html).not.toMatch(/linear|jira|asana|clickup|trello/i);
  });
  it('has one h1 and keeps the credit line', () => {
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('Product, design and review by <strong>Steven Hernandez</strong>');
  });
});

describe('visitor statistics (Vercel Web Analytics and Speed Insights)', () => {
  const unlisted = siteSettings(config, {}, legal);
  const listed = siteSettings({ ...config, listed: true }, {}, legal);
  const connect = (cfg: ReturnType<typeof vercelConfig>) => headerValue(cfg, 'Content-Security-Policy')!.includes("connect-src 'self'");

  it('loads nothing while the site is unlisted', () => {
    const out = siteHtml(html, unlisted);
    for (const src of ANALYTICS_SCRIPTS) expect(out).not.toContain(src);
    expect(out).not.toMatch(/<!--analytics-->/);
    expect(connect(vercelConfig(unlisted))).toBe(false);
  });
  it('loads both official scripts, same-origin and without inline code, once the site is listed', () => {
    const out = siteHtml(html, listed);
    for (const src of ANALYTICS_SCRIPTS) expect(out).toContain(`<script defer src="${src}"></script>`);
    expect(out.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();
    expect(connect(vercelConfig(listed))).toBe(true);
    expect(headerValue(vercelConfig(listed), 'Content-Security-Policy')).toContain("script-src 'self'");
  });
  it('leaves the scripts out of the dev server, but keeps the privacy text in step with the setting', () => {
    expect(siteHtml(html, listed, { scripts: false })).not.toContain('/_vercel/');
    expect(siteHtml(page('datenschutz'), listed, { scripts: false })).toContain('Vercel Web Analytics');
  });
  it('describes the statistics in the privacy policy exactly when they run, and only on the landing page', () => {
    expect(siteHtml(page('datenschutz'), unlisted)).not.toMatch(/Web Analytics|Speed Insights|Besucherstatistik/);
    const withStats = siteHtml(page('datenschutz'), listed);
    expect(withStats).toMatch(/Besucherstatistik/);
    expect(withStats).not.toMatch(/<!--\/?if:analytics-->/);
    for (const name of ['impressum', 'datenschutz']) expect(siteHtml(page(name), listed)).not.toContain('/_vercel/');
  });
});

describe('imprint and privacy pages', () => {
  const pages = ['impressum', 'datenschutz'];
  const s = siteSettings({ ...config, listed: true }, { SELFBOUND_SITE_URL: 'https://example.com' }, legal);

  it('hold no operator details in the source, only placeholders for the build', () => {
    expect(page('impressum')).toContain('__LEGAL_ADDRESS__');
    expect(page('datenschutz')).toContain('__LEGAL_ADDRESS_INLINE__');
    expect(page('impressum') + page('datenschutz')).not.toMatch(/Steven Hernandez[,<]|mailto:[^"_]/);
  });
  it('fill in the operator and leave no placeholder behind', () => {
    for (const name of pages) {
      const out = siteHtml(page(name), s);
      expect(out).toContain('Erika Beispiel');
      expect(out).toContain('12345 Musterstadt');
      expect(out).toContain('href="mailto:kontakt@example.com"');
      expect(out).not.toMatch(/__[A-Z_]+__|<!--robots-->|<!--analytics-->/);
    }
  });
  it('escape the operator details', () => {
    const out = siteHtml(page('impressum'), siteSettings(config, {}, { ...legal, name: 'A & <B>' }));
    expect(out).toContain('A &amp; &lt;B&gt;');
  });
  it('have no inline script or style, a German lang attribute and one h1', () => {
    for (const name of pages) {
      expect(page(name)).not.toMatch(/<script|\sstyle="|<style/);
      expect(page(name)).toContain('<html lang="de">');
      expect(page(name).match(/<h1[ >]/g)).toHaveLength(1);
    }
  });
  it('are linked from the footer of every page', () => {
    for (const name of ['index', ...pages]) {
      expect(page(name)).toContain('href="/impressum"');
      expect(page(name)).toContain('href="/datenschutz"');
    }
  });
  it('name the supervisory authority, the controller and the data subject rights', () => {
    const out = siteHtml(page('datenschutz'), s);
    expect(out).toMatch(/Art\. 77 DSGVO/);
    expect(out).toContain('Landesbeauftragte für Datenschutz');
    expect(out).toContain('Art. 21');
  });
});
