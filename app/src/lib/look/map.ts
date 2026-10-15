// VS Code theme → Selfbound CSS custom properties. Each variable takes the user's override first, then
// the matching workbench key from `colors`, otherwise a value derived from the surface
// (editor.background) and text (editor.foreground). Then `ensureContrast` checks every pair that
// must be readable (text 4.5 : 1, focus ring 3 : 1) and shifts only the lightness until it passes.
// Syntax colors are approximated from `tokenColors`.
import { translated } from '@selfbound/core/i18n';
import { BLACK, contrast, ensureContrast, fromOklch, mix, over, parseHex, toHex, toOklch, WHITE, type Rgba } from './color.ts';
import type { ThemeType, TokenRule, VsTheme } from './vscode.ts';

/** Accent candidates; only colorful ones visible on the surface count (some themes have gray buttons or an invisible focusBorder). */
const ACCENT_KEYS = ['focusBorder', 'button.background', 'textLink.foreground', 'activityBarBadge.background', 'badge.background', 'progressBar.background'];

/** Status as text: list.* is meant for text in lists, editor*.foreground colors squiggles (Dracula: cyan warning). */
const WARNING_KEYS = ['list.warningForeground', 'editorWarning.foreground', 'terminal.ansiYellow', 'terminal.ansiBrightYellow'];
const DANGER_KEYS = ['errorForeground', 'list.errorForeground', 'editorError.foreground', 'terminal.ansiBrightRed', 'terminal.ansiRed'];

export const VAR_GROUPS = ['surfaces', 'lines', 'text', 'accent', 'status', 'code'] as const;
export type VarGroup = (typeof VAR_GROUPS)[number];
/** Group headings in the color editor. */
export const VAR_GROUP_LABEL: Record<VarGroup, string> = translated({ surfaces: 'Surfaces', lines: 'Lines', text: 'Text', accent: 'Accent', status: 'Status', code: 'Code' });

/** Display names of the overridable colors (translated on read). */
const VAR_LABEL: Record<string, string> = translated({
  'bg-app': 'Background (sidebar)',
  'bg-panel': 'Content',
  'bg-raised': 'Cards',
  'bg-popover': 'Menus and dialogs',
  'bg-row-hover': 'Row under the pointer',
  'bg-group': 'Group header',
  'bg-active': 'Active item (sidebar)',
  'bg-control': 'Buttons and fields',
  'bg-control-on': 'Pressed button',
  'bg-sidebar-hover': 'Sidebar under the pointer',
  selection: 'Selected row',
  'selection-hover': 'Selected row under the pointer',
  line: 'Dividers',
  border: 'Border',
  'border-strong': 'Strong border',
  'border-popover': 'Menu border',
  'text-strong': 'Headings',
  text: 'Text',
  'text-muted': 'Muted text',
  'text-sidebar': 'Sidebar text',
  'text-subtle': 'Placeholder',
  'text-faint': 'Ornaments (arrows, separators)',
  'toggle-off': 'Switch off',
  accent: 'Accent (buttons)',
  'accent-hover': 'Accent under the pointer',
  'accent-fg': 'Text on accent',
  'accent-text': 'Links',
  'focus-ring': 'Focus ring',
  'warning-text': 'Warning',
  'danger-text': 'Error',
  'triage-text': 'Triage',
  'code-bg': 'Code block',
  'syn-keyword': 'Keywords',
  'syn-string': 'Strings',
  'syn-regexp': 'Regular expressions',
  'syn-number': 'Numbers',
  'syn-literal': 'true, false, null',
  'syn-func': 'Functions',
  'syn-builtin': 'Built-in functions',
  'syn-type': 'Types and classes',
  'syn-variable': 'Variables and parameters',
  'syn-attr': 'HTML attributes',
  'syn-property': 'Properties and keys',
  'syn-tag': 'Tags',
  'syn-comment': 'Comments',
  'syn-add': 'Diff: added',
  'syn-del': 'Diff: removed',
});

