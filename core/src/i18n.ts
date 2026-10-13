// UI translations, gettext style: the English text is the key.
//
// English needs no dictionary, so it adds nothing to the start bundle. Another language is a
// dictionary chunk (English → translation) that the app loads before it creates the App instance (app/src/lib/locale-ready.ts).
//
// Rules (also in AGENTS.md, checked by tooling/i18n-check.mjs):
// - Every user-visible string goes through t(), tn() or tc(), or through a map built with translated().
// - Never call t() while a module is evaluated (top-level constants): the dictionary is not loaded
//   yet at that point. Call it at render or call time, or use translated() for constant label maps.
// - Placeholders are {name}; the German entry must use the same placeholders.

export type Locale = 'en' | 'de';
export const LOCALES: readonly Locale[] = ['en', 'de'];
/** Name of each language in that language, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch' };

/** Saved choice: a language or 'auto' (browser language, English if neither matches). */
export type LocalePref = Locale | 'auto';

/** A translation, or [singular, plural] for keys used with tn(). */
export type Entry = string | readonly [one: string, other: string];
export type Dictionary = Readonly<Record<string, Entry>>;

/** Separator between context and text in keys of tc(), as in gettext. */
const CONTEXT = '\u0004';

let current: Locale = 'en';
let dict: Dictionary | null = null;
let ready = false;
/** Keys looked up before setDictionary(): translated too early if the dictionary has them. */
const early = new Set<string>();

/** Language of the running app. */
export function locale(): Locale {
  return current;
}

/** BCP 47 tag for Intl and toLocaleString(). */
export function intlLocale(): string {
  return current === 'de' ? 'de-DE' : 'en-US';
}

/** Resolves the saved choice against the browser languages (navigator.languages). */
export function resolveLocale(pref: LocalePref | undefined, languages: readonly string[] = []): Locale {
  if (pref && pref !== 'auto' && LOCALES.includes(pref)) return pref;
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'en' || base === 'de') return base;
  }
  return 'en';
}

/**
 * Activates a language. English takes no dictionary. Returns the keys that were looked up before
 * this call and have a translation: those strings were rendered in English (see the rules above).
 */
export function setDictionary(next: Locale, entries: Dictionary | null): string[] {
  current = next;
  dict = next === 'en' ? null : entries;
  ready = true;
  const missed = dict ? [...early].filter((key) => key in dict!) : [];
  early.clear();
  return missed;
}

function lookup(key: string): Entry | undefined {
  if (!ready && early.size < 1000) early.add(key);
  return dict?.[key];
}

function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));
}

/** Translates a text. `t('{n} selected', { n: 3 })` */
export function t(text: string, params?: Record<string, string | number>): string {
  const entry = lookup(text);
  return fill(entry === undefined ? text : typeof entry === 'string' ? entry : entry[0], params);
}

/**
 * Singular or plural by count; the key is the singular. `{count}` is filled in.
 * `tn(n, '{count} issue', '{count} issues')`; German entry: ['{count} Issue', '{count} Issues'].
 */
export function tn(count: number, one: string, other: string, params?: Record<string, string | number>): string {
  const entry = lookup(one);
  const forms = entry === undefined ? [one, other] : typeof entry === 'string' ? [entry, entry] : entry;
  return fill(count === 1 ? forms[0] : forms[1], { count, ...params });
}

/** Translates a text that needs a different translation in another place. `tc('verb', 'Open')` */
export function tc(context: string, text: string, params?: Record<string, string | number>): string {
  const entry = lookup(`${context}${CONTEXT}${text}`);
  return fill(entry === undefined ? text : typeof entry === 'string' ? entry : entry[0], params);
}

/** Dictionary key for tc(), for dictionary files: `[ctx('verb', 'Open')]: 'Öffnen'`. */
export function ctx(context: string, text: string): string {
  return `${context}${CONTEXT}${text}`;
}

/** Marks a string for translation without translating it (translate later with t(value)). */
export function msg<S extends string>(text: S): S {
  return text;
}

/**
 * A constant label map whose values are translated on every read, so it is safe at module level:
 * `export const PRIORITY_LABEL = translated({ urgent: 'Urgent', high: 'High' })`.
 */
export function translated<T extends Record<string, string>>(map: T): T {
  const out = {} as T;
  for (const key of Object.keys(map) as (keyof T)[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => t(map[key] as string) });
  }
  return out;
}
