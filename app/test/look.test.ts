import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN, loadBuiltin } from '../src/lib/look/builtin.ts';
import { contrast, ensureContrast, parseHex, toHex } from '../src/lib/look/color.ts';
import { fontCss, FONTS } from '../src/lib/look/fonts.ts';
import { mapTheme, MIN_SYNTAX, MIN_TEXT, MIN_UI, SYNTAX_SCOPES, tokenColor, VARS } from '../src/lib/look/map.ts';
import { compactSource, parseJsonc, readTheme, stripJsonc, ThemeError, type VsTheme } from '../src/lib/look/vscode.ts';
import { Look } from '../src/lib/look/index.ts';
import { selfboundSyntax, syntaxTheme } from '../src/lib/look/syntax.ts';
import { SWATCHES } from '../src/themes/swatches.ts';

// Themes and fonts: read JSONC, map VS Code colors, guarantee contrast.

const source = (id: string) => readFileSync(new URL(`../src/themes/${id}/theme.json`, import.meta.url), 'utf8');
const hex = (v: string) => parseHex(v)!;
const ratio = (a: string, b: string) => contrast(hex(a), hex(b));

describe('JSONC', () => {
  it('allows comments and trailing commas, leaves strings alone', () => {
    const text = `{
      // comment
      "a": "http://x.y/*not*/", /* block */
      "b": [1, 2, ],
      "c": { "d": "e, }", },
    }`;
    expect(parseJsonc(text)).toEqual({ a: 'http://x.y/*not*/', b: [1, 2], c: { d: 'e, }' } });
    expect(stripJsonc('"a\\"//b"')).toBe('"a\\"//b"');
  });
  it('reports broken JSON clearly', () => {
    expect(() => readTheme('{ "colors": ')).toThrow(ThemeError);
    expect(() => readTheme('[]')).toThrow('JSON object');
    expect(() => readTheme('{ "name": "x" }')).toThrow('neither');
    expect(() => readTheme('{ "include": "./base.json" }')).toThrow('includes');
  });
  it('tells light from dark by the surface, even if `type` is missing or wrong', () => {
    expect(readTheme('{"colors":{"editor.background":"#fafafa"}}').type).toBe('light');
    expect(readTheme('{"type":"dark","colors":{"editor.background":"#ffffff"}}').type).toBe('light');
    expect(readTheme('{"type":"light","tokenColors":[{"scope":"string","settings":{"foreground":"#00f"}}]}').type).toBe('light');
    const t = readTheme('{"name":"A","colors":{"editor.background":"#000"},"semanticHighlighting":true}');
    expect(JSON.parse(compactSource(t))).toEqual({ name: 'A', type: 'dark', colors: { 'editor.background': '#000' }, tokenColors: [] });
  });
});

describe('tokenColors', () => {
  const rules = [
    { scope: 'keyword', settings: { foreground: '#111111' } },
    { scope: ['keyword.control', 'storage'], settings: { foreground: '#222222' } },
    { scope: 'meta.tag string', settings: { foreground: '#333333' } },
    { scope: 'string, constant.numeric', settings: { foreground: '#444444' } },
    { scope: 'keyword.control', settings: { foreground: '#555555' } },
  ];
  it('longest prefix wins, on a tie the later rule; context selectors do not count', () => {
    expect(tokenColor(rules, 'keyword.operator')).toBe('#111111');
    expect(tokenColor(rules, 'keyword.control.flow')).toBe('#555555');
    expect(tokenColor(rules, 'string.quoted')).toBe('#444444');
    expect(tokenColor(rules, 'constant.numeric')).toBe('#444444');
    expect(tokenColor(rules, 'keywordx')).toBeNull();
    expect(tokenColor(rules, 'comment')).toBeNull();
  });
});

/** All pairs the mapping guarantees (as in map.ts). */
function checkContrast(vars: Record<string, string>) {
  const surfaces = ['bg-panel', 'bg-popover', 'bg-raised', 'bg-row-hover', 'bg-group', 'bg-control', 'selection', 'selection-hover'];
  const pairs: [string, string[], number][] = [
    ['text', [...surfaces, 'bg-app', 'bg-control-on', 'code-bg'], MIN_TEXT],
    ['text-strong', [...surfaces, 'bg-app', 'bg-control-on'], MIN_TEXT],
    ['text-muted', [...surfaces, 'bg-app'], MIN_TEXT],
    ['text-sidebar', ['bg-app', 'bg-sidebar-hover', 'bg-active'], MIN_TEXT],
    ['text-subtle', ['bg-panel', 'bg-popover', 'bg-raised'], MIN_TEXT],
    ['accent-text', ['bg-panel', 'bg-popover', 'bg-raised', 'bg-row-hover', 'selection'], MIN_TEXT],
    ['warning-text', surfaces, MIN_TEXT],
    ['danger-text', surfaces, MIN_TEXT],
    ['triage-text', surfaces, MIN_TEXT],
    ['accent-fg', ['accent', 'accent-hover'], MIN_TEXT],
    ['focus-ring', ['bg-panel', 'bg-popover', 'bg-raised', 'bg-control', 'bg-app'], MIN_UI],
    ...Object.keys(SYNTAX_SCOPES).map((name): [string, string[], number] => [name, ['code-bg'], MIN_SYNTAX]),
  ];
  const failures: string[] = [];
  for (const [fg, bgs, min] of pairs) {
    for (const bg of bgs) {
      const r = ratio(vars[fg], vars[bg]);
      if (r < min) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
    }
  }
  if (ratio('#ffffff', vars['toggle-off']) < MIN_UI) failures.push('switch knob on toggle-off');
  return failures;
}

