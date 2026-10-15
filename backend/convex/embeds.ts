import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';
import { ownerAction, ownerQuery } from './lib/auth';
import { fail } from './lib/errors';
import { invalid } from './lib/errors';
import { downloadMedia, EmbedFetchError, fetchEmbedMeta } from './lib/embeds';
import { assertWritable, testSwitchesEnabled } from './lib/testSwitches';
import { embedRow, embedView, purgeEmbeds, storeEmbed } from './ops/embeds';
import { embedKey, embedTtl, ID_PATTERN, type EmbedView } from './shared/embeds';

// Embeds in descriptions, comments and knowledge pages (XLR8-73): a link to a YouTube video or an
// X post alone on a line becomes a card. The browser never contacts the provider: the backend
// fetches metadata and media, stores them (cache) and serves the media itself (GET /embed/...,
// convex/http.ts). The player (YouTube, on click) is the only thing that loads from a third party.

const providerValidator = v.union(v.literal('youtube'), v.literal('x'));
type StoredMedia = { slot: string; kind: 'photo' | 'video' | 'gif' | 'avatar' | 'thumb'; storageId: Id<'_storage'>; contentType: string; width?: number; height?: number; alt?: string };
const mediaKinds = v.union(v.literal('photo'), v.literal('video'), v.literal('gif'), v.literal('avatar'), v.literal('thumb'));

/** Cached data for the card, or null if nothing is cached yet (then `resolve` fetches it). */
export const get = ownerQuery({
  args: { provider: providerValidator, id: v.string() },
  handler: async (ctx, args): Promise<EmbedView | null> => {
    if (!ID_PATTERN[args.provider].test(args.id)) return null;
    const row = await embedRow(ctx, args.provider, args.id);
    return row ? embedView(row) : null;
  },
});

/**
 * Cached data if it is fresh enough, otherwise fetched from the provider and stored. `error`: the
 * provider could not be reached (nothing is stored, the link stays a link, the app asks again later).
 */
export const resolve = ownerAction({
  args: { provider: providerValidator, id: v.string(), refresh: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<EmbedView | { status: 'error' }> => {
    if (!ID_PATTERN[args.provider].test(args.id)) invalid('This link cannot be embedded.');
    const cached: EmbedView | null = await ctx.runQuery(internal.embeds.cached, { provider: args.provider, id: args.id });
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age < embedTtl(cached) && !args.refresh) return cached;
    let meta;
    try {
      meta = await fetchEmbedMeta(args.provider, args.id);
    } catch (error) {
      if (!(error instanceof EmbedFetchError)) console.error('embed fetch failed', args.provider, error);
      // Stale data is better than none: a failed refresh keeps showing the old card.
      return cached ?? { status: 'error' };
    }
    const media = meta.status === 'ok' ? await downloadMedia(args.provider, meta.sources) : [];
    const stored: StoredMedia[] = [];
    const incomplete = meta.status === 'ok' && (meta.partial === true || media.length < meta.sources.length);
    try {
      for (const m of media) {
        const storageId = await ctx.storage.store(new Blob([m.bytes as BlobPart], { type: m.contentType }));
        stored.push({ slot: m.slot, kind: m.kind, storageId, contentType: m.contentType, width: m.width, height: m.height, alt: m.alt });
      }
      return await ctx.runMutation(internal.embeds.store, {
        key: embedKey(args.provider, args.id),
        provider: args.provider,
        status: meta.status,
        fetchedAt: Date.now(),
        incomplete: incomplete || undefined,
        title: meta.title,
        author: meta.author,
        handle: meta.handle,
        authorUrl: meta.authorUrl,
        text: meta.text,
        createdAt: meta.createdAt,
        media: stored,
      });
    } catch (error) {
      for (const m of stored) await ctx.storage.delete(m.storageId);
      throw error;
    }
  },
});

/**
 * For end-to-end tests only (needs XLR8_TEST_SWITCHES=1, which a production deployment never has):
 * puts a card into the cache without contacting a provider. Images come as base64.
 */
export const seedForTest = ownerAction({
  args: {
    provider: providerValidator,
    id: v.string(),
    status: v.union(v.literal('ok'), v.literal('unavailable')),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    handle: v.optional(v.string()),
    text: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    media: v.array(v.object({ slot: v.string(), kind: mediaKinds, base64: v.string(), width: v.optional(v.number()), height: v.optional(v.number()), alt: v.optional(v.string()) })),
  },
  handler: async (ctx, { media, id, ...fields }): Promise<EmbedView> => {
    if (!testSwitchesEnabled()) fail('access_denied', 'Test switches are disabled on this backend.');
    if (!ID_PATTERN[fields.provider].test(id)) invalid('This link cannot be embedded.');
    const stored: StoredMedia[] = [];
    for (const m of media) {
      const bytes = Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0));
      const storageId = await ctx.storage.store(new Blob([bytes], { type: 'image/png' }));
      stored.push({ slot: m.slot, kind: m.kind, storageId, contentType: 'image/png', width: m.width, height: m.height, alt: m.alt });
    }
    return await ctx.runMutation(internal.embeds.store, { ...fields, key: embedKey(fields.provider, id), fetchedAt: Date.now(), media: stored });
  },
});

export const cached = internalQuery({
  args: { provider: providerValidator, id: v.string() },
  handler: async (ctx, args): Promise<EmbedView | null> => {
    const row = await embedRow(ctx, args.provider, args.id);
    return row ? embedView(row) : null;
  },
});

export const store = internalMutation({
  args: {
    key: v.string(),
    provider: providerValidator,
    status: v.union(v.literal('ok'), v.literal('unavailable')),
    fetchedAt: v.number(),
    incomplete: v.optional(v.boolean()),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    handle: v.optional(v.string()),
    authorUrl: v.optional(v.string()),
    text: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    media: v.array(
      v.object({
        slot: v.string(),
        kind: mediaKinds,
        storageId: v.id('_storage'),
        contentType: v.string(),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        alt: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<EmbedView> => {
    await assertWritable(ctx);
    return embedView(await storeEmbed(ctx, args));
  },
});

/** Internal, for GET /embed/<provider>/<id>/<slot>: the stored file, otherwise null. */
export const mediaFile = internalQuery({
  args: { provider: providerValidator, id: v.string(), slot: v.string() },
  handler: async (ctx, args) => {
    if (!ID_PATTERN[args.provider].test(args.id)) return null;
    const row = await embedRow(ctx, args.provider, args.id);
    const media = row?.media.find((m) => m.slot === args.slot);
    return media ? { storageId: media.storageId, contentType: media.contentType } : null;
  },
});

/** Cron: delete entries nobody has shown for a long time. */
export const purge = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await purgeEmbeds(ctx, Date.now());
    if (result.more) await ctx.scheduler.runAfter(0, internal.embeds.purge, {});
    return result;
  },
});
