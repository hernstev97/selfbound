import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { fail, invalid, notFound } from '../lib/errors';
import type { SlimModel, SlimProvider } from '../lib/modelsCatalog';
import { isOwnerKind } from '../shared/constants';
import { MODEL_LIMITS, type ModelInfo } from '../shared/models';
import { readOpsStatus, writeOpsStatus } from './maintenance';
import { modelRow } from './validate';

// The models catalog (XLR8-93): storing the slim form of models.dev, the owner's enabled models and
// what the app and MCP read of it. The fetch and the reduction are in lib/modelsCatalog.ts.

/** opsStatus key of the last sync. */
export const CATALOG_STATUS = 'modelsCatalog';

export type CatalogStatus = {
  ok: boolean;
  /** Last time the sync asked models.dev (also on "not modified" and on errors). */
  checkedAt: number;
  /** Last time the catalog was read in full. */
  syncedAt?: number;
  etag?: string;
  providers?: number;
  models?: number;
  /** Providers rewritten by the last full read. */
  changed?: number;
  error?: string;
  /** "Update now" pressed (throttles it while a sync runs). */
  requestedAt?: number;
};

export async function catalogStatus(ctx: QueryCtx): Promise<CatalogStatus | null> {
  return ((await readOpsStatus(ctx, CATALOG_STATUS))?.value as CatalogStatus | undefined) ?? null;
}

export async function writeCatalogStatus(ctx: MutationCtx, status: Partial<CatalogStatus> & { checkedAt: number }) {
  // A failed or unchanged check keeps the counts and the ETag of the last full read.
  const next: Record<string, unknown> = { ...((await catalogStatus(ctx)) ?? {}), ...status };
  if (status.ok === true) delete next.error;
  // An empty ETag drops the stored one: the next run reads the whole catalog.
  if (next.etag === '') delete next.etag;
  for (const [k, value] of Object.entries(next)) if (value === undefined) delete next[k];
  await writeOpsStatus(ctx, CATALOG_STATUS, next, status.checkedAt);
}

const SLIM_FIELDS = ['name', 'family', 'efforts', 'modes', 'context', 'output', 'releaseDate'] as const;

function sameSlim(row: Doc<'models'>, model: SlimModel, providerName: string): boolean {
  return row.providerName === providerName && SLIM_FIELDS.every((f) => JSON.stringify(row[f] ?? null) === JSON.stringify(model[f] ?? null));
}

/**
 * Writes one provider of a fresh catalog: new models are inserted, changed ones patched, models that
 * are no longer listed get `removedAt` (their row and `enabled` stay, so issues keep showing them).
 */
export async function applyProvider(ctx: MutationCtx, provider: SlimProvider & { hash: string }, now: number) {
  const rows = await ctx.db
    .query('models')
    .withIndex('by_provider_model', (q) => q.eq('provider', provider.provider))
    .collect();
  const byId = new Map(rows.map((r) => [r.modelId, r]));
  let written = 0;
  for (const model of provider.models) {
    const row = byId.get(model.modelId);
    byId.delete(model.modelId);
    if (!row) {
      await ctx.db.insert('models', { provider: provider.provider, providerName: provider.name, ...model, updatedAt: now });
      written++;
    } else if (!sameSlim(row, model, provider.name) || row.removedAt !== undefined) {
      const fields = Object.fromEntries(SLIM_FIELDS.map((f) => [f, model[f]]));
      await ctx.db.patch('models', row._id, { ...fields, providerName: provider.name, removedAt: undefined, updatedAt: now });
      written++;
    }
  }
  for (const row of byId.values()) {
    if (row.removedAt === undefined) {
      await ctx.db.patch('models', row._id, { removedAt: now, updatedAt: now });
      written++;
    }
  }
  const entry = { provider: provider.provider, name: provider.name, count: provider.models.length, hash: provider.hash, updatedAt: now };
  const existing = await providerRow(ctx, provider.provider);
  if (existing) await ctx.db.patch('modelProviders', existing._id, { ...entry, removedAt: undefined });
  else await ctx.db.insert('modelProviders', entry);
  return written;
}

/** A provider that left the catalog: its models get `removedAt`, the rows stay. */
export async function removeProvider(ctx: MutationCtx, provider: string, now: number) {
  const row = await providerRow(ctx, provider);
  if (!row || row.removedAt !== undefined) return;
  const models = await ctx.db
    .query('models')
    .withIndex('by_provider_model', (q) => q.eq('provider', provider))
    .collect();
  for (const m of models) if (m.removedAt === undefined) await ctx.db.patch('models', m._id, { removedAt: now, updatedAt: now });
  await ctx.db.patch('modelProviders', row._id, { removedAt: now, hash: '', updatedAt: now });
}

