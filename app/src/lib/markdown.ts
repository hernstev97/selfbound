// Markdown rendering: `marked` + `DOMPurify`, loaded on demand (not in the start bundle).
// Output is always sanitized; links open in a new tab; task lists render as checkboxes.
// Code blocks with a language get colored once `highlight.ts` (its own chunk) is loaded.
// The setup (rules, code blocks, images, Drive videos) lives in markdownRender.ts and loads with it.

type Highlighter = typeof import('./highlight.ts');
let highlighter: Highlighter | null = null;
let highlighterLoading: Promise<void> | null = null;

/** Does the text contain a fenced code block with a language (```ts)? Only then is loading worth it. */
export function needsHighlight(markdown: string) {
  // Also fences in quotes and lists (> ```ts, - ```ts).
  return /^(?:[ \t]*(?:>|[-*+]|\d+[.)]))*[ \t]*(?:`{3,}|~{3,})[ \t]*[^\s`]/m.test(markdown);
}

export function highlightReady() {
  return highlighter !== null;
}

/** Loads the highlighter; afterwards `renderMarkdown` colors code blocks (cache cleared). */
export function loadHighlight(): Promise<void> {
  highlighterLoading ??= import('./highlight.ts').then(
    (module) => {
      highlighter = module;
      cache.clear();
    },
    (error) => {
      highlighterLoading = null; // retry with the next text
      throw error;
    },
  );
  return highlighterLoading;
}

let render: ((markdown: string, teamKeys: ReadonlySet<string>) => string) | null = null;
let embeds: ((root: HTMLElement) => (() => void) | undefined) | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadMarkdown(): Promise<void> {
  loading ??= Promise.all([import('marked'), import('dompurify'), import('./markdownRender.ts')]).then(([{ Marked }, { default: DOMPurify }, setup]) => {
    render = setup.createRender(Marked, DOMPurify, (text, lang) => highlighter?.highlightCode(text, lang) ?? null);
    embeds = setup.driveEmbeds;
    for (const l of listeners) l();
    listeners.clear();
  });
  return loading;
}

export function markdownReady() {
  return render !== null;
}

// Remember recently rendered texts: peek and detail show the same description, and switching between
// list and issue often reopens the same one (marked + DOMPurify cost ~2 ms per text).
const cache = new Map<string, string>();
const CACHE_SIZE = 64;

/** Team keys: bare identifiers with these keys ("ACME-106") become links. */
let teamKeys: ReadonlySet<string> = new Set();
export function setLinkKeys(keys: readonly string[]) {
  const next = [...keys].sort().join(',');
  if (next === [...teamKeys].sort().join(',')) return;
  teamKeys = new Set(keys);
  cache.clear();
}

/** Sanitized HTML, or null while the library is loading. */
export function renderMarkdown(markdown: string): string | null {
  if (!render) return null;
  let html = cache.get(markdown);
  if (html !== undefined) {
    cache.delete(markdown);
  } else {
    html = render(markdown, teamKeys);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  cache.set(markdown, html);
  return html;
}

export function onMarkdownReady(cb: () => void) {
  if (render) cb();
  else {
    listeners.add(cb);
    void loadMarkdown();
  }
}

/** Insert Drive players into rendered Markdown once visible (markdownRender.ts). */
export function driveEmbeds(root: HTMLElement): (() => void) | undefined {
  return embeds?.(root);
}

/** Short plain version without Markdown syntax (peek, preview). */
export function plainText(markdown: string, max = 600) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/^\s*\[![A-Za-z]+\]\s*/gm, '') // info panel marker (the title stays)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}
