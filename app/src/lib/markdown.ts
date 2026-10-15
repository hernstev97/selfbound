// Markdown rendering: `marked` + `DOMPurify`, loaded on demand (not in the start bundle).
// Output is always sanitized; links open in a new tab; task lists render as checkboxes.
// Code blocks with a language get colored once the highlighter (`highlight.ts`, loaded by
// highlightLoad.ts) is there; until then they are neutral text in the same place.
// The setup (rules, code blocks, images, Drive videos) lives in markdownRender.ts and loads with it.

let highlighter: typeof import('./highlight.ts') | null = null;
const highlightListeners = new Set<() => void>();
let version = 0;

/** Highlighted HTML for code in a known language, or null while it is not ready. */
export const highlightedCode = (code: string, info: string) => highlighter?.highlightCode(code, info) ?? null;

/** Changes when colors can come out differently (loaded, other theme); rendered HTML from before is stale then. */
export const highlightVersion = () => version;

/** Called after highlighting became available or changed (a new version). Returns the unsubscribe function. */
export function onHighlightChange(listener: () => void) {
  highlightListeners.add(listener);
  return () => void highlightListeners.delete(listener);
}

/** For highlightLoad.ts: the loaded highlighter. */
export function setHighlighter(module: typeof import('./highlight.ts')) {
  highlighter = module;
}

/** For highlightLoad.ts: grammars or theme changed. Rendered HTML is stale, everyone renders again. */
export function highlightChanged() {
  version++;
  cache.clear();
  for (const listener of [...highlightListeners]) listener();
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

/** Cards for YouTube and X links (embedCards.ts, own chunk, loaded only for texts that have one). */
export function cardEmbeds(root: HTMLElement): (() => void) | undefined {
  if (!root.querySelector('.embed[data-embed]')) return;
  let stop: (() => void) | undefined;
  let dead = false;
  void import('./embedCards.ts').then(
    (module) => {
      if (!dead) stop = module.mountEmbeds(root);
    },
    () => {}, // the links stay links
  );
  return () => {
    dead = true;
    stop?.();
  };
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
