import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { fail } from './lib/errors';
import { fetchCatalog, providerHash, reduceCatalog, type SlimProvider } from './lib/modelsCatalog';
import { testSwitchesEnabled } from './lib/testSwitches';
import { modelRefValidator, slimProviderValidator } from './lib/validators';
import {
  applyProvider,
  catalogStatus,
  listProviderModels,
  listProviders,
  providerHashes,
  removeProvider,
  searchModels,
  setModelEnabled,
  writeCatalogStatus,
} from './ops/models';

// Desired model per issue (XLR8-93): the models.dev catalog, synced daily by the backend (the browser
// never contacts models.dev), and the owner's choice of models to offer. Rules: shared/models.ts,
// storing: ops/models.ts, fetch and reduction: lib/modelsCatalog.ts.


/** Models per mutation when writing a fresh catalog (Convex limits writes per transaction). */
const MODELS_PER_BATCH = 1500;
/** Removed providers per mutation. */
const REMOVALS_PER_BATCH = 20;
/** "Update now" does nothing if the last check is younger than this. */
const REFRESH_MIN_MS = 60_000;

/** For the settings: the catalog's providers and the state of the last sync. */
export const catalog = ownerQuery({
  args: {},
  handler: async (ctx) => ({ providers: await listProviders(ctx), status: await catalogStatus(ctx) }),
});

/** For the settings: the models of one provider, newest first. */
export const list = ownerQuery({
  args: { provider: v.string() },
  handler: async (ctx, args) => await listProviderModels(ctx, args.provider),
});

/** For the settings: models whose name matches, across providers or in one. */
export const search = ownerQuery({
  args: { q: v.string(), provider: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => await searchModels(ctx, args.q, args.provider, Math.min(Math.max(args.limit ?? 30, 1), 50)),
});

/** Offer a model in the chip (enabled) or stop offering it. Choices that use it stay. */
export const setEnabled = ownerWriteMutation({
  args: { provider: v.string(), modelId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => await setModelEnabled(ctx, ctx.actor, args),
});

/** "Update now" in the settings: runs the sync right away (at most once a minute). */
export const refresh = ownerWriteMutation({
  args: {},
  handler: async (ctx) => {
    const status = await catalogStatus(ctx);
    if (status && Date.now() - status.checkedAt < REFRESH_MIN_MS) return { scheduled: false };
    await ctx.scheduler.runAfter(0, internal.models.sync, {});
    return { scheduled: true };
  },
});

/**
 * For end-to-end tests and the local test data (needs SELFBOUND_TEST_SWITCHES=1, which a production
 * deployment never has): stores a catalog without contacting models.dev and enables some models.
 */
export const seedForTest = ownerWriteMutation({
  args: { providers: v.array(slimProviderValidator), enable: v.optional(v.array(modelRefValidator)) },
  handler: async (ctx, args) => {
    if (!testSwitchesEnabled()) fail('access_denied', 'Test switches are disabled on this backend.');
    const now = Date.now();
    for (const p of args.providers) await applyProvider(ctx, p, now);
    for (const m of args.enable ?? []) await setModelEnabled(ctx, ctx.actor, { ...m, enabled: true });
    return { providers: args.providers.length };
  },
});

// ---------------------------------------------------------------- Sync (cron `sync-models`)

/**
 * Reads models.dev with `If-None-Match` and rewrites the providers whose slim form changed. If
 * models.dev is down or answers nonsense, the stored catalog stays as it is (only the status records
 * the error); nothing in the app fails because of it.
 */
export const sync = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ changed: number; removed?: number; notModified?: boolean; error?: string }> => {
    const state: { etag?: string; hashes: Record<string, string> } = await ctx.runQuery(internal.models.syncState, {});
    const checkedAt = Date.now();
    let providers: SlimProvider[];
    let etag: string | undefined;
    try {
      const res = await fetchCatalog(args.force || Object.keys(state.hashes).length === 0 ? undefined : state.etag);
      if (res.status === 'not_modified') {
        await ctx.runMutation(internal.models.recordSync, { status: { ok: true, checkedAt } });
        return { changed: 0, notModified: true };
      }
      providers = reduceCatalog(res.catalog);
      etag = res.etag;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('models.dev sync failed:', message);
      await ctx.runMutation(internal.models.recordSync, { status: { ok: false, checkedAt, error: message.slice(0, 300) } });
      return { changed: 0, error: message };
    }

    const changed: (SlimProvider & { hash: string })[] = [];
    for (const p of providers) {
      const hash = await providerHash(p);
      if (state.hashes[p.provider] !== hash) changed.push({ ...p, hash });
    }
    let batch: typeof changed = [];
    let size = 0;
    for (const p of changed) {
      if (size + p.models.length > MODELS_PER_BATCH && batch.length) {
        await ctx.runMutation(internal.models.applyProviders, { providers: batch });
        batch = [];
        size = 0;
      }
      batch.push(p);
      size += p.models.length;
    }
    if (batch.length) await ctx.runMutation(internal.models.applyProviders, { providers: batch });

    const present = new Set(providers.map((p) => p.provider));
    const gone: string[] = Object.keys(state.hashes).filter((p) => !present.has(p));
    if (gone.length > 10 && gone.length > present.size) {
      // More providers vanished than are left: rather a broken answer than a real change. Keep them,
      // and keep no ETag, so the next run reads the catalog again.
      const error = `models.dev lists ${present.size} providers, ${gone.length} known ones are missing; nothing removed.`;
      await ctx.runMutation(internal.models.recordSync, { status: { ok: false, checkedAt, error } });
      return { changed: changed.length, error };
    }
    for (let i = 0; i < gone.length; i += REMOVALS_PER_BATCH) {
      await ctx.runMutation(internal.models.removeProviders, { providers: gone.slice(i, i + REMOVALS_PER_BATCH) });
    }
    const models = providers.reduce((n, p) => n + p.models.length, 0);
    // The ETag only after everything is stored: a failure halfway reads the whole catalog again next time.
    await ctx.runMutation(internal.models.recordSync, {
      status: { ok: true, checkedAt, syncedAt: Date.now(), etag, providers: providers.length, models, changed: changed.length + gone.length },
    });
    return { changed: changed.length, removed: gone.length };
  },
});

export const syncState = internalQuery({
  args: {},
  handler: async (ctx) => ({ etag: (await catalogStatus(ctx))?.etag, hashes: await providerHashes(ctx) }),
});

export const applyProviders = internalMutation({
  args: { providers: v.array(slimProviderValidator) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let written = 0;
    for (const p of args.providers) written += await applyProvider(ctx, p, now);
    return { written };
  },
});

export const removeProviders = internalMutation({
  args: { providers: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const p of args.providers) await removeProvider(ctx, p, now);
  },
});

export const recordSync = internalMutation({
  args: {
    status: v.object({
      ok: v.boolean(),
      checkedAt: v.number(),
      syncedAt: v.optional(v.number()),
      etag: v.optional(v.string()),
      providers: v.optional(v.number()),
      models: v.optional(v.number()),
      changed: v.optional(v.number()),
      error: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => await writeCatalogStatus(ctx, args.status),
});
