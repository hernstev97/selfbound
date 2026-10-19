// Absolute URLs in index.html and welcome.html come from SELFBOUND_PUBLIC_URL at build time.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aliasViteVar, buildVar, publicUrl, publicUrlHtml } from '../vite.plugins.ts';

const page = `<head>
    <link rel="canonical" href="/" />
    <meta property="og:url" content="/" />
    <meta property="og:title" content="Selfbound" />
    <meta property="og:image" content="/brand/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:alt" content="Start page" />
    <meta name="twitter:image" content="/brand/og-image.png" />
  </head>`;

describe('publicUrlHtml', () => {
  it('makes the paths absolute with the public URL', () => {
    const html = publicUrlHtml(page, 'https://selfbound.example.com/');
    expect(html).toContain('<link rel="canonical" href="https://selfbound.example.com/" />');
    expect(html).toContain('<meta property="og:url" content="https://selfbound.example.com/" />');
    expect(html).toContain('<meta property="og:image" content="https://selfbound.example.com/brand/og-image.png" />');
    expect(html).toContain('<meta name="twitter:image" content="https://selfbound.example.com/brand/og-image.png" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:title" content="Selfbound" />');
  });

  it('drops the tags without a public URL, other tags stay', () => {
    const html = publicUrlHtml(page, undefined);
    expect(html).not.toMatch(/canonical|og:url|og:image|twitter:image/);
    expect(html).toContain('<meta property="og:title" content="Selfbound" />');
  });

  it('leaves URLs that are already absolute alone', () => {
    const html = publicUrlHtml('<meta property="og:image" content="https://cdn.example.net/a.png" />', 'https://selfbound.example.com');
    expect(html).toBe('<meta property="og:image" content="https://cdn.example.net/a.png" />');
  });

  it('rejects a public URL that is not an origin', () => {
    expect(() => publicUrl('selfbound.example.com')).toThrow('SELFBOUND_PUBLIC_URL');
    expect(() => publicUrl('https://selfbound.example.com/app')).toThrow('SELFBOUND_PUBLIC_URL');
    expect(() => publicUrl('https://selfbound.example.com')).not.toThrow();
  });

  it('index.html and welcome.html carry no hard-coded host', () => {
    for (const file of ['../index.html', '../welcome.html']) {
      const html = readFileSync(new URL(file, import.meta.url), 'utf8');
      // The license text on gnu.org (sign-in footer) is the one external link.
      expect(html, file).not.toMatch(/(content|href)="https?:\/\/(?!www\.gnu\.org\/licenses\/)/);
      expect(publicUrlHtml(html, undefined), file).not.toMatch(/<(meta|link)[^>]*(og:image|twitter:image|og:url|"canonical")/);
    }
  });
});

// legacy-xlr8: the old build variable names keep working, with a warning
describe('build variables', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the new name wins and warns about nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildVar('PUBLIC_URL', { SELFBOUND_PUBLIC_URL: 'https://a.example', XLR8_PUBLIC_URL: 'https://b.example' })).toBe('https://a.example'); // legacy-xlr8
    expect(warn).not.toHaveBeenCalled();
  });

  it('the old name still works and warns once, without the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildVar('BUILD_ID', { XLR8_BUILD_ID: 'secret-id' })).toBe('secret-id'); // legacy-xlr8
    expect(buildVar('BUILD_ID', { XLR8_BUILD_ID: 'secret-id' })).toBe('secret-id'); // legacy-xlr8
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('SELFBOUND_BUILD_ID');
    expect(String(warn.mock.calls[0][0])).not.toContain('secret-id');
    expect(buildVar('NOTHING', {})).toBeUndefined();
  });

  it('the old client variables are copied under the new name for Vite', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target: NodeJS.ProcessEnv = {};
    aliasViteVar('TEST', { VITE_XLR8_TEST: '1' }, target); // legacy-xlr8
    expect(target.VITE_SELFBOUND_TEST).toBe('1');
    expect(warn).toHaveBeenCalledTimes(1);
    // Both set: the new one stays.
    const both: NodeJS.ProcessEnv = {};
    aliasViteVar('BRANCH_PREFIX', { VITE_SELFBOUND_BRANCH_PREFIX: 'a', VITE_XLR8_BRANCH_PREFIX: 'b' }, both); // legacy-xlr8
    expect(both.VITE_SELFBOUND_BRANCH_PREFIX).toBeUndefined();
  });
});
