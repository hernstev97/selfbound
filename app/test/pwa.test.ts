import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deviceName } from '../src/lib/pwa/push.ts';
import { issueFromShare, readShare, shareRequestId } from '../src/lib/pwa/share.ts';

// Installable app: parse shared data, device name, manifest.

describe('share to the inbox', () => {
  it('reads only /share with content', () => {
    expect(readShare(new URL('https://xlr8.example.com/share?title=A&text=B&url='))).toEqual({ title: 'A', text: 'B', url: '' });
    expect(readShare(new URL('https://xlr8.example.com/share?title=&text='))).toBeNull();
    expect(readShare(new URL('https://xlr8.example.com/inbox?title=A'))).toBeNull();
  });

  it('Android puts the link in the text: title without the link, link in the description', () => {
    expect(issueFromShare({ title: '', text: 'Interesting article https://example.com/a?b=1', url: '' })).toEqual({
      title: 'Interesting article',
      description: 'https://example.com/a?b=1',
    });
  });

  it('only a link: title from host and path', () => {
    expect(issueFromShare({ title: '', text: 'https://www.example.com/docs/x', url: '' })).toEqual({
      title: 'example.com/docs/x',
      description: 'https://www.example.com/docs/x',
    });
  });

  it('title and multi-line text: the title stays, the text goes into the description', () => {
    expect(issueFromShare({ title: 'Note', text: 'Line 1\nLine 2', url: 'https://example.com' })).toEqual({
      title: 'Note',
      description: 'Line 1\nLine 2\n\nhttps://example.com',
    });
  });

  it('shortens titles that are too long', () => {
    const { title } = issueFromShare({ title: 'x'.repeat(600), text: '', url: '' }, 500);
    expect(title).toHaveLength(500);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('share request id', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  };
  const shared = { title: '', text: 'Article https://example.com', url: '' };

  it('same content within 10 minutes: same id, also across a window boundary', async () => {
    const storage = memory();
    const t = Date.UTC(2026, 9, 11, 12, 9, 59);
    const first = await shareRequestId(shared, t, storage);
    expect(await shareRequestId(shared, t + 2000, storage)).toBe(first);
    expect(await shareRequestId(shared, t + 9 * 60_000, storage)).toBe(first);
  });

  it('after 10 minutes or with other content: new id', async () => {
    const storage = memory();
    const t = Date.UTC(2026, 9, 11, 12, 0, 0);
    const first = await shareRequestId(shared, t, storage);
    expect(await shareRequestId(shared, t + 11 * 60_000, storage)).not.toBe(first);
    expect(await shareRequestId({ ...shared, text: 'Other' }, t, storage)).not.toBe(first);
  });
});

describe('device name', () => {
  it('detects OS and browser', () => {
    expect(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Windows · Edge');
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Linux · Firefox');
  });
});

describe('manifest', () => {
  it('installable with share target, shortcuts and a maskable icon', () => {
    const manifest = JSON.parse(readFileSync(new URL('../public/site.webmanifest', import.meta.url), 'utf8'));
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', share_target: { action: '/share', method: 'GET' } });
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  });
});
