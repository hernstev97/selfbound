import { describe, expect, test } from 'vitest';
import { decodeEntities, downloadMedia, EmbedFetchError, fetchEmbedMeta, parseSyndication, parseXOembed, parseYoutube, safeGet, syndicationToken, type FetchLike } from '../../convex/lib/embeds';
import { embedLineStart, parseEmbedUrl, parseStart } from '../../convex/shared/embeds';

// Embeds: recognizing links, parsing the provider answers (synthetic data in the shape of the
// real answers), the rules of every outgoing request.

describe('recognizing links', () => {
  test('YouTube in all common forms', () => {
    const want = { provider: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
    for (const raw of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseEmbedUrl(raw), raw).toMatchObject(want);
    }
  });

  test('YouTube start time', () => {
    expect(parseEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=90')?.start).toBe(90);
    expect(parseEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')?.start).toBe(90);
    expect(parseEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=5')?.start).toBe(5);
    expect(parseEmbedUrl('https://youtu.be/dQw4w9WgXcQ')?.start).toBeUndefined();
    expect(parseStart('1h0m5s')).toBe(3605);
    expect(parseStart('abc')).toBeUndefined();
    expect(parseStart('0')).toBeUndefined();
  });

  test('X and Twitter posts', () => {
    const want = { provider: 'x', id: '1585341984679469056', url: 'https://x.com/demo_user/status/1585341984679469056' };
    for (const raw of [
      'https://x.com/demo_user/status/1585341984679469056',
      'https://twitter.com/demo_user/status/1585341984679469056?s=20&t=abc',
      'https://mobile.twitter.com/demo_user/status/1585341984679469056',
      'https://www.x.com/demo_user/status/1585341984679469056/photo/1',
    ]) {
      expect(parseEmbedUrl(raw), raw).toMatchObject(want);
    }
    expect(parseEmbedUrl('https://x.com/i/web/status/20')).toMatchObject({ provider: 'x', id: '20', url: 'https://x.com/i/web/status/20' });
  });

  test('everything else stays a link', () => {
    for (const raw of [
      'http://youtu.be/dQw4w9WgXcQ', // not https
      'https://youtu.be/short',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ%0A',
      'https://www.youtube.com/playlist?list=PL12345678901',
      'https://www.youtube.com/@channel',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://user:pw@youtu.be/dQw4w9WgXcQ',
      'https://youtu.be:444/dQw4w9WgXcQ',
      'https://x.com/demo_user',
      'https://x.com/demo_user/status/abc',
      'https://x.com/demo_user/likes',
      'https://example.com/x.com/a/status/1',
      'not a url',
    ]) {
      expect(parseEmbedUrl(raw), raw).toBeNull();
    }
  });

  test('start of the first line that begins with an embeddable link', () => {
    expect(embedLineStart('text\nhttps://youtu.be/abc')).toBe(5);
    expect(embedLineStart('  <https://x.com/a/status/1>')).toBe(0);
    expect(embedLineStart('a\n\n[a](https://twitter.com/a/status/1)')).toBe(3);
    expect(embedLineStart('https://example.com/ and\nhttps://youtu.be/abc')).toBe(25);
    expect(embedLineStart('see https://youtu.be/abc')).toBeUndefined();
    expect(embedLineStart('    https://youtu.be/abc')).toBeUndefined();
    expect(embedLineStart('https://example.com/')).toBeUndefined();
    expect(embedLineStart('https://youtu.be')).toBeUndefined();
    expect(embedLineStart('nothing here')).toBeUndefined();
    // case-insensitive host, `from` skips earlier lines
    expect(embedLineStart('a\nhttps://YouTube.com/watch?v=dQw4w9WgXcQ')).toBe(2);
    expect(embedLineStart('https://youtu.be/abc\nhttps://youtu.be/def', 1)).toBe(21);
  });
});

describe('answers of the providers', () => {
  test('YouTube oEmbed', () => {
    const meta = parseYoutube({ title: 'Demo video', author_name: 'Demo channel', author_url: 'https://www.youtube.com/@demo', thumbnail_url: 'https://evil.example/x.jpg' }, 'dQw4w9WgXcQ');
    expect(meta).toMatchObject({ status: 'ok', title: 'Demo video', author: 'Demo channel', authorUrl: 'https://www.youtube.com/@demo' });
    // The thumbnail comes from the video ID, never from the answer.
    expect(meta.sources).toEqual([{ slot: 'thumb', kind: 'thumb', url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 360 }]);
    expect(parseYoutube({ title: 'x', author_url: 'https://evil.example/' }, 'dQw4w9WgXcQ').authorUrl).toBeUndefined();
    expect(() => parseYoutube('nope', 'dQw4w9WgXcQ')).toThrow(EmbedFetchError);
  });

  const post = {
    __typename: 'Tweet',
    id_str: '1585341984679469056',
    created_at: '2022-10-26T18:45:58.000Z',
    text: 'Fish &amp; chips https://t.co/AAAA and more https://t.co/BBBB',
    entities: { urls: [{ url: 'https://t.co/AAAA', display_url: 'example.com/post' }], media: [{ url: 'https://t.co/BBBB' }] },
    user: { name: 'Demo Author', screen_name: 'demo_user', profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
    mediaDetails: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/ABC.jpg', original_info: { width: 1200, height: 800 }, ext_alt_text: 'A demo picture' },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg', original_info: { width: 1920, height: 1080 } },
      { type: 'photo', media_url_https: 'https://evil.example/ABC.jpg' },
    ],
  };

  test('X syndication: text, author, date, media from pbs.twimg.com only', () => {
    const meta = parseSyndication(post, '1585341984679469056')!;
    expect(meta).toMatchObject({ status: 'ok', author: 'Demo Author', handle: 'demo_user', createdAt: Date.parse('2022-10-26T18:45:58.000Z') });
    // Media link removed, t.co replaced by the shown address, entities decoded.
    expect(meta.text).toBe('Fish & chips example.com/post and more');
    expect(meta.sources.map((s) => [s.slot, s.kind, s.url])).toEqual([
      ['avatar', 'avatar', 'https://pbs.twimg.com/profile_images/1/a_bigger.jpg'],
      ['m0', 'photo', 'https://pbs.twimg.com/media/ABC.jpg?name=medium'],
      ['m1', 'video', 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg?name=medium'],
    ]);
    expect(meta.sources[1]).toMatchObject({ width: 1200, height: 800, alt: 'A demo picture' });
  });

  test('X syndication: a handle that is not a handle is dropped', () => {
    const meta = parseSyndication({ __typename: 'Tweet', id_str: '1', text: 'x', user: { name: 'N', screen_name: '../../evil' } }, '1');
    expect(meta?.handle).toBeUndefined();
  });

  test('X syndication: tombstone is unavailable, other shapes are no post', () => {
    expect(parseSyndication({ __typename: 'TweetTombstone', tombstone: {} }, '1')).toMatchObject({ status: 'unavailable' });
    expect(parseSyndication({ __typename: 'Tweet', id_str: '2' }, '1')).toBeNull();
    expect(parseSyndication('<html>', '1')).toBeNull();
  });

  test('X oEmbed fallback', () => {
    const html =
      '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">just setting up<br>my twttr &amp; <a href="https://t.co/x">pic.twitter.com/x</a></p>&mdash; Demo Author (@demo_user) <a href="https://x.com/demo_user/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>\n';
    expect(parseXOembed({ author_name: 'Demo Author', html })).toEqual({
      status: 'ok',
      author: 'Demo Author',
      handle: 'demo_user',
      text: 'just setting up\nmy twttr & pic.twitter.com/x',
      createdAt: Date.parse('2006-03-21T00:00:00Z'),
      sources: [],
      partial: true,
    });
    // A handle in the text of the post is not the author's.
    const quoted = '<blockquote><p>Thanks (@bob) for the help</p>&mdash; Demo Author (@demo_user) <a href="x">March 21, 2006</a></blockquote>';
    expect(parseXOembed({ html: quoted })?.handle).toBe('demo_user');
    expect(parseXOembed({ html: '<div>no quote</div>' })).toBeNull();
  });

  test('entities and token', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x1F600; &unknown;')).toBe("a & b <c> 'd' 😀 &unknown;");
    expect(syndicationToken('20')).toBe(((20 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('outgoing requests', () => {
  test('only https and the provider’s hosts, also after a redirect', async () => {
    const calls: string[] = [];
    const redirectTo = (to: string): FetchLike => async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: to } });
    };
    await expect(safeGet('https://evil.example/', 'youtube', async () => json({}), 1000)).rejects.toThrow(EmbedFetchError);
    await expect(safeGet('http://www.youtube.com/oembed', 'youtube', async () => json({}), 1000)).rejects.toThrow(EmbedFetchError);
    await expect(safeGet('https://www.youtube.com/oembed', 'youtube', redirectTo('https://169.254.169.254/latest'), 1000)).rejects.toThrow(/host not allowed/);
    await expect(safeGet('https://www.youtube.com/oembed', 'youtube', redirectTo('http://www.youtube.com/x'), 1000)).rejects.toThrow(/host not allowed/);
    // A provider may not use another provider’s hosts.
    await expect(safeGet('https://pbs.twimg.com/a.jpg', 'youtube', async () => json({}), 1000)).rejects.toThrow(/host not allowed/);
    expect(calls).toEqual(['https://www.youtube.com/oembed', 'https://www.youtube.com/oembed']);
  });

  test('a runtime that followed a redirect by itself is not trusted', async () => {
    const followed = (props: Record<string, unknown>): FetchLike => async () => {
      const res = new Response('{}');
      for (const [key, value] of Object.entries(props)) Object.defineProperty(res, key, { value });
      return res;
    };
    await expect(safeGet('https://www.youtube.com/oembed', 'youtube', followed({ redirected: true, url: 'https://www.youtube.com/x' }), 1000)).rejects.toThrow(/unchecked/);
    await expect(safeGet('https://www.youtube.com/oembed', 'youtube', followed({ redirected: false, url: 'https://evil.example/' }), 1000)).rejects.toThrow(/unchecked/);
    expect((await safeGet('https://www.youtube.com/oembed', 'youtube', followed({ url: 'https://www.youtube.com/oembed' }), 1000)).status).toBe(200);
  });

  test('follows allowed redirects, but not forever', async () => {
    let n = 0;
    const hops: FetchLike = async (url) => {
      n++;
      return url.includes('publish.twitter.com')
        ? new Response(null, { status: 301, headers: { location: 'https://publish.x.com/oembed?x=1' } })
        : json({ ok: true });
    };
    const res = await safeGet('https://publish.twitter.com/oembed', 'x', hops, 1000);
    expect(res.status).toBe(200);
    expect(n).toBe(2);
    const loop: FetchLike = async () => new Response(null, { status: 302, headers: { location: 'https://publish.x.com/oembed' } });
    await expect(safeGet('https://publish.x.com/oembed', 'x', loop, 1000)).rejects.toThrow(/too many redirects/);
  });

  test('size limit, by header and while reading', async () => {
    const big = new Uint8Array(2000);
    await expect(safeGet('https://i.ytimg.com/a.jpg', 'youtube', async () => new Response(big), 1000)).rejects.toThrow(/too large/);
    const lying: FetchLike = async () => new Response(big, { headers: { 'content-length': '10' } });
    await expect(safeGet('https://i.ytimg.com/a.jpg', 'youtube', lying, 1000)).rejects.toThrow(/too large/);
    expect((await safeGet('https://i.ytimg.com/a.jpg', 'youtube', async () => new Response(PNG), 1000)).bytes).toEqual(PNG);
  });

  test('YouTube: answer, not embeddable or gone, outage', async () => {
    const ok = await fetchEmbedMeta('youtube', 'dQw4w9WgXcQ', async (url) => {
      expect(url).toContain('oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
      return json({ title: 'Demo video', author_name: 'Demo channel' });
    });
    expect(ok.title).toBe('Demo video');
    for (const status of [401, 404]) expect(await fetchEmbedMeta('youtube', 'dQw4w9WgXcQ', async () => json({}, status))).toMatchObject({ status: 'unavailable' });
    await expect(fetchEmbedMeta('youtube', 'dQw4w9WgXcQ', async () => json({}, 503))).rejects.toThrow(EmbedFetchError);
    await expect(fetchEmbedMeta('youtube', 'dQw4w9WgXcQ', async () => json({}, 403))).rejects.toThrow(EmbedFetchError); // maybe throttled
    await expect(fetchEmbedMeta('youtube', 'dQw4w9WgXcQ', async () => Promise.reject(new Error('offline')))).rejects.toThrow(EmbedFetchError);
    await expect(fetchEmbedMeta('youtube', '../etc', async () => json({}))).rejects.toThrow(/invalid id/);
  });

  test('X: syndication first, then oEmbed, tombstone and gone posts', async () => {
    const id = '1585341984679469056';
    const oembed = json({ author_name: 'Demo Author', html: '<blockquote><p>fallback text</p>&mdash; Demo Author (@demo_user) <a href="https://x.com/a/status/1">March 21, 2006</a></blockquote>' });
    const syndication = json({ __typename: 'Tweet', id_str: id, text: 'from syndication', user: { name: 'Demo Author', screen_name: 'demo_user' } });
    const both: FetchLike = async (url) => (url.includes('syndication') ? syndication.clone() : oembed.clone());
    expect((await fetchEmbedMeta('x', id, both)).text).toBe('from syndication');

    // HTML error page from syndication → oEmbed answers.
    const htmlError: FetchLike = async (url) => (url.includes('syndication') ? new Response('<html>', { status: 404 }) : oembed.clone());
    expect((await fetchEmbedMeta('x', id, htmlError)).text).toBe('fallback text');

    const tombstone: FetchLike = async () => json({ __typename: 'TweetTombstone' });
    expect(await fetchEmbedMeta('x', id, tombstone)).toMatchObject({ status: 'unavailable' });

    const gone: FetchLike = async (url) => (url.includes('syndication') ? new Response('<html>', { status: 404 }) : json({}, 404));
    expect(await fetchEmbedMeta('x', id, gone)).toMatchObject({ status: 'unavailable' });

    const down: FetchLike = async () => json({}, 500);
    await expect(fetchEmbedMeta('x', id, down)).rejects.toThrow(EmbedFetchError);
  });

  test('media: only raster images, failures are left out', async () => {
    const files: Record<string, Response> = {
      'https://i.ytimg.com/ok.png': new Response(PNG),
      'https://i.ytimg.com/svg': new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'https://i.ytimg.com/gone': new Response('', { status: 404 }),
    };
    const fetchImpl: FetchLike = async (url) => files[url] ?? Promise.reject(new Error('offline'));
    const out = await downloadMedia(
      'youtube',
      ['ok.png', 'svg', 'gone', 'offline'].map((name, i) => ({ slot: `m${i}`, kind: 'photo' as const, url: `https://i.ytimg.com/${name}` })),
      fetchImpl,
    );
    expect(out.map((m) => [m.slot, m.contentType])).toEqual([['m0', 'image/png']]);
  });
});
