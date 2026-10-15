import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { reduceCatalog } from '../convex/lib/modelsCatalog';
import { CATALOG_STATUS, type CatalogStatus } from '../convex/ops/models';
import raw from './lib/fixtures/models-dev.json';
import { createOne, expectCode, fixture, getIssue, historyOf, setup, type Client, type T } from './helpers';

// Desired model per issue (XLR8-93): the daily models.dev sync with a shortened copy of api.json,
// the enabled models, validation on every write path and the team default.

const OPUS = { provider: 'anthropic', modelId: 'claude-opus-5-5' };
const SONNET = { provider: 'anthropic', modelId: 'claude-sonnet-5-5' };
const QWEN = { provider: 'deepinfra', modelId: 'Qwen/Qwen3.8-Flash' };

type Catalog = Record<string, { name?: string; models: Record<string, Record<string, unknown>> }>;
const clone = (): Catalog => structuredClone(raw) as unknown as Catalog;

/** models.dev stand-in: answers with `catalog` and an ETag, 304 on a matching If-None-Match. */
function modelsDev(state: { catalog: Catalog | string; etag: string; status?: number }) {
  const calls: { ifNoneMatch: string | null }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://models.dev/api.json');
    const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    calls.push({ ifNoneMatch });
    if (state.status) return new Response('down', { status: state.status });
    if (ifNoneMatch === state.etag) return new Response(null, { status: 304 });
    const body = typeof state.catalog === 'string' ? state.catalog : JSON.stringify(state.catalog);
    return new Response(body, { status: 200, headers: { etag: state.etag } });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const models = (t: T) => t.run(async (ctx) => await ctx.db.query('models').collect());
const status = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('opsStatus').withIndex('by_key', (q) => q.eq('key', CATALOG_STATUS)).unique())?.value as CatalogStatus);
const row = async (t: T, m: { provider: string; modelId: string }) => (await models(t)).find((r) => r.provider === m.provider && r.modelId === m.modelId);

/** Catalog from the fixture without network, Opus, Sonnet and Qwen enabled. */
async function seedCatalog(owner: Client, enable = [OPUS, SONNET, QWEN]) {
  const providers = reduceCatalog(raw).map((p) => ({ ...p, hash: 'seed' }));
  await owner.mutation(api.models.seedForTest, { providers, enable });
}