export interface ThemeVar {
  /** CSS custom property without "--" */
  readonly name: string;
  /** Display name, translated on read */
  readonly label: string;
  readonly group: VarGroup;
  readonly keys: string[];
}

const VAR_LIST: Omit<ThemeVar, 'label'>[] = [
  { name: 'bg-app', group: 'surfaces', keys: ['sideBar.background', 'activityBar.background'] },
  { name: 'bg-panel', group: 'surfaces', keys: ['editor.background'] },
  { name: 'bg-raised', group: 'surfaces', keys: [] },
  { name: 'bg-popover', group: 'surfaces', keys: ['editorWidget.background', 'menu.background', 'quickInput.background', 'dropdown.background'] },
  { name: 'bg-row-hover', group: 'surfaces', keys: ['list.hoverBackground'] },
  { name: 'bg-group', group: 'surfaces', keys: ['sideBarSectionHeader.background'] },
  { name: 'bg-active', group: 'surfaces', keys: ['list.inactiveSelectionBackground'] },
  { name: 'bg-control', group: 'surfaces', keys: ['input.background', 'button.secondaryBackground'] },
  { name: 'bg-control-on', group: 'surfaces', keys: [] },
  { name: 'bg-sidebar-hover', group: 'surfaces', keys: ['list.hoverBackground'] },
  { name: 'selection', group: 'surfaces', keys: ['list.activeSelectionBackground'] },
  { name: 'selection-hover', group: 'surfaces', keys: [] },
  { name: 'line', group: 'lines', keys: ['editorGroup.border', 'panel.border', 'sideBar.border'] },
  { name: 'border', group: 'lines', keys: ['input.border', 'dropdown.border'] },
  { name: 'border-strong', group: 'lines', keys: ['contrastBorder'] },
  { name: 'border-popover', group: 'lines', keys: ['editorWidget.border', 'menu.border'] },
  { name: 'text-strong', group: 'text', keys: [] },
  { name: 'text', group: 'text', keys: ['editor.foreground', 'foreground'] },
  { name: 'text-muted', group: 'text', keys: ['descriptionForeground'] },
  { name: 'text-sidebar', group: 'text', keys: ['sideBar.foreground'] },
  { name: 'text-subtle', group: 'text', keys: ['input.placeholderForeground'] },
  { name: 'text-faint', group: 'text', keys: ['editorLineNumber.foreground'] },
  { name: 'toggle-off', group: 'text', keys: [] },
  { name: 'accent', group: 'accent', keys: ACCENT_KEYS },
  { name: 'accent-hover', group: 'accent', keys: ['button.hoverBackground'] },
  { name: 'accent-fg', group: 'accent', keys: ['button.foreground'] },
  { name: 'accent-text', group: 'accent', keys: ['textLink.foreground'] },
  { name: 'focus-ring', group: 'accent', keys: ['focusBorder'] },
  { name: 'warning-text', group: 'status', keys: WARNING_KEYS },
  { name: 'danger-text', group: 'status', keys: DANGER_KEYS },
  { name: 'triage-text', group: 'status', keys: [] },
  { name: 'code-bg', group: 'code', keys: [] },
  { name: 'syn-keyword', group: 'code', keys: [] },
  { name: 'syn-string', group: 'code', keys: [] },
  { name: 'syn-regexp', group: 'code', keys: [] },
  { name: 'syn-number', group: 'code', keys: [] },
  { name: 'syn-literal', group: 'code', keys: [] },
  { name: 'syn-func', group: 'code', keys: [] },
  { name: 'syn-builtin', group: 'code', keys: [] },
  { name: 'syn-type', group: 'code', keys: [] },
  { name: 'syn-variable', group: 'code', keys: [] },
  { name: 'syn-attr', group: 'code', keys: [] },
  { name: 'syn-property', group: 'code', keys: [] },
  { name: 'syn-tag', group: 'code', keys: [] },
  { name: 'syn-comment', group: 'code', keys: [] },
  { name: 'syn-add', group: 'code', keys: [] },
  { name: 'syn-del', group: 'code', keys: [] },
];

