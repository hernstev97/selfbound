// Media from private repos in GitHub HTML: pure, no network.
//
// GitHub's `body_html` points to files a browser cannot load without being signed in to GitHub:
// - repo files (raw.githubusercontent.com, github.com/…/blob|raw/…): on every request the proxy
//   fetches a fresh `download_url` through the Contents API.
// - uploaded attachments (private-user-images.githubusercontent.com, signature valid for 5 minutes):
//   a fine-grained token cannot resolve github.com/user-attachments. The proxy redirects to the
//   signed URL from the last fetch; if that is too old, it re-fetches the post (description or
//   comment) and takes the fresh URL of the same file (UUID).
// These URLs are replaced by `<site>/ghmedia/<mediaKey>/<index>`. Bytes never pass through
// Convex. Other repos and hosts stay as they are.

export const MEDIA_PATH = '/ghmedia/';
/** at most this many media per PR (beyond that, URLs stay unchanged) */
export const MEDIA_MAX = 300;
/** signed URLs are valid for 5 minutes; younger than this, the proxy redirects without re-fetching */
export const SIGNED_FRESH_MS = 4 * 60_000;

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PRIVATE_IMAGE_FILE = new RegExp(`^\\d+-(${UUID})\\.([A-Za-z0-9]+)$`, 'i');

/** Entry in `pullRequestDetails.media`; the index is the number in the proxy path. */
export interface MediaEntry {
  kind: 'repo' | 'attachment';
  /** repo: raw.githubusercontent.com URL · attachment: signed URL from the last fetch */
  url: string;
  /** attachment: time of the fetch `url` comes from */
  signedAt?: number;
  /** attachment: post the file comes from ('body' or an item key like "comment:123") */
  source?: string;
}

export type MediaRef =
  | {
      kind: 'repo';
      /** raw.githubusercontent.com/<owner>/<name>/<ref>/<path> */
      url: string;
      /** media file extension (only then are links rewritten too) */
      media: boolean;
      video: boolean;
      /** github.com/…/blob/… without ?raw=true: as a link it is a file page, so only rewrite it as an image source */
      blobPage?: boolean;
    }
  | { kind: 'attachment'; url: string; uuid: string; media: boolean; video: boolean; blobPage?: undefined };

const sameRepo = (owner: string, name: string, repo: string) => `${owner}/${name}`.toLowerCase() === repo.toLowerCase();

/** UUID of an uploaded file from a private-user-images URL (or null). */
export function attachmentUuid(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'private-user-images.githubusercontent.com') return null;
  const m = PRIVATE_IMAGE_FILE.exec(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

/** Classifies a URL; null = don't rewrite (other host, other repo, unknown form). */
export function classifyMediaUrl(raw: string, repo: string): MediaRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const segs = url.pathname.split('/').filter(Boolean);
  const file = segs[segs.length - 1] ?? '';
  const host = url.hostname.toLowerCase();
  if (host === 'raw.githubusercontent.com') {
    if (segs.length < 4 || !sameRepo(segs[0]!, segs[1]!, repo)) return null;
    // owner/name in the PR repo's spelling: the same file yields the same entry
    return { kind: 'repo', url: `https://raw.githubusercontent.com/${[repo, ...segs.slice(2)].join('/')}`, media: MEDIA_EXT.test(file), video: VIDEO_EXT.test(file) };
  }
  if (host === 'github.com') {
    if (segs.length < 5 || (segs[2] !== 'blob' && segs[2] !== 'raw') || !sameRepo(segs[0]!, segs[1]!, repo)) return null;
    return {
      kind: 'repo',
      url: `https://raw.githubusercontent.com/${[repo, ...segs.slice(3)].join('/')}`,
      media: MEDIA_EXT.test(file),
      video: VIDEO_EXT.test(file),
      ...(segs[2] === 'blob' && url.searchParams.get('raw') !== 'true' ? { blobPage: true } : {}),
    };
  }
  const uuid = attachmentUuid(raw);
  if (uuid) return { kind: 'attachment', url: raw, uuid, media: MEDIA_EXT.test(file), video: VIDEO_EXT.test(file) };
  return null;
}

/** For the proxy: repo file from `media` → segments after owner/name; only the PR repo. */
export function repoFileTarget(stored: string, repo: string): string[] | null {
  let url: URL;
  try {
    url = new URL(stored);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'raw.githubusercontent.com') return null;
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length < 4 || !sameRepo(segs[0]!, segs[1]!, repo)) return null;
  if (segs.some((s) => s === '..' || s === '.')) return null;
  return segs.slice(2);
}

/** Identity of an entry for lookup: URL or UUID. */
export function mediaId(entry: Pick<MediaEntry, 'kind' | 'url'>): string {
  return entry.kind === 'attachment' ? `attachment:${attachmentUuid(entry.url) ?? entry.url}` : `repo:${entry.url}`;
}

export interface MediaState {
  siteUrl: string;
  mediaKey: string;
  repo: string;
  /** extended or updated in place; existing entries keep their index */
  media: MediaEntry[];
  /** time of the fetch (for signed URLs) */
  now: number;
  /** post whose HTML is being rewritten ('body' or an item key) */
  source: string;
}

const ATTR_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&#x26;': '&',
  '&#38;': '&',
  '&amp;': '&',
};

