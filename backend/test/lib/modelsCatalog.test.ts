import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CATALOG_URL, fetchCatalog, fetchLogo, providerHash, reduceCatalog, slimModel } from '../../convex/lib/modelsCatalog';
import { choiceProblem, compactTokens, effectiveModel, normalizeChoice, parseModelKey, sameChoice, speedsOf } from '../../convex/shared/models';

// The models.dev catalog reduced to the slim form (XLR8-93). The fixture is a shortened copy of the
// real api.json (October 2026): models with effort and fast mode, one with only a reasoning toggle,
// one without reasoning_options, one with a null effort value, and a few broken entries.
const raw = JSON.parse(readFileSync(new URL('./fixtures/models-dev.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('reduceCatalog', () => {
  const catalog = reduceCatalog(raw);
  const model = (provider: string, id: string) => catalog.find((p) => p.provider === provider)?.models.find((m) => m.modelId === id);

  test('keeps usable providers, skips broken and empty ones', () => {
    expect(catalog.map((p) => p.provider).sort()).toEqual(['anthropic', 'deepinfra', 'google', 'openai', 'sarvam']);
    expect(catalog.find((p) => p.provider === 'anthropic')?.name).toBe('Anthropic');
  });

  test('effort values, modes, context and output', () => {
    expect(model('anthropic', 'claude-opus-5-5')).toEqual({
      modelId: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      family: 'claude-opus',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      modes: ['fast'],
      context: 1_000_000,
      output: 128_000,
      releaseDate: '2026-09-22',
    });
    expect(model('openai', 'gpt-6-sol')?.modes).toEqual(['fast', 'pro']);
    expect(model('openai', 'gpt-6-sol')?.efforts).toContain('none');
  });

  test('a reasoning toggle is no effort setting; neither is a missing reasoning_options', () => {
    expect(model('anthropic', 'claude-haiku-5-5')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(model('deepinfra', 'XiaomiMiMo/MiMo-V2.6-Pro')?.efforts).toBeUndefined();
    expect(model('deepinfra', 'Qwen/Qwen3.8-Flash')?.efforts).toBeUndefined();
    expect(model('google', 'gemini-omni-flash-preview')?.efforts).toBeUndefined();
    expect(model('deepinfra', 'Qwen/Qwen3.8-Flash')?.modes).toBeUndefined();
  });

  test('non-string effort values are dropped', () => {
    expect(model('sarvam', 'sarvam-30b')?.efforts).toEqual(['low', 'medium', 'high']);
  });

  test('models sorted by ID, so the hash does not depend on the order in the file', async () => {
    const ids = catalog.find((p) => p.provider === 'anthropic')!.models.map((m) => m.modelId);
    expect(ids).toEqual([...ids].sort());
    const reversed = Object.fromEntries(Object.entries(raw).reverse());
    const again = reduceCatalog(reversed).find((p) => p.provider === 'anthropic')!;
    expect(await providerHash(again)).toBe(await providerHash(catalog.find((p) => p.provider === 'anthropic')!));
  });

  test('model IDs that only differ in whitespace count once', () => {
    const [p] = reduceCatalog({ x: { name: 'X', models: { m: { name: 'First' }, 'm ': { name: 'Second' } } } });
    expect(p!.models).toEqual([{ modelId: 'm', name: 'First' }]);
  });

  test('a catalog without a usable provider is an error', () => {
    expect(() => reduceCatalog([])).toThrow();
    expect(() => reduceCatalog({ x: { models: {} } })).toThrow(/no usable provider/);
  });

  test('odd values', () => {
    expect(slimModel('m', { name: 'M', limit: { context: -1, output: 'x' }, release_date: 'soon', experimental: { modes: { standard: {}, fast: {} } } })).toEqual({
      modelId: 'm',
      name: 'M',
      modes: ['fast'],
    });
    expect(slimModel('', { name: 'no id' })).toBeNull();
    expect(slimModel('m', 'not an object')).toBeNull();
    expect(slimModel('m', {})?.name).toBe('m');
  });
});

describe('fetchCatalog', () => {
  const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

  test('sends If-None-Match and understands 304', async () => {
    let seen: Headers | undefined;
    const res = await fetchCatalog('"abc"', (async (url: string, init: RequestInit) => {
      expect(url).toBe(CATALOG_URL);
      seen = new Headers(init.headers);
      return new Response(null, { status: 304 });
    }) as typeof fetch);
    expect(seen?.get('if-none-match')).toBe('"abc"');
    expect(res).toEqual({ status: 'not_modified' });
  });

  test('returns the parsed catalog with the ETag', async () => {
    const res = await fetchCatalog(undefined, (async () => ok('{"a":{"models":{}}}', { etag: '"v2"' })) as typeof fetch);
    expect(res).toEqual({ status: 'ok', etag: '"v2"', catalog: { a: { models: {} } } });
  });

  test('errors and redirects throw', async () => {
    await expect(fetchCatalog(undefined, (async () => new Response('', { status: 500 })) as typeof fetch)).rejects.toThrow(/500/);
    await expect(fetchCatalog(undefined, (async () => new Response('', { status: 302, headers: { location: 'https://example.com' } })) as typeof fetch)).rejects.toThrow(/302/);
    await expect(fetchCatalog(undefined, (async () => ok('{', {})) as typeof fetch)).rejects.toThrow();
    await expect(fetchCatalog(undefined, (async () => ok('{}', { 'content-length': String(64 * 1024 * 1024) })) as typeof fetch)).rejects.toThrow(/too large/);
  });
});

describe('fetchLogo', () => {
  const svg = (body: string, viewBox = '0 0 40 40') => `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const answer = (status: number, body = '', etag?: string) => (async (url: string, init: RequestInit) => {
    expect(url).toBe('https://models.dev/logos/wafer.ai.svg');
    expect(new Headers(init.headers).get('if-none-match')).toBe(etag ?? null);
    return new Response(status === 304 ? null : body, { status, headers: { etag: '"l2"' } });
  }) as unknown as typeof fetch;

  test('a logo that passes the check, also a wide one; ETag and 304', async () => {
    const wide = svg('<path d="M0 0h120v30H0Z" fill="currentColor"/>', '0 0 120 30');
    const res = await fetchLogo('wafer.ai', undefined, answer(200, wide));
    expect(res.status === 'ok' && new TextDecoder().decode(res.svg)).toBe(wide);
    expect(res).toMatchObject({ etag: '"l2"' });
    expect(await fetchLogo('wafer.ai', '"l1"', answer(304, '', '"l1"'))).toEqual({ status: 'not_modified' });
  });

  test('no logo, errors, too large', async () => {
    expect(await fetchLogo('wafer.ai', undefined, answer(404))).toEqual({ status: 'none' });
    await expect(fetchLogo('wafer.ai', undefined, answer(500))).rejects.toThrow(/500/);
    await expect(fetchLogo('wafer.ai', undefined, answer(200, svg(`<!-- ${'x'.repeat(300 * 1024)} -->`)))).rejects.toThrow(/too large/);
  });
});

describe('model choice rules', () => {
  const opus = { name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast'] };
  const plain = { name: 'Qwen3.8 Flash', efforts: [], modes: [] };

  test('valid combinations', () => {
    expect(choiceProblem({ provider: 'anthropic', modelId: 'claude-opus-5-5' }, opus)).toBeNull();
    expect(choiceProblem({ provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'xhigh', speed: 'fast' }, opus)).toBeNull();
    expect(choiceProblem({ provider: 'anthropic', modelId: 'claude-opus-5-5', speed: 'standard' }, opus)).toBeNull();
    expect(choiceProblem({ provider: 'deepinfra', modelId: 'Qwen/Qwen3.8-Flash', speed: 'standard' }, plain)).toBeNull();
  });

  test('invalid combinations name the valid values', () => {
    expect(choiceProblem({ provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'none' }, opus)).toBe(
      'Effort "none" is not valid for Claude Opus 5.5. Valid: low, medium, high, xhigh, max.',
    );
    expect(choiceProblem({ provider: 'anthropic', modelId: 'claude-opus-5-5', speed: 'pro' }, opus)).toBe(
      'Speed "pro" is not valid for Claude Opus 5.5. Valid: standard, fast.',
    );
    expect(choiceProblem({ provider: 'deepinfra', modelId: 'Qwen/Qwen3.8-Flash', effort: 'low' }, plain)).toMatch(/has no effort setting/);
    expect(choiceProblem({ provider: 'x', modelId: 'y' }, undefined)).toBe('Unknown model "x/y".');
    expect(choiceProblem({ provider: '', modelId: 'y' }, opus)).toMatch(/needs a provider/);
  });

  test('normalizing: standard speed and empty effort are not stored', () => {
    expect(normalizeChoice({ provider: ' anthropic ', modelId: 'claude-opus-5-5', effort: '', speed: 'standard' })).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
    });
    expect(sameChoice({ provider: 'a', modelId: 'b' }, { provider: 'a', modelId: 'b', effort: undefined })).toBe(true);
    expect(sameChoice({ provider: 'a', modelId: 'b', effort: 'low' }, { provider: 'a', modelId: 'b' })).toBe(false);
    expect(sameChoice(null, undefined)).toBe(true);
  });

  test('resolution order: issue, parent, team, none', () => {
    const own = { provider: 'a', modelId: 'own' };
    const parent = { provider: 'a', modelId: 'parent' };
    const team = { provider: 'a', modelId: 'team' };
    expect(effectiveModel(own, parent, team)).toEqual({ choice: own, source: 'issue' });
    expect(effectiveModel(undefined, parent, team)).toEqual({ choice: parent, source: 'parent' });
    expect(effectiveModel(undefined, undefined, team)).toEqual({ choice: team, source: 'team' });
    expect(effectiveModel(undefined, null, undefined)).toBeNull();
  });

  test('helpers', () => {
    expect(speedsOf({ modes: ['fast'] })).toEqual(['standard', 'fast']);
    expect(parseModelKey('poe/anthropic/claude-opus-4.1')).toEqual({ provider: 'poe', modelId: 'anthropic/claude-opus-4.1' });
    expect(parseModelKey('nokey')).toBeNull();
    expect(compactTokens(1_000_000)).toBe('1M');
    expect(compactTokens(1_050_000)).toBe('1.05M');
    expect(compactTokens(1_048_576)).toBe('1.05M');
    expect(compactTokens(200_000)).toBe('200K');
    expect(compactTokens(262_144)).toBe('262K');
    expect(compactTokens(8192)).toBe('8.2K');
    expect(compactTokens(1_048_576, (v) => v.toLocaleString('de-DE'))).toBe('1,05M');
  });
});