/** Overridable colors in settings order. */
export const VARS: ThemeVar[] = VAR_LIST.map((v) => ({
  ...v,
  get label() {
    return VAR_LABEL[v.name] ?? v.name;
  },
}));

/** TextMate scopes per syntax color, most important first (approximation for previews and swatches; code blocks read the theme itself, see syntax.ts). */
export const SYNTAX_SCOPES: Record<string, string[]> = {
  'syn-keyword': ['keyword.control', 'keyword', 'storage.type', 'storage'],
  'syn-string': ['string.quoted', 'string'],
  'syn-regexp': ['string.regexp'],
  'syn-number': ['constant.numeric', 'constant'],
  'syn-literal': ['constant.language', 'constant'],
  'syn-func': ['entity.name.function', 'meta.function-call', 'support.function'],
  'syn-builtin': ['support.function.builtin', 'support.function', 'variable.language'],
  'syn-type': ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  'syn-variable': ['variable.parameter', 'variable.other', 'variable'],
  'syn-attr': ['entity.other.attribute-name'],
  'syn-property': ['support.type.property-name', 'meta.object-literal.key', 'variable.other.property'],
  'syn-tag': ['entity.name.tag'],
  'syn-comment': ['comment'],
  'syn-add': ['markup.inserted'],
  'syn-del': ['markup.deleted'],
};

/** Without a matching rule: another syntax color (as in md.css) or a workbench color (diff). */
const SYNTAX_FALLBACK: Record<string, { from?: string; keys?: string[] }> = {
  'syn-regexp': { from: 'syn-string' },
  'syn-literal': { from: 'syn-number' },
  'syn-builtin': { from: 'syn-func' },
  'syn-variable': { from: 'text' },
  'syn-attr': { from: 'syn-type' },
  'syn-property': { from: 'syn-attr' },
  'syn-comment': { from: 'text-muted' },
  'syn-add': { keys: ['gitDecoration.addedResourceForeground', 'terminal.ansiGreen'] },
  'syn-del': { keys: ['gitDecoration.deletedResourceForeground', 'terminal.ansiRed'] },
};

/** Selfbound syntax colors (OKLCH as in md.css), for themes without a rule. */
const SYNTAX_DEFAULT: Record<ThemeType, Record<string, [number, number, number]>> = {
  dark: { 'syn-keyword': [0.76, 0.12, 300], 'syn-string': [0.8, 0.11, 150], 'syn-number': [0.8, 0.11, 65], 'syn-func': [0.79, 0.1, 250], 'syn-type': [0.8, 0.09, 195], 'syn-tag': [0.76, 0.12, 20], 'syn-add': [0.8, 0.11, 150], 'syn-del': [0.76, 0.12, 20] },
  light: { 'syn-keyword': [0.48, 0.16, 300], 'syn-string': [0.47, 0.11, 150], 'syn-number': [0.5, 0.13, 55], 'syn-func': [0.47, 0.14, 255], 'syn-type': [0.47, 0.09, 195], 'syn-tag': [0.5, 0.16, 20], 'syn-add': [0.47, 0.11, 150], 'syn-del': [0.5, 0.16, 20] },
};
const syntaxDefault = (type: ThemeType, name: string) => {
  const v = SYNTAX_DEFAULT[type][name];
  return v ? fromOklch({ l: v[0], c: v[1], h: v[2] }) : null;
};

/** Fixed values per mode as in app.css (shadows, dimming, status). */
const FIXED: Record<ThemeType, Record<string, string>> = {
  dark: {
    'icon-btn': 'rgb(255 255 255 / 0.02)',
    'icon-btn-ring': 'rgb(255 255 255 / 0.05)',
    'shadow-popover': '0 0 0 0.5px var(--border-popover), 0 8px 12px rgb(0 0 0 / 0.5), 0 0 64px rgb(0 0 0 / 0.45)',
    overlay: 'rgb(0 0 0 / 0.4)',
  },
  light: {
    'icon-btn': 'var(--bg-panel)',
    'icon-btn-ring': 'var(--border-strong)',
    'shadow-popover': '0 0 0 0.5px var(--border-popover), 0 4px 24px rgb(0 0 0 / 0.1)',
    overlay: 'rgb(0 0 0 / 0.18)',
  },
};

