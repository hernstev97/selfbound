// Loading the highlighter for the texts that need it (Markdown view, GitHub HTML). Light on its own:
// the highlighter, the theme and each grammar are chunks that load only when a visible text has a
// code block in that language. Claimed fences (codeblock.ts `claimFence`) are not asked for.
import { fenceClaim } from './codeblock.ts';
import { highlightChanged, setHighlighter } from './markdown.ts';
import { languageFor } from './languages.ts';

type Highlighter = typeof import('./highlight.ts');
let highlighter: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

const FENCE = /^(?:[ \t]*(?:>|[-*+]|\d+[.)]))*[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`]+)/gm;

/** Grammars of the fenced code blocks in a text (known languages only, none another renderer claims). */
export function fenceGrammars(markdown: string): string[] {
  const names = new Set<string>();
  // Also fences in quotes and lists (> ```ts, - ```ts).
  for (const m of markdown.matchAll(FENCE)) {
    const grammar = fenceClaim(m[1]) ? null : languageFor(m[1])?.grammar;
    if (grammar) names.add(grammar);
  }
  return [...names];
}

/** Does the text contain a fenced code block with a known language? Only then is loading worth it. */
export const needsHighlight = (markdown: string) => fenceGrammars(markdown).length > 0;

/** Are the highlighter, the theme and these grammars loaded? */
export const grammarsReady = (names: readonly string[]) => highlighter !== null && names.every((name) => highlighter!.isReady(name));

/** Is everything loaded that coloring this text needs? */
export const highlightReady = (markdown: string) => grammarsReady(fenceGrammars(markdown));

/** Loads the highlighter, the theme and the grammars the text uses; afterwards the rendered Markdown is colored. */
export const loadHighlight = (markdown: string) => loadGrammars(fenceGrammars(markdown));

/** Loads the highlighter, the theme and these grammars (names from `languageFor`). */
export async function loadGrammars(names: readonly string[]): Promise<void> {
  loading ??= import('./highlight.ts').then(
    (module) => {
      highlighter = module;
      setHighlighter(module);
      module.onChange(highlightChanged);
      return module;
    },
    (error) => {
      loading = null; // retry with the next text
      throw error;
    },
  );
  const module = await loading;
  await module.prepare(names);
  highlightChanged();
}