async function providerRow(ctx: QueryCtx, provider: string) {
  return await ctx.db
    .query('modelProviders')
    .withIndex('by_provider', (q) => q.eq('provider', provider))
    .unique();
}

/** Hashes of the stored providers (removed ones excluded), for the sync to skip unchanged ones. */
export async function providerHashes(ctx: QueryCtx): Promise<Record<string, string>> {
  const rows = await ctx.db.query('modelProviders').take(2000);
  return Object.fromEntries(rows.filter((r) => r.removedAt === undefined).map((r) => [r.provider, r.hash]));
}

export function modelInfo(row: Doc<'models'>): ModelInfo {
  return {
    provider: row.provider,
    providerName: row.providerName,
    modelId: row.modelId,
    name: row.name,
    ...(row.family ? { family: row.family } : {}),
    efforts: row.efforts ?? [],
    modes: row.modes ?? [],
    ...(row.context ? { context: row.context } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.releaseDate ? { releaseDate: row.releaseDate } : {}),
    ...(row.enabled ? { enabled: true } : {}),
    ...(row.removedAt !== undefined ? { removed: true } : {}),
  };
}

/** Newest first; models without a date last, then by name. */
export function byRelease(a: { releaseDate?: string; name: string }, b: { releaseDate?: string; name: string }) {
  const ra = a.releaseDate ?? '';
  const rb = b.releaseDate ?? '';
  if (ra !== rb) return ra < rb ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * The enabled models for `meta.get` and MCP `list_models`, by provider name, then newest first.
 * Small (the owner enables a handful), so every client can hold it.
 */
export async function enabledModels(ctx: QueryCtx): Promise<ModelInfo[]> {
  // Only model rows: a sync that rewrites other models or a provider's counts does not touch this read.
  const rows = await ctx.db
    .query('models')
    .withIndex('by_enabled', (q) => q.eq('enabled', true))
    .take(MODEL_LIMITS.enabled);
  return rows.map(modelInfo).sort((a, b) => a.providerName.localeCompare(b.providerName) || byRelease(a, b));
}

/** The catalog's providers for the settings, by name, with the number of models. */
export async function listProviders(ctx: QueryCtx) {
  const rows = await ctx.db.query('modelProviders').take(2000);
  return rows
    .filter((r) => r.removedAt === undefined)
    .map((r) => ({ provider: r.provider, name: r.name, count: r.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The models of one provider for the settings, newest first. Models that left the catalog only while enabled. */
export async function listProviderModels(ctx: QueryCtx, provider: string): Promise<ModelInfo[]> {
  const rows = await ctx.db
    .query('models')
    .withIndex('by_provider_model', (q) => q.eq('provider', provider))
    .take(3000);
  return rows
    .filter((r) => r.removedAt === undefined || r.enabled)
    .map(modelInfo)
    .sort(byRelease);
}

/** Search over model names in all providers (or one), at most `limit` hits. */
export async function searchModels(ctx: QueryCtx, q: string, provider: string | undefined, limit: number): Promise<ModelInfo[]> {
  const text = q.trim().slice(0, 100);
  if (!text) return [];
  const rows = await ctx.db
    .query('models')
    .withSearchIndex('search_name', (s) => (provider ? s.search('name', text).eq('provider', provider) : s.search('name', text)))
    .take(limit * 2);
  return rows
    .filter((r) => r.removedAt === undefined || r.enabled)
    .slice(0, limit)
    .map(modelInfo);
}

/** Owner only: offer a model in the chip (and allow it for new choices), or stop offering it. */
export async function setModelEnabled(ctx: MutationCtx, actor: Actor, args: { provider: string; modelId: string; enabled: boolean }) {
  if (!isOwnerKind(actor.kind)) fail('access_denied', 'Only the owner can choose the models.');
  const row = (await modelRow(ctx, args.provider, args.modelId)) ?? notFound('The model', { provider: args.provider, modelId: args.modelId });
  if (args.enabled === !!row.enabled) return { enabled: args.enabled };
  if (args.enabled) {
    if (row.removedAt !== undefined) invalid(`${row.name} is no longer in the models.dev catalog.`);
    const enabled = await ctx.db
      .query('models')
      .withIndex('by_enabled', (q) => q.eq('enabled', true))
      .take(MODEL_LIMITS.enabled);
    if (enabled.length >= MODEL_LIMITS.enabled) invalid(`At most ${MODEL_LIMITS.enabled} models can be enabled.`);
  }
  // Disabling keeps every choice that uses the model; only new choices need it enabled.
  await ctx.db.patch('models', row._id, { enabled: args.enabled ? true : undefined, updatedAt: Date.now() });
  return { enabled: args.enabled };
}