const DEFAULTS: Record<ThemeType, { panel: string; text: string; accent: string; warning: string; danger: string; triage: string }> = {
  dark: { panel: '#1e1e1e', text: '#cccccc', accent: '#5e6ad2', warning: '#f1bf00', danger: '#f26d6d', triage: '#ff7236' },
  light: { panel: '#ffffff', text: '#333333', accent: '#5e6ad2', warning: '#7d6400', danger: '#bf2a2a', triage: '#b34100' },
};

/** Mix ratios surface → text, measured from the Selfbound colors (app.css). */
const SHARE: Record<ThemeType, Record<string, number>> = {
  dark: { app: 0.25, rowHover: 0.035, group: 0.05, raised: 0.06, popover: 0.07, active: 0.085, control: 0.14, controlOn: 0.23, sidebarHover: 0.05, line: 0.06, border: 0.1, borderStrong: 0.135, borderPopover: 0.225, muted: 0.66, faint: 0.38, subtle: 0.64, toggle: 0.51, code: 0.045, selection: 0.2 },
  light: { app: 0.04, rowHover: 0.05, group: 0.035, raised: 0.01, popover: 0, active: 0.1, control: 0.055, controlOn: 0.1, sidebarHover: 0.04, line: 0.1, border: 0.1, borderStrong: 0.17, borderPopover: 0.17, muted: 0.75, faint: 0.45, subtle: 0.67, toggle: 0.67, code: 0.035, selection: 0.12 },
};

/** Readability: text 4.5 : 1 (WCAG AA), focus ring and switches 3 : 1. */
export const MIN_TEXT = 4.5;
export const MIN_UI = 3;
/**
 * Syntax colors 3 : 1 on the code block. They tell token kinds apart; the code itself is in --text
 * (4.5 : 1). At 4.5 : 1 light themes would lose almost all colors (Catppuccin Latte 8 of 11), and
 * comments would get brighter than the code.
 */
export const MIN_SYNTAX = 3;

export interface ContrastFix {
  name: string;
  before: string;
  after: string;
  /** Contrast before, against the hardest surface */
  ratio: number;
  min: number;
}

export interface MappedTheme {
  type: ThemeType;
  /** Name (without "--") → CSS value */
  vars: Record<string, string>;
  fixes: ContrastFix[];
  /** Status bar color (installed app) */
  bar: string;
}

/** Best match in tokenColors for a scope (as in VS Code: longest prefix wins, on a tie the later rule). */
export function tokenColor(rules: TokenRule[], scope: string): string | null {
  let best: { score: number; color: string } | null = null;
  for (const rule of rules) {
    const color = rule.settings?.foreground;
    if (!color || !rule.scope) continue;
    const selectors = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',');
    for (const raw of selectors) {
      const sel = String(raw).trim();
      // Selectors with context ("meta.tag string") or exclusions cannot match without a TextMate tree.
      if (!sel || /\s/.test(sel)) continue;
      if (scope !== sel && !scope.startsWith(sel + '.')) continue;
      const score = sel.split('.').length;
      if (!best || score >= best.score) best = { score, color };
    }
  }
  return best?.color ?? null;
}

/**
 * Maps a theme. `overrides`: name (without "--") → #rrggbb, taking precedence over any derived
 * value; the contrast check applies to them too.
 */
