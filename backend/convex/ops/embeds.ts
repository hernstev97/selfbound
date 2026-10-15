import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { embedKey, EMBED_MEDIA_PATH, EMBED_PURGE_MS, type EmbedProvider, type EmbedView } from '../shared/embeds';

// Embed cache (table `embeds`): upsert, view for the app, cleanup. The fetching itself is in
// lib/embeds.ts, the Convex functions in embeds.ts.

type Row = Doc<'embeds'>;

export async function embedRow(ctx: QueryCtx, provider: EmbedProvider, id: string): Promise<Row | null> {
  return await ctx.db
    .query('embeds')
    .withIndex('by_key', (q) => q.eq('key', embedKey(provider, id)))
    .unique();
}

/** Row → what the app sees: media as our own URLs (`/embed/<provider>/<id>/<slot>`), no storage IDs. */
export function embedView(row: Row, siteUrl = (process.env.CONVEX_SITE_URL ?? '').replace(/\/+$/, '')): EmbedView {
  const id = row.key.slice(row.provider.length + 1);
  const src = (slot: string) => `${siteUrl}${EMBED_MEDIA_PATH}${row.provider}/${id}/${slot}`;
  const view: EmbedView = { provider: row.provider, id, status: row.status, fetchedAt: row.fetchedAt, media: [] };
  for (const field of ['title', 'author', 'handle', 'authorUrl', 'text', 'createdAt'] as const) {
    if (row[field] !== undefined) Object.assign(view, { [field]: row[field] });
  }
  for (const m of row.media) {
    if (m.kind === 'avatar') view.avatar = src(m.slot);
    else if (m.kind === 'thumb') view.thumbnail = src(m.slot);
    else view.media.push({ slot: m.slot, kind: m.kind, src: src(m.slot), width: m.width, height: m.height, alt: m.alt });
  }
  return view;
}

export type EmbedFields = Omit<Row, '_id' | '_creationTime'>;

/** Writes the fetch result (replaces an earlier one; files that are no longer used are deleted). */
export async function storeEmbed(ctx: MutationCtx, fields: EmbedFields): Promise<Row> {
  const [provider, ...rest] = fields.key.split(':');
  const existing = await embedRow(ctx, provider as EmbedProvider, rest.join(':'));
  if (!existing) {
    const id = await ctx.db.insert('embeds', fields);
    return (await ctx.db.get('embeds', id))!;
  }
  // A concurrent fetch may have finished first; the newer result wins, the other files go.
  const [keep, drop] = fields.fetchedAt >= existing.fetchedAt ? [fields.media, existing.media] : [existing.media, fields.media];
  const kept = new Set(keep.map((m) => m.storageId));
  for (const m of drop) if (!kept.has(m.storageId)) await ctx.storage.delete(m.storageId);
  if (fields.fetchedAt < existing.fetchedAt) return existing;
  await ctx.db.replace('embeds', existing._id, fields);
  return (await ctx.db.get('embeds', existing._id))!;
}

/** Cron: deletes entries nobody refreshed for EMBED_PURGE_MS (viewing refreshes them), with their files. */
export async function purgeEmbeds(ctx: MutationCtx, now: number, batch = 50): Promise<{ deleted: number; more: boolean }> {
  const old = await ctx.db
    .query('embeds')
    .withIndex('by_fetched', (q) => q.lt('fetchedAt', now - EMBED_PURGE_MS))
    .take(batch + 1);
  for (const row of old.slice(0, batch)) {
    for (const m of row.media) await ctx.storage.delete(m.storageId);
    await ctx.db.delete('embeds', row._id);
  }
  return { deleted: Math.min(old.length, batch), more: old.length > batch };
}