describe('bundled themes', () => {
  it('every theme has a file and a license, the type matches', () => {
    for (const meta of BUILTIN) {
      const theme = readTheme(source(meta.id), { typeHint: meta.type });
      expect(theme.type, meta.id).toBe(meta.type);
      expect(Object.keys(theme.colors).length, meta.id).toBeGreaterThan(10);
      expect(readFileSync(new URL(`../src/themes/${meta.id}/LICENSE`, import.meta.url), 'utf8')).toMatch(/Permission is hereby granted/);
    }
  });
  it('loads only the chosen theme (one chunk per file)', async () => {
    const theme = await loadBuiltin('nord');
    expect(theme?.name).toBe('Nord');
    expect(await loadBuiltin('does-not-exist')).toBeNull();
  });
  it.each(BUILTIN.map((t) => t.id))('%s: all variables set; text, warning, error and focus readable', (id) => {
    const meta = BUILTIN.find((t) => t.id === id)!;
    const { vars, type } = mapTheme(readTheme(source(id), { typeHint: meta.type }));
    expect(type).toBe(meta.type);
    for (const v of VARS) expect(vars[v.name], v.name).toMatch(/^#[0-9a-f]{6}$/);
    expect(checkContrast(vars)).toEqual([]);
  });
  it('takes the theme colors where they are readable', () => {
    const { vars } = mapTheme(readTheme(source('catppuccin-mocha')));
    expect(vars['bg-panel']).toBe('#1e1e2e');
    expect(vars.text).toBe('#cdd6f4');
    // Catppuccin: dark text on a light accent instead of white
    expect(ratio(vars['accent-fg'], '#000000')).toBeLessThan(ratio(vars['accent-fg'], '#ffffff'));
    const dracula = mapTheme(readTheme(source('dracula'))).vars;
    expect(dracula['bg-panel']).toBe('#282a36');
    expect(dracula['syn-keyword']).toBe('#ff79c6');
    expect(dracula['syn-string']).toBe('#f1fa8c');
  });
  it('picker swatches match the mapping (otherwise: node app/scripts/theme-swatches.ts)', () => {
    for (const meta of BUILTIN) {
      const { vars } = mapTheme(readTheme(source(meta.id), { typeHint: meta.type }));
      expect(SWATCHES[meta.id], meta.id).toEqual([vars['bg-app'], vars['bg-panel'], vars.text, vars.accent, vars['syn-keyword'], vars['syn-string'], vars['syn-func']]);
    }
  });
});

describe('derivation and overrides', () => {
  const minimal: VsTheme = { name: 'Minimal', type: 'dark', colors: { 'editor.background': '#202020', 'editor.foreground': '#d0d0d0' }, tokenColors: [] };
  it('a theme with two colors gives a complete, readable palette', () => {
    const { vars } = mapTheme(minimal);
    for (const v of VARS) expect(vars[v.name], v.name).toMatch(/^#[0-9a-f]{6}$/);
    expect(checkContrast(vars)).toEqual([]);
    const light = mapTheme({ ...minimal, type: 'light', colors: { 'editor.background': '#fbfbfb', 'editor.foreground': '#444444' } });
    expect(checkContrast(light.vars)).toEqual([]);
  });
  it('overrides apply; too weak contrast is raised and reported', () => {
    const ok = mapTheme(minimal, { accent: '#3a6fe0', 'bg-panel': '#101010' });
    expect(ok.vars.accent).toBe('#3a6fe0');
    expect(ok.vars['bg-panel']).toBe('#101010');
    const bad = mapTheme(minimal, { 'danger-text': '#401010', text: '#303030' });
    expect(ratio(bad.vars['danger-text'], bad.vars['bg-panel'])).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(bad.fixes.map((f) => f.name)).toEqual(expect.arrayContaining(['danger-text', 'text']));
  });
  it('ensureContrast changes only lightness, and only as far as needed', () => {
    const bg = hex('#ffffff');
    const out = ensureContrast(hex('#ffcc00'), [bg], MIN_TEXT);
    expect(contrast(out, bg)).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(contrast(out, bg)).toBeLessThan(MIN_TEXT + 0.3);
    expect(toHex(ensureContrast(hex('#000000'), [bg], MIN_TEXT))).toBe('#000000');
  });
});

describe('fonts', () => {
  it('8 sans and 6 mono, all with Latin and Latin Extended', () => {
    expect(FONTS.filter((f) => f.kind === 'sans').length).toBe(8);
    expect(FONTS.filter((f) => f.kind === 'mono').length).toBe(6);
    for (const f of FONTS) {
      const css = fontCss(f.id, f.kind);
      expect(css.stack).toContain(f.family);
      expect(css.faces.match(/@font-face/g)).toHaveLength(2);
      expect(css.preload).toBeTruthy();
    }
  });
  it('local font only with a harmless name; system font without a file; wrong kind is dropped', () => {
    expect(fontCss('local:Berkeley Mono', 'mono').stack).toMatch(/^'Berkeley Mono', ui-monospace/);
    expect(fontCss("local:x'; } body { color: red", 'sans').stack).toBeNull();
    expect(fontCss('system', 'sans')).toEqual({ stack: expect.stringContaining('system-ui'), faces: '', preload: null });
    expect(fontCss('jetbrains-mono', 'sans').stack).toBeNull();
    expect(fontCss('inter', 'sans').stack).toBeNull();
  });
});

describe('syntax themes for code blocks', () => {
  const theme = (name: string) => readTheme(source(name), { typeHint: BUILTIN.find((t) => t.id === name)!.type });
  it('keep the TextMate rules and lift only their colors to 3 : 1 on the code block', () => {
    const t = theme('solarized-light');
    const mapped = mapTheme(t);
    const syntax = syntaxTheme(t, mapped);
    const bg = hex(mapped.vars['code-bg']);
    expect(syntax.theme.tokenColors.length).toBeGreaterThan(5);
    for (const rule of syntax.theme.tokenColors) {
      if (rule.settings?.foreground) expect(contrast(hex(rule.settings.foreground), bg), String(rule.scope)).toBeGreaterThanOrEqual(MIN_SYNTAX - 0.01);
    }
    expect(syntax.fg).toBe(mapped.vars.text);
    expect(syntax.theme.type).toBe('light');
  });
  it('a color changed in the settings comes after the theme rules', () => {
    const t = theme('dracula');
    const mapped = mapTheme(t, { 'syn-keyword': '#123456' });
    const syntax = syntaxTheme(t, mapped, { 'syn-keyword': '#ffee00' });
    const last = syntax.theme.tokenColors.filter((r) => Array.isArray(r.scope) && r.scope.includes('keyword.control'));
    expect(last.at(-1)?.settings?.foreground).toBe('#ffee00');
  });
  it('a changed color replaces the colors inside its category, deeper rules included, and nothing else', () => {
    const t: VsTheme = {
      name: 'Deep',
      type: 'dark',
      colors: { 'editor.background': '#202020', 'editor.foreground': '#d0d0d0' },
      tokenColors: [
        { scope: 'keyword.operator.new', settings: { foreground: '#aa1111' } },
        { scope: ['keyword.operator', 'storage.type.function'], settings: { foreground: '#22aa22' } },
        { scope: 'string', settings: { foreground: '#4444ff' } },
        { scope: 'comment', settings: { fontStyle: 'italic' } },
      ],
    };
    const mapped = mapTheme(t);
    const colorOf = (syntax: ReturnType<typeof syntaxTheme>, scope: string) => syntax.theme.tokenColors.find((r) => (Array.isArray(r.scope) ? r.scope : [r.scope]).includes(scope) && !(Array.isArray(r.scope) && r.scope.length > 2))?.settings?.foreground;
    const plain = syntaxTheme(t, mapped);
    const changed = syntaxTheme(t, mapped, { 'syn-keyword': '#ffee00' });
    expect(colorOf(changed, 'keyword.operator.new')).toBe('#ffee00');
    expect(colorOf(changed, 'storage.type.function')).toBe('#ffee00');
    // Operators and strings stay as the theme has them.
    expect(colorOf(changed, 'keyword.operator')).toBe(colorOf(plain, 'keyword.operator'));
    expect(colorOf(changed, 'string')).toBe(colorOf(plain, 'string'));
    // Font-style-only rules stay without a color.
    expect(changed.theme.tokenColors.find((r) => r.scope === 'comment')?.settings?.foreground).toBeUndefined();
  });
  it('the Selfbound colors are placeholders for CSS variables', () => {
    const s = selfboundSyntax('dark');
    expect(Object.values(s.palette!).every((v) => /^var\(--sx-[a-z]+\)$/.test(v))).toBe(true);
    expect(s.theme.tokenColors.some((r) => r.settings?.foreground && s.palette![r.settings.foreground])).toBe(true);
  });
  it('are built on first use from the chosen themes, matching type only', async () => {
    const look = new Look();
    look.settings.set({ ...look.settings.get(), dark: 'dracula', light: 'catppuccin-mocha' });
    const set = await look.syntaxThemes();
    expect(set.dark.theme.name).toBe('Dracula');
    // A dark theme in the light slot gives the Selfbound colors, like the CSS.
    expect(set.light.theme.name).toBe('Selfbound Light');
    expect(await look.syntaxThemes()).toBe(set);
  });
});
