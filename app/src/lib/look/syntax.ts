// Syntax themes for code blocks: the chosen VS Code theme in the form the highlighter (Shiki) reads
// directly. TextMate rules stay as they are (context selectors, font styles); only the colors
// are lifted to MIN_SYNTAX against the code block, as before. Pure and without Shiki, so the look
// module can build it before the highlighter is loaded.
import { ensureContrast, over, parseHex, toHex } from './color.ts';
import { MIN_SYNTAX, SYNTAX_SCOPES, type MappedTheme } from './map.ts';
import type { ThemeType, TokenRule, VsTheme } from './vscode.ts';

export interface SyntaxTheme {
  /** VS Code theme format (Shiki `ThemeRegistrationRaw`) */
  theme: { name: string; type: ThemeType; colors: Record<string, string>; tokenColors: TokenRule[] };
  /** Color of plain code; tokens in it need no span */
  fg: string;
  /** Placeholder color → CSS value, for the Selfbound colors (they follow the CSS variables) */
  palette?: Record<string, string>;
}

/** Dark and light syntax theme; `rev` changes with every new set. */
export interface SyntaxSet {
  rev: number;
  dark: SyntaxTheme;
  light: SyntaxTheme;
}

/**
 * The syntax color a scope selector belongs to: the category with the longest matching scope
 * (`constant.numeric` → number, not literal). Operators keep their own color: most themes set one
 * on purpose; only the word operators (`new`, `typeof`, `in`) count as keywords.
 */
function categoryOf(selector: string): string | undefined {
  if (/\s/.test(selector)) return undefined; // with context: cannot be assigned
  if (/^keyword\.operator(\.|$)/.test(selector) && !/^keyword\.operator\.(new|expression|word)(\.|$)/.test(selector)) return undefined;
  let best: { name: string; length: number } | undefined;
  for (const [name, scopes] of Object.entries(SYNTAX_SCOPES)) {
    for (const scope of scopes) {
      const length = scope.split('.').length;
      if ((selector === scope || selector.startsWith(`${scope}.`)) && (!best || length > best.length)) best = { name, length };
    }
  }
  return best?.name;
}

/** A VS Code theme (or its overrides) as a syntax theme; `mapped` provides the code block surface. */
export function syntaxTheme(theme: VsTheme, mapped: MappedTheme, overrides: Record<string, string> = {}): SyntaxTheme {
  const bg = parseHex(mapped.vars['code-bg'])!;
  const lifted = new Map<string, string | null>();
  const lift = (color: string | undefined) => {
    if (!color) return undefined;
    let out = lifted.get(color);
    if (out === undefined) {
      const c = parseHex(color);
      out = c ? toHex(ensureContrast(over(c, bg), [bg], MIN_SYNTAX)) : null;
      lifted.set(color, out);
    }
    return out ?? undefined;
  };
  // Colors changed in the settings replace the colors of the rules inside their category (the same
  // rules the theme's color for it comes from), so deeper theme rules (`keyword.operator.new`) follow
  // too; a rule behind them covers what the theme does not set. Rules of other categories and
  // deliberate extras (operators) stay. Rules without a scope set the default colors in VS Code;
  // the code block brings its own.
  const changed = new Map<string, string>();
  for (const name of Object.keys(SYNTAX_SCOPES)) {
    const color = lift(overrides[name]);
    if (color) changed.set(name, color);
  }
  const tokenColors: TokenRule[] = [];
  for (const rule of theme.tokenColors) {
    if (!rule.scope || !rule.settings) continue;
    const { foreground, fontStyle } = rule.settings;
    if (!foreground || !changed.size) {
      tokenColors.push({ scope: rule.scope, settings: { foreground: lift(foreground), fontStyle } });
      continue;
    }
    const rest: string[] = [];
    const own = new Map<string, string[]>();
    for (const sel of (Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',')).map((s) => String(s).trim()).filter(Boolean)) {
      const color = changed.get(categoryOf(sel) ?? '');
      if (color) own.set(color, [...(own.get(color) ?? []), sel]);
      else rest.push(sel);
    }
    if (rest.length) tokenColors.push({ scope: rest, settings: { foreground: lift(foreground), fontStyle } });
    for (const [color, scope] of own) tokenColors.push({ scope, settings: { foreground: color, fontStyle } });
  }
  for (const [name, color] of changed) tokenColors.push({ scope: SYNTAX_SCOPES[name]!, settings: { foreground: color } });
  const fg = mapped.vars.text;
  return {
    theme: { name: theme.name, type: mapped.type, colors: { 'editor.foreground': fg, 'editor.background': mapped.vars['code-bg'] }, tokenColors },
    fg,
  };
}