describe('sync', () => {
  test('stores the slim catalog, then asks with If-None-Match and changes nothing on 304', async () => {
    const { t } = setup();
    const calls = modelsDev({ catalog: clone(), etag: '"v1"' });
    expect(await t.action(internal.models.sync, {})).toMatchObject({ changed: 5 });
    expect(calls).toEqual([{ ifNoneMatch: null }]);
    const stored = await models(t);
    expect(stored).toHaveLength(9);
    expect(await row(t, OPUS)).toMatchObject({ name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast'], context: 1_000_000 });
    expect((await row(t, QWEN))?.efforts).toBeUndefined();
    expect(await status(t)).toMatchObject({ ok: true, etag: '"v1"', providers: 5, models: 9 });

    const before = JSON.stringify(await models(t));
    expect(await t.action(internal.models.sync, {})).toMatchObject({ notModified: true });
    expect(calls[1]).toEqual({ ifNoneMatch: '"v1"' });
    expect(JSON.stringify(await models(t))).toBe(before);
  });

  test('a new ETag with the same content rewrites nothing; changes rewrite only that provider', async () => {
    const { t, owner } = setup();
    const state = { catalog: clone(), etag: '"v1"' };
    modelsDev(state);
    await t.action(internal.models.sync, {});
    await owner.mutation(api.models.setEnabled, { ...OPUS, enabled: true });
    const updated = async () => Object.fromEntries((await models(t)).map((r) => [`${r.provider}/${r.modelId}`, r.updatedAt]));
    const first = await updated();

    state.etag = '"v2"';
    expect(await t.action(internal.models.sync, {})).toMatchObject({ changed: 0, removed: 0 });
    expect(await updated()).toEqual(first);

    // Opus loses "max", Sonnet leaves the catalog, the Sarvam provider is gone.
    const next = clone();
    (next.anthropic!.models['claude-opus-5-5']!.reasoning_options as { values: string[] }[])[0]!.values = ['low', 'high'];
    delete next.anthropic!.models['claude-sonnet-5-5'];
    delete next.sarvam;
    state.catalog = next;
    state.etag = '"v3"';
    expect(await t.action(internal.models.sync, {})).toMatchObject({ changed: 1, removed: 1 });
    const opus = await row(t, OPUS);
    expect(opus).toMatchObject({ efforts: ['low', 'high'], enabled: true });
    expect(opus?.removedAt).toBeUndefined();
    expect((await row(t, SONNET))?.removedAt).toBeDefined();
    expect((await row(t, { provider: 'sarvam', modelId: 'sarvam-30b' }))?.removedAt).toBeDefined();
    expect((await row(t, { provider: 'openai', modelId: 'gpt-6-sol' }))?.updatedAt).toBe(first['openai/gpt-6-sol']);

    // Back in the catalog: the row is active again.
    state.catalog = clone();
    state.etag = '"v4"';
    await t.action(internal.models.sync, {});
    expect((await row(t, SONNET))?.removedAt).toBeUndefined();
  });

  test('models.dev down or broken: the last state stays valid, the status says why', async () => {
    const { t } = setup();
    const state: { catalog: Catalog | string; etag: string; status?: number } = { catalog: clone(), etag: '"v1"' };
    modelsDev(state);
    await t.action(internal.models.sync, {});
    const before = JSON.stringify(await models(t));

    state.status = 503;
    expect(await t.action(internal.models.sync, {})).toMatchObject({ error: 'models.dev answered 503' });
    expect(await status(t)).toMatchObject({ ok: false, error: 'models.dev answered 503', etag: '"v1"', models: 9 });

    delete state.status;
    state.etag = '"v2"';
    state.catalog = '{"truncated": ';
    expect((await t.action(internal.models.sync, {})).error).toBeDefined();
    state.catalog = JSON.stringify({ x: { models: {} } });
    expect((await t.action(internal.models.sync, {})).error).toMatch(/no usable provider/);
    expect(JSON.stringify(await models(t))).toBe(before);

    state.catalog = clone();
    await t.action(internal.models.sync, {});
    expect(await status(t)).toMatchObject({ ok: true, etag: '"v2"' });
    expect((await status(t)).error).toBeUndefined();
  });

  test('"Update now" schedules a sync at most once a minute, also while one is running', async () => {
    const { owner } = setup();
    modelsDev({ catalog: clone(), etag: '"v1"' });
    expect(await owner.mutation(api.models.refresh, {})).toEqual({ scheduled: true });
    expect(await owner.mutation(api.models.refresh, {})).toEqual({ scheduled: false });
  });

  test('more providers vanish than remain: nothing is written, the next run reads everything again', async () => {
    const { t } = setup();
    const many: Catalog = clone();
    for (let i = 0; i < 12; i++) many[`extra-${i}`] = { name: `Extra ${i}`, models: { m: { name: `M ${i}` } } };
    const state: { catalog: Catalog; etag: string } = { catalog: many, etag: '"v1"' };
    const calls = modelsDev(state);
    await t.action(internal.models.sync, {});
    const before = JSON.stringify(await models(t));
    state.catalog = { anthropic: clone().anthropic! };
    state.etag = '"v2"';
    expect((await t.action(internal.models.sync, {})).error).toMatch(/nothing changed/);
    expect(JSON.stringify(await models(t))).toBe(before);
    expect((await status(t)).etag).toBeUndefined();
    state.catalog = many;
    await t.action(internal.models.sync, {});
    expect(calls.at(-1)).toEqual({ ifNoneMatch: null });
  });
});

describe('settings', () => {
  test('providers, models of a provider newest first, search, enabling', async () => {
    const { t, owner, stranger } = setup();
    await seedCatalog(owner, []);
    const { providers } = await owner.query(api.models.catalog, {});
    expect(providers.map((p) => p.name)).toEqual(['Anthropic', 'Deep Infra', 'Google', 'OpenAI', 'Sarvam AI']);
    expect(providers[0]).toMatchObject({ provider: 'anthropic', count: 3 });
    const anthropic = await owner.query(api.models.list, { provider: 'anthropic' });
    expect(anthropic.map((m) => m.modelId)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(anthropic[2]).toMatchObject({ providerName: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast'] });
    const hits = await owner.query(api.models.search, { q: 'opus' });
    expect(hits.map((m) => m.modelId)).toEqual(['claude-opus-5-5']);

    expect((await owner.query(api.meta.get, {})).models).toEqual([]);
    await owner.mutation(api.models.setEnabled, { ...OPUS, enabled: true });
    await owner.mutation(api.models.setEnabled, { provider: 'openai', modelId: 'gpt-6-sol', enabled: true });
    const meta = await owner.query(api.meta.get, {});
    expect(meta.models.map((m) => `${m.providerName}: ${m.name}`)).toEqual(['Anthropic: Claude Opus 5.5', 'OpenAI: GPT-6 Sol']);
    await expectCode(owner.mutation(api.models.setEnabled, { provider: 'anthropic', modelId: 'nope', enabled: true }), 'not_found');
    await expectCode(stranger.mutation(api.models.setEnabled, { ...OPUS, enabled: false }), 'access_denied');

    // A model that left the catalog cannot be enabled again once disabled.
    await t.run(async (ctx) => {
      const r = (await ctx.db.query('models').collect()).find((m) => m.modelId === 'claude-sonnet-5-5')!;
      await ctx.db.patch('models', r._id, { removedAt: Date.now() });
    });
    await expectCode(owner.mutation(api.models.setEnabled, { ...SONNET, enabled: true }), 'invalid');
  });
});

describe('issue model', () => {
  test('create and update: only enabled models with valid effort and speed', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await seedCatalog(owner);
    const { id } = await createOne(owner, f.orb, { model: { ...OPUS, effort: 'xhigh', speed: 'fast' } });
    expect((await getIssue(t, id)).model).toEqual({ ...OPUS, effort: 'xhigh', speed: 'fast' });

    // The standard speed and an empty effort are not stored.
    await owner.mutation(api.issues.update, { ids: [id], patch: { model: { ...SONNET, effort: '', speed: 'standard' } } });
    expect((await getIssue(t, id)).model).toEqual(SONNET);

    const bad = async (model: { provider: string; modelId: string; effort?: string; speed?: string }) =>
      String((await expectCode(owner.mutation(api.issues.update, { ids: [id], patch: { model } }), 'invalid')).message);
    expect(await bad({ ...OPUS, effort: 'none' })).toBe('Effort "none" is not valid for Claude Opus 5.5. Valid: low, medium, high, xhigh, max.');
    expect(await bad({ ...SONNET, speed: 'fast' })).toBe('Speed "fast" is not valid for Claude Sonnet 5.5. Valid: standard.');
    expect(await bad({ ...QWEN, effort: 'low' })).toMatch(/has no effort setting/);
    expect(await bad({ provider: 'openai', modelId: 'gpt-6-sol' })).toBe('GPT-6 Sol is not enabled. Enable it under Settings › Models.');
    expect(await bad({ provider: 'anthropic', modelId: 'claude-opus-9' })).toMatch(/^Unknown model "anthropic\/claude-opus-9"/);
    await expectCode(owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'x', model: { ...OPUS, effort: 'turbo' } }] }), 'invalid');

    await owner.mutation(api.issues.update, { ids: [id], patch: { model: null } });
    expect((await getIssue(t, id)).model).toBeUndefined();
    const rows = (await historyOf(t, id)).filter((h) => h.field === 'model');
    expect(rows.map((h) => [h.from ?? null, h.to ?? null])).toEqual([
      [{ ...OPUS, effort: 'xhigh', speed: 'fast' }, SONNET],
      [SONNET, null],
    ]);
  });

  test('a disabled or vanished model stays on its issues, effort changes still checked; undo brings it back', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await seedCatalog(owner);
    const { id } = await createOne(owner, f.orb, { model: { ...OPUS, effort: 'high' } });
    await owner.mutation(api.models.setEnabled, { ...OPUS, enabled: false });
    await owner.mutation(api.issues.update, { ids: [id], patch: { model: { ...OPUS, effort: 'max' } } });
    expect((await getIssue(t, id)).model).toEqual({ ...OPUS, effort: 'max' });
    await expectCode(owner.mutation(api.issues.update, { ids: [id], patch: { model: { ...OPUS, effort: 'none' } } }), 'invalid');
    // Another issue cannot newly pick it.
    await expectCode(owner.mutation(api.issues.create, { issues: [{ teamId: f.orb, title: 'x', model: OPUS }] }), 'invalid');

    await t.run(async (ctx) => {
      const r = (await ctx.db.query('models').collect()).find((m) => m.modelId === OPUS.modelId)!;
      await ctx.db.patch('models', r._id, { removedAt: Date.now() });
    });
    await owner.mutation(api.issues.update, { ids: [id], patch: { model: SONNET } });
    // Undo: back to the vanished model, with compare-and-set on the value it set.
    await owner.mutation(api.issues.revert, { items: [{ id, patch: { model: { ...OPUS, effort: 'max' } }, expect: { model: SONNET } }] });
    expect((await getIssue(t, id)).model).toEqual({ ...OPUS, effort: 'max' });
    await expectCode(owner.mutation(api.issues.revert, { items: [{ id, patch: { model: null }, expect: { model: SONNET } }] }), 'conflict');
    // Undo only brings back the model the last change replaced, not any other one that is gone.
    await owner.mutation(api.models.setEnabled, { provider: 'openai', modelId: 'gpt-6-sol', enabled: false });
    await expectCode(
      owner.mutation(api.issues.revert, { items: [{ id, patch: { model: { provider: 'openai', modelId: 'gpt-6-sol' } }, expect: { model: { ...OPUS, effort: 'max' } } }] }),
      'invalid',
    );
  });

  test('team default: validated like an issue model, cleared with null', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await seedCatalog(owner);
    await owner.mutation(api.teams.update, { teamId: f.orb, defaultModel: { ...OPUS, effort: 'medium' } });
    const team = await t.run(async (ctx) => await ctx.db.get('teams', f.orb));
    expect(team?.defaultModel).toEqual({ ...OPUS, effort: 'medium' });
    expect((await owner.query(api.meta.get, {})).teams.find((x) => x._id === f.orb)?.defaultModel).toEqual({ ...OPUS, effort: 'medium' });
    await expectCode(owner.mutation(api.teams.update, { teamId: f.orb, defaultModel: { ...OPUS, speed: 'pro' } }), 'invalid');
    await owner.mutation(api.teams.update, { teamId: f.orb, defaultModel: null });
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.orb)))?.defaultModel).toBeUndefined();
  });
});
