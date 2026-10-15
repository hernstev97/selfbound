import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { purgeEmbeds } from '../convex/ops/embeds';
import { embedTtl, EMBED_PURGE_MS, EMBED_TTL_MS, type EmbedView } from '../convex/shared/embeds';
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
  'publish.x.com/oembed': () =>
    jsonRes({
      author_name: 'Demo Author',
      author_url: 'https://x.com/demo_user',
      html: '<blockquote class="twitter-tweet"><p>Hello</p>&mdash; Demo Author (@demo_user) <a href="https://x.com/demo_user/status/1">October 14, 2026</a></blockquote>',
    }),
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

  test('X post: author, text and date from oEmbed, no pictures', async () => {
    const { t, owner } = setup();
    const calls = provider(postOk);
    const view = await owner.action(api.embeds.resolve, { provider: 'x', id: POST });
    expect(view).toMatchObject({ status: 'ok', author: 'Demo Author', handle: 'demo_user', text: 'Hello', createdAt: Date.parse('2026-10-14T00:00:00Z') });
    expect(view).not.toHaveProperty('thumbnail');
    expect(calls).toHaveLength(1);
    expect(await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)).toBe(0);
    expect((await t.fetch(`/embed/x/${POST}/avatar`, { method: 'GET' })).status).toBe(404);
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

  test('a picture that fails to load does not make a card stale for a week, and does not take away an earlier one', async () => {
    const { t, owner } = setup();
    // First fetch: the thumbnail fails. The card is shown but counts as stale after minutes, not days.
    provider({ 'youtube.com/oembed': () => jsonRes({ title: 'Demo video' }), 'i.ytimg.com': () => new Response('', { status: 503 }) });
    const first = await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    expect(first).toMatchObject({ status: 'ok', title: 'Demo video' });
    expect((first as { thumbnail?: string }).thumbnail).toBeUndefined();
    expect(first).toMatchObject({ incomplete: true });
    expect(embedTtl(first as EmbedView)).toBe(600_000);
    // Second fetch (after those minutes): the thumbnail comes now, the card is complete.
    provider(youtubeOk);
    const second = await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO, refresh: true });
    expect((second as { incomplete?: boolean }).incomplete).toBeUndefined();
    expect(embedTtl(second as EmbedView)).toBe(EMBED_TTL_MS.youtube);
    expect((second as { thumbnail?: string }).thumbnail).toContain('/thumb');
    // Third fetch (forced): the thumbnail fails again, the stored one stays.
    provider({ 'youtube.com/oembed': () => jsonRes({ title: 'New title' }), 'i.ytimg.com': () => new Response('', { status: 503 }) });
    const third = await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO, refresh: true });
    expect(third).toMatchObject({ title: 'New title' });
    expect((third as { thumbnail?: string }).thumbnail).toContain('/thumb');
    expect(await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)).toBe(1);
    expect((await t.fetch(`/embed/youtube/${VIDEO}/thumb`, { method: 'GET' })).status).toBe(200);
  });

  test('X: a failing refresh keeps the old card, a removed post becomes unavailable', async () => {
    const { owner } = setup();
    provider(postOk);
    await owner.action(api.embeds.resolve, { provider: 'x', id: POST });
    provider({ 'publish.x.com/oembed': () => jsonRes({}, 500) });
    expect(await owner.action(api.embeds.resolve, { provider: 'x', id: POST, refresh: true })).toMatchObject({ status: 'ok', text: 'Hello' });
    provider({ 'publish.x.com/oembed': () => jsonRes({}, 404) });
    expect(await owner.action(api.embeds.resolve, { provider: 'x', id: POST, refresh: true })).toMatchObject({ status: 'unavailable' });
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
    provider(youtubeOk);
    await owner.action(api.embeds.resolve, { provider: 'youtube', id: VIDEO });
    const res = await t.fetch(`/embed/youtube/${VIDEO}/thumb`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    for (const path of [`/embed/youtube/${VIDEO}/m9`, `/embed/youtube/AAAAAAAAAAA/thumb`, `/embed/x/${VIDEO}/thumb`, `/embed/youtube/${VIDEO}`, `/embed/other/${VIDEO}/thumb`, '/embed/youtube/../thumb', `/embed/youtube/${VIDEO}/thumb/extra`]) {
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