// ---- Selfbound colors (no VS Code theme chosen)

/** Category → `--sx-*` variable (md.css chains them to the `--syn-*` colors like the old highlight.js rules). */
const CATEGORIES = ['keyword', 'string', 'number', 'literal', 'func', 'type', 'tag', 'attr', 'comment', 'regexp', 'builtin', 'property', 'add', 'del'] as const;
type Category = (typeof CATEGORIES)[number];

const PLAIN = '#fe0000';
const PLACEHOLDER = Object.fromEntries(CATEGORIES.map((c, i) => [c, `#fe${(i + 1).toString(16).padStart(2, '0')}00`])) as Record<Category, string>;

/** Few and broad on purpose: the Selfbound palette has about a dozen colors, identifiers stay plain. Later rules win ties. */
const RULES: [Category | 'plain', string[], string?][] = [
  ['keyword', ['keyword', 'storage']],
  ['plain', ['keyword.operator']],
  ['keyword', ['keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.word', 'keyword.operator.logical.python']],
  ['number', ['constant.numeric', 'keyword.other.unit']],
  ['literal', ['constant.language']],
  ['string', ['string', 'markup.inline.raw', 'beginning.punctuation.definition.list']],
  ['regexp', ['string.regexp']],
  ['func', ['entity.name.function', 'support.function', 'markup.heading', 'entity.name.section']],
  ['builtin', ['variable.language']],
  ['type', ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class']],
  ['tag', ['entity.name.tag', 'punctuation.definition.tag']],
  ['attr', ['entity.other.attribute-name']],
  ['property', ['support.type.property-name', 'meta.object-literal.key', 'entity.name.tag.yaml']],
  ['number', ['markup.underline.link', 'string.other.link']],
  ['comment', ['comment', 'punctuation.definition.comment'], 'italic'],
  ['plain', ['markup.bold'], 'bold'],
  ['plain', ['markup.italic'], 'italic'],
  ['add', ['markup.inserted']],
  ['del', ['markup.deleted']],
];

const SELFBOUND_NAME: Record<ThemeType, string> = { dark: 'Selfbound Dark', light: 'Selfbound Light' };

export function selfboundSyntax(type: ThemeType): SyntaxTheme {
  const palette: Record<string, string> = {};
  for (const c of CATEGORIES) palette[PLACEHOLDER[c]] = `var(--sx-${c})`;
  const tokenColors: TokenRule[] = RULES.map(([category, scope, fontStyle]) => ({
    scope,
    settings: { foreground: category === 'plain' ? PLAIN : PLACEHOLDER[category], fontStyle },
  }));
  return {
    theme: { name: SELFBOUND_NAME[type], type, colors: { 'editor.foreground': PLAIN, 'editor.background': type === 'dark' ? '#000000' : '#ffffff' }, tokenColors },
    fg: PLAIN,
    palette,
  };
}

/** Both modes; a missing or wrongly typed VS Code theme gives the Selfbound colors for that mode. */
export function syntaxSet(rev: number, dark: SyntaxTheme | null, light: SyntaxTheme | null): SyntaxSet {
  return { rev, dark: dark ?? selfboundSyntax('dark'), light: light ?? selfboundSyntax('light') };
}

/** Do two sets color the same? (rev apart) */
export const sameSyntax = (a: SyntaxSet, b: SyntaxSet) => JSON.stringify([a.dark, a.light]) === JSON.stringify([b.dark, b.light]);
