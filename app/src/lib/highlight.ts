// Syntax highlighting for code blocks and the editor: Shiki with the TextMate grammars and the VS
// Code theme from the appearance settings. Its own chunk, loaded only when a visible text contains
// a code block with a language; every grammar is a chunk of its own, loaded when a text uses it
// (`prepare`). Until then the block stays neutral. Nothing is guessed: without a (known) language
// it stays so.
//
// Dark and light are colored in one go: every token carries both colors as custom properties and
// md.css picks one by `data-theme`, so switching modes needs no new HTML.
import { createHighlighterCore, type HighlighterCore, type ThemedTokenWithVariants, type ThemeRegistrationRaw, type TokenStyles } from 'shiki/core';
import { escapeHtml } from './codeblock.ts';
import { languageFor } from './languages.ts';
import type { SyntaxSet, SyntaxTheme } from './look/syntax.ts';

// Grammars of the languages in languages.ts (their embedded languages come along with them).
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

/** Longer code stays neutral (tokenizing runs on the main thread). */
const MAX_CODE = 60_000;

/** Code block info string ("ts", "Svelte" …) to a grammar, otherwise null. */
export function languageOf(info: string | undefined): string | null {
  const grammar = languageFor(info)?.grammar;
  return grammar && grammar in GRAMMARS ? grammar : null;
}

let core: Promise<HighlighterCore> | null = null;
let highlighter: HighlighterCore | null = null;
let current: { set: SyntaxSet; dark: string; light: string } | null = null;
const grammars = new Map<string, Promise<void>>();
const loaded = new Set<string>();
const listeners = new Set<() => void>();

/** Called after the theme changed. */
export function onChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed() {
  for (const listener of [...listeners]) listener();
}

async function init(): Promise<HighlighterCore> {
  const [{ createEngine }, { look }] = await Promise.all([import('./highlightEngine.ts'), import('./look/index.ts')]);
  const hl = await createHighlighterCore({ themes: [], langs: [], engine: createEngine() });
  highlighter = hl;
  // Theme (or mode, colors) changed in the settings: load the new set and let everyone color again.
  look.syntax.subscribe(() => {
    const set = look.syntax.get();
    if (set && set.rev !== current?.set.rev) void useThemes(hl, set).then(changed);
  });
  return hl;
}

async function useThemes(hl: HighlighterCore, set: SyntaxSet) {
  if (current?.set.rev === set.rev) return;
  // Shiki keeps themes by name; a new set gets new names.
  const dark = `${set.dark.theme.name}#${set.rev}d`;
  const light = `${set.light.theme.name}#${set.rev}l`;
  await hl.loadTheme({ ...set.dark.theme, name: dark } as ThemeRegistrationRaw, { ...set.light.theme, name: light } as ThemeRegistrationRaw);
  if (!current || current.set.rev < set.rev) current = { set, dark, light };
}

/**
 * Loads Shiki, the current theme and the given grammars (names from `languageOf`). Afterwards
 * `highlightCode` and `codeRanges` color these languages. Resolves when everything is ready.
 */
export async function prepare(names: Iterable<string>): Promise<void> {
  core ??= init().catch((error) => {
    core = null; // retry with the next text
    throw error;
  });
  const [hl, { look }] = await Promise.all([core, import('./look/index.ts')]);
  await useThemes(hl, await look.syntaxThemes());
  const wanted = [...new Set(names)].filter((name) => name in GRAMMARS);
  await Promise.all(
    wanted.map((name) => {
      let load = grammars.get(name);
      if (!load) {
        load = hl.loadLanguage(GRAMMARS[name]() as never).then(
          () => void loaded.add(name),
          (error) => {
            grammars.delete(name);
            throw error;
          },
        );
        grammars.set(name, load);
      }
      return load;
    }),
  );
}

/** Are Shiki, the theme and this grammar loaded? (`names` from `languageOf`) */
export const isReady = (name: string) => !!highlighter && !!current && loaded.has(name);

const FONT_CLASS: [number, string][] = [
  [1, 'i'],
  [2, 'b'],
  [4, 'u'],
];

/** Color (only if it differs from plain code) and font style of one token in one mode, as CSS parts. */
function variant(styles: TokenStyles | undefined, theme: SyntaxTheme, mode: 'd' | 'l'): { color: string | null; classes: string } {
  let color: string | null = styles?.color?.toLowerCase() ?? null;
  if (color === theme.fg) color = null;
  else if (color && theme.palette) color = theme.palette[color] ?? color;
  let classes = '';
  const font = styles?.fontStyle ?? 0;
  if (font > 0) for (const [bit, name] of FONT_CLASS) if (font & bit) classes += ` tk-${mode}${name}`;
  return { color, classes };
}

/** Class and style attribute of a token, or null for plain code. */
function styleOf(token: ThemedTokenWithVariants): { cls: string; style: string } | null {
  const set = current!.set;
  const d = variant(token.variants.dark, set.dark, 'd');
  const l = variant(token.variants.light, set.light, 'l');
  if (!d.color && !l.color && !d.classes && !l.classes) return null;
  const style = [d.color && `--d:${d.color}`, l.color && `--l:${l.color}`].filter(Boolean).join(';');
  return { cls: `tk${d.classes}${l.classes}`, style };
}

function tokenize(code: string, info: string | undefined): ThemedTokenWithVariants[][] | null {
  const name = languageOf(info);
  if (!name || !highlighter || !current || !loaded.has(name) || code.length > MAX_CODE) return null;
  try {
    return highlighter.codeToTokensWithThemes(code, { lang: name, themes: { dark: current.dark, light: current.light } });
  } catch {
    return null;
  }
}

/** Highlighted HTML (spans with `tk` classes and color variables, text escaped), or null while not ready or without a known language. */
export function highlightCode(code: string, info: string | undefined): string | null {
  const lines = tokenize(code.replace(/\n$/, ''), info);
  if (!lines) return null;
  return lines
    .map((line) =>
      line
        .map((token) => {
          const text = escapeHtml(token.content);
          const l = styleOf(token);
          return l ? `<span class="${l.cls}"${l.style ? ` style="${l.style}"` : ''}>${text}</span>` : text;
        })
        .join(''),
    )
    .join('\n');
}

export interface CodeRange {
  from: number;
  to: number;
  cls: string;
  style: string;
}

/** Color ranges for the editor (offsets in the code, same classes and variables as in the rendered HTML), or null while not ready or without a known language. */
export function codeRanges(code: string, info: string | undefined): CodeRange[] | null {
  const lines = tokenize(code, info);
  if (!lines) return null;
  const ranges: CodeRange[] = [];
  for (const line of lines) {
    for (const token of line) {
      const l = styleOf(token);
      if (l) ranges.push({ from: token.offset, to: token.offset + token.content.length, cls: l.cls, style: l.style });
    }
  }
  return ranges;
}
