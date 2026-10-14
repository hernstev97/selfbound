// Absolute URLs in index.html and welcome.html come from XLR8_PUBLIC_URL at build time.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { publicUrl, publicUrlHtml } from '../vite.plugins.ts';

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
    expect(() => publicUrl('selfbound.example.com')).toThrow('XLR8_PUBLIC_URL');
    expect(() => publicUrl('https://selfbound.example.com/app')).toThrow('XLR8_PUBLIC_URL');
    expect(() => publicUrl('https://selfbound.example.com')).not.toThrow();
  });

  it('index.html and welcome.html carry no hard-coded host', () => {
    for (const file of ['../index.html', '../welcome.html']) {
      const html = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(html, file).not.toMatch(/(content|href)="https?:\/\//);
      expect(publicUrlHtml(html, undefined), file).not.toMatch(/<(meta|link)[^>]*(og:image|twitter:image|og:url|"canonical")/);
    }
  });
});