export function mapTheme(theme: VsTheme, overrides: Record<string, string> = {}): MappedTheme {
  const type = theme.type;
  const dark = type === 'dark';
  const d = DEFAULTS[type];
  const share = SHARE[type];
  const out: Record<string, Rgba> = {};
  const ov = (name: string) => parseHex(overrides[name]);
  /** First present workbench key, alpha composited over `base`. */
  const key = (base: Rgba, ...keys: string[]) => {
    for (const k of keys) {
      const c = parseHex(theme.colors[k]);
      if (c) return over(c, base);
    }
    return null;
  };
  // Round to 8 bits right away, otherwise writing as hex sometimes loses a hundredth of contrast.
  const set = (name: string, ...candidates: (Rgba | null | undefined)[]) => (out[name] = parseHex(toHex(ov(name) ?? candidates.find((c): c is Rgba => !!c)!))!);
  /** Theme surface only if text stays readable on it (some themes highlight selection strongly). */
  const readable = (c: Rgba | null, fg: Rgba) => (c && contrast(c, fg) >= MIN_TEXT ? c : null);
  /** Theme line only if it stands out from the surface (often transparent). */
  const visible = (c: Rgba | null, bg: Rgba) => (c && contrast(c, bg) >= 1.12 ? c : null);
  /** Dividers stay subtle as in Selfbound (some themes draw editor borders strongly). */
  const subtle = (c: Rgba | null, bg: Rgba) => (c && contrast(c, bg) >= 1.12 && contrast(c, bg) <= 1.8 ? c : null);
  /** Muted text only if it differs from the text (Catppuccin sets descriptionForeground = text). */
  const dimmer = (c: Rgba | null) => (c && contrast(c, panel) < contrast(text, panel) / 1.25 ? c : null);

  const base = dark ? BLACK : WHITE;
  const panel = set('bg-panel', key(base, 'editor.background'), parseHex(d.panel));
  const text = set('text', key(panel, 'editor.foreground', 'foreground'), parseHex(d.text));
  const m = (t: number) => mix(panel, text, t);
  const app = set('bg-app', key(panel, 'sideBar.background', 'activityBar.background'), dark ? mix(panel, BLACK, share.app) : m(share.app));
  const popover = set('bg-popover', key(panel, 'editorWidget.background', 'menu.background', 'quickInput.background', 'dropdown.background'), dark ? m(share.popover) : mix(panel, WHITE, 0.5));
  set('text-strong', mix(text, dark ? WHITE : BLACK, 0.5));
  const muted = set('text-muted', dimmer(key(panel, 'descriptionForeground')), m(share.muted));

  const fixes: ContrastFix[] = [];
  const fix = (name: string, bgs: string[], min: number) => {
    const surfaces = bgs.map((b) => out[b]);
    const before = out[name];
    const after = ensureContrast(before, surfaces, min);
    if (toHex(after) !== toHex(before)) {
      fixes.push({ name, before: toHex(before), after: toHex(after), ratio: Math.round(Math.min(...surfaces.map((s) => contrast(before, s))) * 100) / 100, min });
      out[name] = after;
    }
  };

  // ---- Accent first: selection, focus ring and links depend on it.
  const vivid = (k: string) => {
    const c = key(panel, k);
    return c && toOklch(c).c >= 0.05 && contrast(c, panel) >= 1.5 ? c : null;
  };
  const accentKey = ACCENT_KEYS.find((k) => vivid(k));
  set('accent', accentKey ? vivid(accentKey) : null, parseHex(d.accent));
  // Accent surfaces (switch on, check marks) stand out from the surface at 3 : 1.
  fix('accent', ['bg-panel'], MIN_UI);
  // Button text and hover only if the accent is the button color (whichever key it came from).
  const button = key(panel, 'button.background');
  const fromButton = !ov('accent') && !!button && toHex(button) === toHex(out.accent);
  const bestOn = (bg: Rgba) => (contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK);
  set('accent-fg', fromButton ? key(out.accent, 'button.foreground') : null, bestOn(out.accent));
  if (contrast(out['accent-fg'], out.accent) < MIN_TEXT && !ov('accent-fg')) out['accent-fg'] = bestOn(out.accent);
  fix('accent', ['accent-fg'], MIN_TEXT);
  set('accent-hover', fromButton ? key(panel, 'button.hoverBackground') : null, mix(out.accent, dark ? WHITE : BLACK, 0.1));
  fix('accent-hover', ['accent-fg'], MIN_TEXT);
  // Links only need to differ from the text (Gruvbox: muted teal).
  const link = key(panel, 'textLink.foreground');
  set('accent-text', link && toHex(link) !== toHex(text) && (toOklch(link).c >= 0.03 || contrast(link, text) >= 1.15) ? link : null, out.accent);
  const focus = key(panel, 'focusBorder');
  set('focus-ring', focus && contrast(focus, panel) >= 1.5 ? focus : null, out.accent);

  // ---- Surfaces. Derived surfaces give way first: better a flatter button than changed text. They
  // are pulled back toward the surface until text and muted text on them are no less readable than
  // on the content (requiring at most 4.5 : 1), but never below 30 %.
  const needText = Math.min(MIN_TEXT, contrast(text, panel));
  const needMuted = Math.min(MIN_TEXT, contrast(muted, panel));
  const fit = (from: Rgba, to: Rgba, t: number) => {
    const ok = (c: Rgba) => contrast(text, c) >= needText && contrast(muted, c) >= needMuted;
    let share = t;
    let c = mix(from, to, share);
    for (let i = 0; i < 12 && !ok(c) && share > t * 0.3; i++) c = mix(from, to, (share *= 0.85));
    return c;
  };
  set('bg-raised', fit(panel, text, share.raised));
  set('bg-row-hover', readable(key(panel, 'list.hoverBackground'), text), fit(panel, text, share.rowHover));
  set('bg-group', readable(visible(key(panel, 'sideBarSectionHeader.background'), panel), text), fit(panel, text, share.group));
  set('bg-control', readable(visible(key(panel, 'input.background', 'button.secondaryBackground'), panel), text), fit(panel, text, share.control));
  set('bg-control-on', fit(panel, text, share.controlOn));
  set('selection', readable(visible(key(panel, 'list.activeSelectionBackground'), panel), text), fit(panel, out.accent, share.selection));
  set('selection-hover', fit(out.selection, text, 0.04));
  set('bg-active', readable(key(app, 'list.inactiveSelectionBackground'), text), fit(app, text, share.active));
  set('bg-sidebar-hover', readable(key(app, 'list.hoverBackground'), text), fit(app, text, share.sidebarHover));
  // Not textCodeBlock.background: the syntax colors are made for the editor surface.
  const code = set('code-bg', fit(panel, text, share.code));
  set('line', subtle(key(panel, 'editorGroup.border', 'panel.border', 'sideBar.border'), panel), m(share.line));
  set('border', subtle(key(panel, 'input.border', 'dropdown.border'), panel), m(share.border));
  set('border-strong', visible(key(panel, 'contrastBorder'), panel), m(share.borderStrong));
  set('border-popover', visible(key(popover, 'editorWidget.border', 'menu.border'), popover), mix(popover, text, share.borderPopover));

  set('text-sidebar', dimmer(key(app, 'sideBar.foreground')), muted);
  set('text-subtle', dimmer(key(panel, 'input.placeholderForeground')), m(share.subtle));
  set('text-faint', key(panel, 'editorLineNumber.foreground'), m(share.faint));
  set('toggle-off', m(share.toggle));

  // ---- Status as text: only candidates with a matching hue and enough chroma (Solarized Dark has an
  // almost white errorForeground, Tokyo Night a gray one); of those, the one needing the least fix.
  const surfaces = ['bg-panel', 'bg-popover', 'bg-raised', 'bg-row-hover', 'bg-group', 'bg-control', 'selection', 'selection-hover'];
  const hueIn = (h: number, ranges: [number, number][]) => ranges.some(([a, b]) => h >= a && h <= b);
  const status = (name: string, keys: string[], hues: [number, number][], fallback: string) => {
    const bgs = surfaces.map((b) => out[b]);
    let best: Rgba | null = null;
    let bestShift = Infinity;
    for (const k of keys) {
      const c = key(panel, k);
      if (!c) continue;
      const o = toOklch(c);
      if (o.c < 0.08 || !hueIn(o.h, hues)) continue;
      const shift = Math.abs(toOklch(ensureContrast(c, bgs, MIN_TEXT)).l - o.l);
      if (shift < bestShift - 1e-4) [best, bestShift] = [c, shift];
    }
    set(name, best, parseHex(fallback));
  };
  status('warning-text', WARNING_KEYS, [[45, 115]], d.warning);
  status('danger-text', DANGER_KEYS, [[0, 45], [330, 360]], d.danger);
  set('triage-text', parseHex(d.triage));

  // ---- Syntax
  for (const [name, scopes] of Object.entries(SYNTAX_SCOPES)) {
    const found = scopes.map((s) => tokenColor(theme.tokenColors, s)).find(Boolean);
    const fb = SYNTAX_FALLBACK[name];
    const fallback = (fb?.from && out[fb.from]) || (fb?.keys && key(code, ...fb.keys)) || syntaxDefault(type, name) || text;
    set(name, found ? over(parseHex(found) ?? text, code) : null, fallback);
  }

  // ---- Text contrast. Order matters: surfaces are fixed, text adapts.
  fix('text', [...surfaces, 'bg-app', 'bg-control-on', 'code-bg'], MIN_TEXT);
  fix('text-strong', [...surfaces, 'bg-app', 'bg-control-on'], MIN_TEXT);
  fix('text-muted', [...surfaces, 'bg-app'], MIN_TEXT);
  fix('text-sidebar', ['bg-app', 'bg-sidebar-hover', 'bg-active'], MIN_TEXT);
  fix('text-subtle', ['bg-panel', 'bg-popover', 'bg-raised'], MIN_TEXT);
  // Placeholder never stronger than muted text.
  if (contrast(out['text-subtle'], panel) > contrast(out['text-muted'], panel) && !ov('text-subtle')) out['text-subtle'] = out['text-muted'];
  fix('accent-text', ['bg-panel', 'bg-popover', 'bg-raised', 'bg-row-hover', 'selection'], MIN_TEXT);
  for (const name of ['warning-text', 'danger-text', 'triage-text']) fix(name, surfaces, MIN_TEXT);
  fix('focus-ring', ['bg-panel', 'bg-popover', 'bg-raised', 'bg-control', 'bg-app'], MIN_UI);
  // White knob on the "off" switch.
  out.white = WHITE;
  fix('toggle-off', ['white'], MIN_UI);
  delete out.white;
  for (const name of Object.keys(SYNTAX_SCOPES)) fix(name, ['code-bg'], MIN_SYNTAX);

  const vars: Record<string, string> = {};
  for (const [name, c] of Object.entries(out)) vars[name] = toHex(c);
  vars['syn-add-bg'] = `${toHex(out['syn-add'])}1f`;
  vars['syn-del-bg'] = `${toHex(out['syn-del'])}1f`;
  Object.assign(vars, FIXED[type]);
  return { type, vars, fixes, bar: toHex(app) };
}

/** CSS block for one mode, e.g. `:root[data-theme='dark']{--bg-app:#…;…}`. */
export function themeCss(mode: ThemeType, vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([name, value]) => `--${name}:${value}`)
    .join(';');
  return `:root[data-theme='${mode}']{${body}}`;
}

/** Inline style for a preview (variables only in this element). */
export function previewStyle(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `--${name}:${value}`)
    .join(';');
}

/**
 * Preview of the Selfbound colors: syntax colors as in md.css, and every variable that only themes set
 * reset to its default (otherwise the preview would inherit it from the active theme).
 */
export function selfboundPreviewStyle(type: ThemeType): string {
  const vars: Record<string, string> = { 'accent-fg': 'white' };
  for (const name of Object.keys(SYNTAX_SCOPES)) {
    const c = syntaxDefault(type, name);
    vars[name] = c ? toHex(c) : 'initial';
  }
  return previewStyle(vars);
}

/** Readable name of a variable for notes. */
export function varLabel(name: string): string {
  return VARS.find((v) => v.name === name)?.label ?? name;
}
