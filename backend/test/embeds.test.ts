import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { purgeEmbeds } from '../convex/ops/embeds';
import { EMBED_PURGE_MS, EMBED_TTL_MS } from '../convex/shared/embeds';
import { setup, type T } from './helpers';

// Embeds: resolve fetches and caches, the app reads the cache, media is served from our own
// endpoint, outages and unknown links store nothing, old entries are purged.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const VIDEO = 'dQw4w9WgXcQ';
const POST = '1585341984679469056';

function provider(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    calls.push(input);
    const key = Object.keys(handlers).find((k) => input.includes(k));
    return key ? handlers[key]!() : new Response('', { status: 404 });
  });
  return calls;
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const youtubeOk = {
  'youtube.com/oembed': () => jsonRes({ title: 'Demo video', author_name: 'Demo channel', author_url: 'https://www.youtube.com/@demo' }),
  'i.ytimg.com': () => new Response(PNG),
};
const postOk = {
  'cdn.syndication.twimg.com': () =>
    jsonRes({
      __typename: 'Tweet',
      id_str: POST,
      text: 'Hello https://t.co/BBBB',
      entities: { media: [{ url: 'https://t.co/BBBB' }] },
      user: { name: 'Demo Author', screen_name: 'demo_user', profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
      mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/ABC.jpg', original_info: { width: 800, height: 600 } }],
    }),
  'pbs.twimg.com': () => new Response(PNG),
};

afterEach(() => vi.unstubAllGlobals());

const rows = (t: T) => t.run(async (ctx) => await ctx.db.query('embeds').collect());

describe('resolve', () => {
  test('fetches once, then the cache answers; media comes from our own URLs', async () => {
    const { t, owner } = setup();
    const calls = provider(youtubeOk);
    const first = await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    expect(first).toMatchObject({ status: 'ok', title: 'Demo video', author: 'Demo channel', thumbnail: `http://127.0.0.1:3211/embed/youtube/${VIDEO}/thumb` });
    expect(calls).toHaveLength(2);
    const again = await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    expect(again).toEqual(first);
    expect(calls).toHaveLength(2);
    expect(await owner.query(api.embeds.get, { provider: 'youtube', id: VIDEO })).toEqual(first);
    expect(await rows(t)).toHaveLength(1);
    // The view reveals no storage IDs or provider URLs.
    expect(JSON.stringify(first)).not.toMatch(/ytimg|kg[0-9a-z]{20}/);
  });

  test('X post: text, author, avatar and image', async () => {
    const { owner } = setup();
    provider(postOk);
    const view = await owner.action(api.embeds.resolve, { provider: 'x', id: POST });
    expect(view).toMatchObject({
      status: 'ok',
      author: 'Demo Author',
      handle: 'demo_user',
      text: 'Hello',
      avatar: `http://127.0.0.1:3211/embed/x/${POST}/avatar`,
      media: [{ slot: 'm0', kind: 'photo', src: `http://127.0.0.1:3211/embed/x/${POST}/m0`, width: 800, height: 600 }],
    });
  });

  test('a stale entry is fetched again, a failing refresh keeps the old card', async () => {
    const { t, owner } = setup();
    provider(youtubeOk);
    await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query('embeds').collect();
      await ctx.db.patch('embeds', row!._id, { fetchedAt: Date.now() - EMBED_TTL_MS.youtube - 1000 });
    });
    const calls = provider({ 'youtube.com/oembed': () => jsonRes({}, 503) });
    const kept = await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    expect(calls).toHaveLength(1);
    expect(kept).toMatchObject({ status: 'ok', title: 'Demo video' });
    provider({ 'youtube.com/oembed': () => jsonRes({ title: 'New title' }), 'i.ytimg.com': () => new Response(PNG) });
    expect(await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO })).toMatchObject({ title: 'New title' });
    // The replaced thumbnail does not pile up.
    expect(await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)).toBe(1);
  });

  test('a missing video is cached as unavailable, an outage stores nothing', async () => {
    const { t, owner } = setup();
    provider({ 'youtube.com/oembed': () => jsonRes({}, 404) });
    expect(await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO })).toMatchObject({ status: 'unavailable' });
    expect(await rows(t)).toHaveLength(1);
    provider({ 'youtube.com/oembed': () => jsonRes({}, 500) });
    expect(await owner.action(api.embeds.resolve, { provider: 'youtube', id: 'AAAAAAAAAAA' })).toEqual({ status: 'error' });
    expect(await rows(t)).toHaveLength(1);
  });

  test('IDs that do not fit are rejected before any request', async () => {
    const { owner } = setup();
    const calls = provider(youtubeOk);
    await expect(owner.action(api.embeds.resolve, { provider: 'youtube', id: '../x' })).rejects.toThrow();
    await expect(owner.action(api.embeds.resolve, { provider: 'x', id: 'abc' })).rejects.toThrow();
    expect(await owner.query(api.embeds.get, { provider: 'x', id: 'abc' })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('GET /embed/<provider>/<id>/<slot>', () => {
  test('serves stored media with a hardened response, everything else is 404', async () => {
    const { t, owner } = setup();
    provider(postOk);
    await owner.action(api.embeds.resolve, { provider: 'x', id: POST });
    const res = await t.fetch(`/embed/x/${POST}/m0`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    for (const path of [`/embed/x/${POST}/m9`, `/embed/x/123/m0`, `/embed/youtube/${POST}/m0`, `/embed/x/${POST}`, `/embed/other/${POST}/m0`, '/embed/x/../m0', `/embed/x/${POST}/m0/extra`]) {
      expect((await t.fetch(path, { method: 'GET' })).status, path).toBe(404);
    }
  });
});

describe('purge', () => {
  test('deletes entries nobody refreshed for a long time, with their files', async () => {
    const { t, owner } = setup();
    provider(youtubeOk);
    await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    const now = Date.now();
    expect(await t.run((ctx) => purgeEmbeds(ctx, now + EMBED_PURGE_MS - 10_000))).toEqual({ deleted: 0, more: false });
    expect(await t.run((ctx) => purgeEmbeds(ctx, now + EMBED_PURGE_MS + 10_000))).toEqual({ deleted: 1, more: false });
    expect(await rows(t)).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)).toBe(0);
    expect(await t.mutation(internal.embeds.purge, {})).toEqual({ deleted: 0, more: false });
  });
});
