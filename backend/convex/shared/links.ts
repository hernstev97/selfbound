// References in text: detect links to knowledge pages and issues. Runs in the backend
// (articleLinks) and in the browser (shown as chips). Import nothing from Convex.

/**
 * Path of a knowledge page: /wiki/<id> (Convex ID: lowercase letters and digits). Older data has
 * /wissen/<id> in stored Markdown links; both are recognized.
 */
export const ARTICLE_PATH = '/wiki/';
const LEGACY_ARTICLE_PATH = '/wissen/';
const ARTICLE_RE = /\/(?:wiki|wissen)\/([a-z0-9]{16,40})(?![A-Za-z0-9_-])/g;
/** Path of an issue: /issue/KIU-106 */
const ISSUE_PATH_RE = /\/issue\/([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,6})(?![A-Za-z0-9_-])/g;
/**
 * Bare identifier in text: "KIU-106" in uppercase, not part of a word, path or longer identifier.
 * The caller decides whether the key is a team (UTF-8 and ISO-9001 are not).
 */
export const BARE_IDENTIFIER_RE = /(?<![\p{L}\p{N}_/.#-])([A-Z][A-Z0-9]{1,5})-([1-9]\d{0,5})(?![\p{L}\p{N}_-])/gu;

/** IDs of the knowledge pages the text links to (no duplicates, at most `max`). */
export function articleIdsIn(text: string, max = 100): string[] {
  if (!text.includes(ARTICLE_PATH) && !text.includes(LEGACY_ARTICLE_PATH)) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(ARTICLE_RE)) {
    out.add(m[1]!);
    if (out.size >= max) break;
  }
  return [...out];
}

/**
 * Issue identifiers in the text: links /issue/KIU-106 and bare identifiers with a key from
 * `teamKeys`. No duplicates, uppercase, at most `max`.
 */
export function issueRefsIn(text: string, teamKeys: ReadonlySet<string>, max = 100): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ISSUE_PATH_RE)) {
    out.add(`${m[1]!.toUpperCase()}-${Number(m[2])}`);
    if (out.size >= max) return [...out];
  }
  if (teamKeys.size === 0) return [...out];
  // Code (`…`, ```…```) does not count: identifiers there are mostly examples.
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ');
  for (const m of prose.matchAll(BARE_IDENTIFIER_RE)) {
    if (!teamKeys.has(m[1]!)) continue;
    out.add(`${m[1]}-${Number(m[2])}`);
    if (out.size >= max) break;
  }
  return [...out];
}
