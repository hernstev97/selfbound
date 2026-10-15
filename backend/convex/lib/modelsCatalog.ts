// The models.dev catalog (https://models.dev/api.json, about 5.7 MB) reduced to what Selfbound needs
// (XLR8-93). Pure functions; the fetch is in `fetchCatalog`, the storing in convex/models.ts.

import { MODEL_LIMITS } from '../shared/models';

export const CATALOG_URL = 'https://models.dev/api.json';

/** One model as stored in `models` (without the owner's `enabled` flag and the sync bookkeeping). */
export type SlimModel = {
  modelId: string;
  name: string;
  family?: string;
  efforts?: string[];
  modes?: string[];
  context?: number;
  output?: number;
  releaseDate?: string;
};

export type SlimProvider = { provider: string; name: string; models: SlimModel[] };

/** Upper bounds, so a broken or hostile catalog cannot fill the database. */
export const CATALOG_LIMITS = {
  providers: 1000,
  modelsPerProvider: 3000,
  models: 40_000,
  /** Effort values and modes per model. */
  values: 16,
  name: 200,
  family: 100,
  bytes: 32 * 1024 * 1024,
} as const;

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const DAY = /^\d{4}-\d{2}(-\d{2})?$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s && s.length <= max ? s : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
}

function values(list: unknown[]): string[] | undefined {
  const out: string[] = [];
  for (const raw of list) {
    const value = text(raw, MODEL_LIMITS.value);
    if (value && !out.includes(value) && out.length < CATALOG_LIMITS.values) out.push(value);
  }
  return out.length ? out : undefined;
}

/** One model entry, or null if it is unusable (no ID). Unknown fields are ignored. */
export function slimModel(id: string, raw: unknown): SlimModel | null {
  if (!isObject(raw)) return null;
  const modelId = text(id, MODEL_LIMITS.modelId);
  if (!modelId) return null;
  const model: SlimModel = { modelId, name: text(raw.name, CATALOG_LIMITS.name) ?? modelId };
  const family = text(raw.family, CATALOG_LIMITS.family);
  if (family) model.family = family;
  // Only options of type "effort" are a choice of level; "toggle" and "budget_tokens" are not.
  if (Array.isArray(raw.reasoning_options)) {
    const efforts = values(raw.reasoning_options.flatMap((o) => (isObject(o) && o.type === 'effort' && Array.isArray(o.values) ? o.values : [])));
    if (efforts) model.efforts = efforts;
  }
  const modes = isObject(raw.experimental) && isObject(raw.experimental.modes) ? values(Object.keys(raw.experimental.modes)) : undefined;
  if (modes) model.modes = modes.filter((m) => m !== 'standard');
  if (model.modes?.length === 0) delete model.modes;
  const limit = isObject(raw.limit) ? raw.limit : {};
  const context = count(limit.context);
  const output = count(limit.output);
  if (context) model.context = context;
  if (output) model.output = output;
  if (typeof raw.release_date === 'string' && DAY.test(raw.release_date)) model.releaseDate = raw.release_date;
  return model;
}

/**
 * The whole catalog: `{ [providerId]: { name, models: { [modelId]: {...} } } }`. Entries that do not
 * have this shape are skipped; a catalog without a single usable provider is an error (the last stored
 * state stays valid).
 */
export function reduceCatalog(raw: unknown): SlimProvider[] {
  if (!isObject(raw)) throw new Error('models.dev: the catalog is not an object');
  const out: SlimProvider[] = [];
  let total = 0;
  for (const [id, entry] of Object.entries(raw)) {
    if (out.length >= CATALOG_LIMITS.providers) break;
    if (!PROVIDER_ID.test(id) || id.length > MODEL_LIMITS.provider || !isObject(entry) || !isObject(entry.models)) continue;
    const models: SlimModel[] = [];
    for (const [modelId, m] of Object.entries(entry.models)) {
      if (models.length >= CATALOG_LIMITS.modelsPerProvider || total >= CATALOG_LIMITS.models) break;
      const model = slimModel(modelId, m);
      if (model) {
        models.push(model);
        total++;
      }
    }
    if (models.length === 0) continue;
    models.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
    out.push({ provider: id, name: text(entry.name, CATALOG_LIMITS.name) ?? id, models });
  }
  if (out.length === 0) throw new Error('models.dev: no usable provider in the catalog');
  return out;
}

/** Hex SHA-256 of a provider's slim form; the sync rewrites only providers whose hash changed. */
export async function providerHash(provider: SlimProvider): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(provider));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type CatalogResponse = { status: 'not_modified' } | { status: 'ok'; etag?: string; catalog: unknown };

/**
 * GET the catalog with `If-None-Match`. Fixed https URL, no redirects, 60 s timeout, size capped.
 * Throws on anything but 200 and 304.
 */
export async function fetchCatalog(etag: string | undefined, fetcher: typeof fetch = fetch): Promise<CatalogResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetcher(CATALOG_URL, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  if (res.status === 304) return { status: 'not_modified' };
  if (res.status !== 200) throw new Error(`models.dev answered ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > CATALOG_LIMITS.bytes) throw new Error('models.dev: the catalog is too large');
  const body = await readLimited(res, CATALOG_LIMITS.bytes);
  return { status: 'ok', etag: res.headers.get('etag') ?? undefined, catalog: JSON.parse(body) };
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('models.dev: the catalog is too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
