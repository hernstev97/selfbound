import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { expectCode, setup } from './helpers';

// Appearance: themes and fonts on all devices, custom VS Code themes.

const THEME = JSON.stringify({ name: 'My Theme', type: 'dark', colors: { 'editor.background': '#101010', 'editor.foreground': '#e0e0e0' }, tokenColors: [] });
const base = { dark: 'catppuccin-mocha', light: 'xlr8', sans: 'geist', mono: 'local:Berkeley Mono', overrides: [] };

describe('appearance', () => {
  test('null until saved, then the same on all devices; empty overrides are dropped', async () => {
    const { owner } = setup();
    expect(await owner.query(api.appearance.get, {})).toEqual({ settings: null, themes: [] });
    await owner.mutation(api.appearance.save, { ...base, overrides: [{ theme: 'catppuccin-mocha', colors: { accent: '#ff00aa' } }, { theme: 'nord', colors: {} }] });
    const { settings } = await owner.query(api.appearance.get, {});
    expect(settings).toMatchObject({ ...base, overrides: [{ theme: 'catppuccin-mocha', colors: { accent: '#ff00aa' } }] });
    expect(settings!.updatedAt).toBeGreaterThan(0);
    // Replaces instead of adding a second row
    await owner.mutation(api.appearance.save, { ...base, sans: 'system' });
    expect((await owner.query(api.appearance.get, {})).settings?.sans).toBe('system');
  });

  test('rejects nonsense values (CSS must not escape from names or colors)', async () => {
    const { owner } = setup();
    await expectCode(owner.mutation(api.appearance.save, { ...base, dark: 'Not there!' }), 'invalid');
    await expectCode(owner.mutation(api.appearance.save, { ...base, sans: "local:x'}body{color:red" }), 'invalid');
    await expectCode(owner.mutation(api.appearance.save, { ...base, overrides: [{ theme: 'nord', colors: { accent: 'red;}' } }] }), 'invalid');
    await expectCode(owner.mutation(api.appearance.save, { ...base, overrides: [{ theme: 'nord', colors: { '--accent': '#000000' } }] }), 'invalid');
    await expectCode(owner.mutation(api.appearance.save, { ...base, dark: 'custom:k123' }), 'not_found');
  });
});

describe('custom themes', () => {
  test('create, rename, replace; list without JSON, JSON on its own', async () => {
    const { owner } = setup();
    const { id } = await owner.mutation(api.appearance.saveTheme, { name: '  My   Theme ', type: 'dark', source: THEME });
    const { themes } = await owner.query(api.appearance.get, {});
    expect(themes).toEqual([{ id, name: 'My Theme', type: 'dark', updatedAt: expect.any(Number) }]);
    expect((await owner.query(api.appearance.theme, { id }))?.source).toBe(THEME);
    await owner.mutation(api.appearance.renameTheme, { id, name: 'New' });
    expect((await owner.query(api.appearance.theme, { id }))?.name).toBe('New');
    await expectCode(owner.mutation(api.appearance.renameTheme, { id, name: '   ' }), 'invalid');
  });

  test('checks the JSON: valid, an object, with colors, not too large', async () => {
    const { owner } = setup();
    await expectCode(owner.mutation(api.appearance.saveTheme, { name: 'x', type: 'dark', source: '{ // comment\n}' }), 'invalid');
    await expectCode(owner.mutation(api.appearance.saveTheme, { name: 'x', type: 'dark', source: '[]' }), 'invalid');
    await expectCode(owner.mutation(api.appearance.saveTheme, { name: 'x', type: 'dark', source: '{"name":"x"}' }), 'invalid');
    const big = JSON.stringify({ colors: { a: 'x'.repeat(310_000) } });
    await expectCode(owner.mutation(api.appearance.saveTheme, { name: 'x', type: 'dark', source: big }), 'invalid');
  });

  test('selected and deleted: XLR8 applies there again, its colors are dropped', async () => {
    const { owner } = setup();
    const { id } = await owner.mutation(api.appearance.saveTheme, { name: 'A', type: 'dark', source: THEME });
    const ref = `custom:${id}`;
    await owner.mutation(api.appearance.save, { ...base, dark: ref, overrides: [{ theme: ref, colors: { accent: '#123456' } }, { theme: 'nord', colors: { accent: '#654321' } }] });
    expect(await owner.mutation(api.appearance.deleteTheme, { id })).toEqual({ removed: true });
    const { settings, themes } = await owner.query(api.appearance.get, {});
    expect(themes).toEqual([]);
    expect(settings).toMatchObject({ dark: 'xlr8', light: 'xlr8', overrides: [{ theme: 'nord', colors: { accent: '#654321' } }] });
    expect(await owner.mutation(api.appearance.deleteTheme, { id })).toEqual({ removed: false });
  });

  test('a dark theme that becomes light is no longer selected in dark mode', async () => {
    const { owner } = setup();
    const { id } = await owner.mutation(api.appearance.saveTheme, { name: 'A', type: 'dark', source: THEME });
    await owner.mutation(api.appearance.save, { ...base, dark: `custom:${id}` });
    await owner.mutation(api.appearance.saveTheme, { id, name: 'A', type: 'light', source: THEME });
    expect((await owner.query(api.appearance.get, {})).settings?.dark).toBe('xlr8');
  });

  test('a foreign identity cannot access themes', async () => {
    const { owner, stranger } = setup();
    const { id } = await owner.mutation(api.appearance.saveTheme, { name: 'A', type: 'dark', source: THEME });
    await expectCode(stranger.query(api.appearance.theme, { id }), 'access_denied');
    await expectCode(stranger.mutation(api.appearance.deleteTheme, { id }), 'access_denied');
  });
});