/** One pass: `&#x26;amp;` must come out as `&amp;`, not `&` (a second pass would decode twice). */
function decodeAttr(value: string) {
  return value.replace(/&(?:quot|lt|gt|amp|#39|#38|#[xX](?:27|26));/g, (m) => ATTR_ENTITIES[m.replace('X', 'x')] ?? m);
}

/** Proxy URL for a media URL, or null (don't rewrite). */
function proxyFor(ref: MediaRef, state: MediaState): string | null {
  const id = ref.kind === 'attachment' ? `attachment:${ref.uuid}` : `repo:${ref.url}`;
  let index = state.media.findIndex((m) => mediaId(m) === id);
  if (ref.kind === 'attachment') {
    const entry: MediaEntry = { kind: 'attachment', url: ref.url, signedAt: state.now, source: state.source };
    if (index >= 0) state.media[index] = entry;
    else if (state.media.length < MEDIA_MAX) index = state.media.push(entry) - 1;
  } else if (index < 0 && state.media.length < MEDIA_MAX) {
    index = state.media.push({ kind: 'repo', url: ref.url }) - 1;
  }
  return index < 0 ? null : `${state.siteUrl}${MEDIA_PATH}${state.mediaKey}/${index}`;
}

const SRC_ATTRS = new Set(['src', 'poster', 'data-canonical-src']);

function rewriteValue(attr: string, value: string, state: MediaState): string | null {
  if (attr === 'srcset') {
    // GitHub only uses srcset with a single URL (<picture> for light/dark); leave anything else alone.
    const m = /^\s*(\S+)(\s+\S+)?\s*$/.exec(value);
    if (!m) return null;
    const ref = classifyMediaUrl(decodeAttr(m[1]!), state.repo);
    const proxy = ref ? proxyFor(ref, state) : null;
    return proxy ? `${proxy}${m[2] ?? ''}` : null;
  }
  const ref = classifyMediaUrl(decodeAttr(value), state.repo);
  if (!ref) return null;
  if (attr === 'href' && (!ref.media || ref.blobPage)) return null;
  if (!SRC_ATTRS.has(attr) && attr !== 'href') return null;
  return proxyFor(ref, state);
}

const TAG_RE = /<(img|video|source|a)\b([^>]*)>/gi;
const ATTR_RE = /(\s)(src|href|srcset|poster|data-canonical-src)(\s*=\s*)("([^"]*)"|'([^']*)')/gi;

function rewriteTag(tag: string, state: MediaState): string {
  return tag.replace(ATTR_RE, (whole, space: string, name: string, eq: string, _q: string, dq?: string, sq?: string) => {
    const value = dq ?? sq ?? '';
    const next = rewriteValue(name.toLowerCase(), value, state);
    return next === null ? whole : `${space}${name}${eq}"${next}"`;
  });
}

// A paragraph that consists of a single link (no nested paragraphs or links in the link text).
const LONE_LINK_RE = /<p\b([^>]*)>\s*<a\b([^>]*)>((?:(?!<\/?(?:a|p)\b)[\s\S]){0,2000})<\/a>\s*<\/p>/gi;
const HREF_RE = /\shref\s*=\s*("([^"]*)"|'([^']*)')/i;

/**
 * Rewrites media in GitHub HTML (see above). A link to a video that stands alone in a paragraph
 * also gets a <video> in front of it (as GitHub renders uploaded videos).
 */
export function rewriteMedia(html: string, state: MediaState): string {
  if (!html) return html;
  const withVideos = html.replace(LONE_LINK_RE, (whole, pAttrs: string, aAttrs: string, text: string) => {
    const href = HREF_RE.exec(aAttrs);
    const value = href ? (href[2] ?? href[3] ?? '') : '';
    const ref = value ? classifyMediaUrl(decodeAttr(value), state.repo) : null;
    if (!ref || !ref.video || ref.blobPage) return whole;
    const proxy = proxyFor(ref, state);
    if (!proxy) return whole;
    const link = `<a${aAttrs.replace(HREF_RE, ` href="${proxy}"`)}>${text}</a>`;
    return `<video controls preload="metadata" src="${proxy}"></video><p${pAttrs}>${link}</p>`;
  });
  return withVideos.replace(TAG_RE, (tag) => rewriteTag(tag, state));
}

/** Fresh signed URL of the same uploaded file (UUID) in re-fetched HTML. */
export function findSignedUrl(html: string, uuid: string): string | null {
  for (const m of html.matchAll(/\s(?:src|href|data-canonical-src)\s*=\s*"([^"]*)"/gi)) {
    const url = decodeAttr(m[1]!);
    if (attachmentUuid(url) === uuid.toLowerCase()) return url;
  }
  return null;
}

// ---------------------------------------------------------------- Truncation

const encoder = new TextEncoder();
export const byteLength = (s: string) => encoder.encode(s).length;

/**
 * Truncates HTML to at most `maxBytes` (UTF-8) and appends a note with a link.
 * A cut-off tag at the end is dropped; DOMPurify closes open tags in the browser.
 */
export function clipHtml(html: string, maxBytes: number, url?: string): string {
  const total = byteLength(html);
  if (total <= maxBytes) return html;
  const note = `<p><em>… truncated, ${url ? `<a href="${url.replace(/"/g, '&quot;')}">view on GitHub</a>` : 'view on GitHub'}</em></p>`;
  const budget = Math.max(0, maxBytes - byteLength(note));
  let cut = html.slice(0, Math.floor((budget * html.length) / total));
  while (cut.length > 0 && byteLength(cut) > budget) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  cut = cut.replace(/<[^>]*$/, '');
  return cut + note;
}

/**
 * Truncates the HTML of entries: each to at most `itemBytes`, all together to at most `totalBytes`;
 * the newest (at the end of the list) get budget first, older ones are truncated or emptied down to the note.
 */
export function clipItemsHtml<T extends { html: string; url?: string }>(items: T[], itemBytes: number, totalBytes: number): T[] {
  let remaining = totalBytes;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i]!;
    const html = clipHtml(item.html, Math.min(itemBytes, Math.max(0, remaining)), item.url || undefined);
    remaining -= byteLength(html);
    if (html !== item.html) out[i] = { ...item, html };
  }
  return out;
}
