// Embeds: a link to a video or a post alone on a line becomes a card (XLR8-73). Pure code shared by
// the app (recognize the link, build the card) and the backend (fetch and cache). Imports nothing.
//
// A new provider needs three things: an entry in PROVIDERS (recognize the URL), a fetcher in
// convex/lib/embeds.ts (metadata, media) and a card in the app (components/embeds/).

export type EmbedProvider = 'youtube' | 'x';

export interface EmbedRef {
  provider: EmbedProvider;
  /** Provider's own ID (video ID, post ID); matches ID_PATTERN. */
  id: string;
  /** Link without tracking parameters. */
  url: string;
  /** YouTube: start time in seconds. */
  start?: number;
}

/** Strict ID shapes; the backend builds request URLs only from IDs that match. */
export const ID_PATTERN: Record<EmbedProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  x: /^\d{1,25}$/,
};

interface ProviderDef {
  name: EmbedProvider;
  hosts: readonly string[];
  match(url: URL): Omit<EmbedRef, 'provider'> | null;
}

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'];
const X_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];

/** "90", "90s", "1m30s", "1h2m3s" → seconds (0 → undefined). */
export function parseStart(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(raw);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 && seconds < 86_400 ? seconds : undefined;
}

const PROVIDERS: readonly ProviderDef[] = [
  {
    name: 'youtube',
    hosts: YOUTUBE_HOSTS,
    match(url) {
      let id: string | undefined;
      if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
      else if (url.pathname === '/watch') id = url.searchParams.get('v') ?? undefined;
      else id = /^\/(?:shorts|live|embed|v)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
      if (!id || !ID_PATTERN.youtube.test(id)) return null;
      const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
      return { id, url: `https://www.youtube.com/watch?v=${id}`, ...(start ? { start } : {}) };
    },
  },
  {
    name: 'x',
    hosts: X_HOSTS,
    match(url) {
      const m = /^\/(?:(i\/web)|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d{1,25})(?:\/(?:photo|video)\/\d)?\/?$/.exec(url.pathname);
      if (!m) return null;
      const id = m[3]!;
      return { id, url: m[1] ? `https://x.com/i/web/status/${id}` : `https://x.com/${m[2]}/status/${id}` };
    },
  },
];

/** Recognizes a link to an embeddable page (https only, fixed hosts), otherwise null. */
export function parseEmbedUrl(raw: string): EmbedRef | null {
  if (raw.length > 400) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  for (const def of PROVIDERS) {
    if (!def.hosts.includes(url.hostname)) continue;
    const match = def.match(url);
    if (match) return { provider: def.name, ...match };
  }
  return null;
}

const EMBED_HOSTS = new Set(PROVIDERS.flatMap((p) => p.hosts));
const LINE_LEAD = /^ {0,3}(?:<|\[[^\]\n]*\]\()?$/;

/**
 * Start of the first line in raw Markdown that begins with a link to an embeddable host (bare, in
 * <…> or as [text](…)), or undefined. A cheap scan for `https://` candidates (the Markdown renderer
 * calls this for every paragraph); `parseEmbedUrl` decides afterwards.
 */
export function embedLineStart(src: string): number | undefined {
  for (let at = src.indexOf('https://'); at !== -1; at = src.indexOf('https://', at + 8)) {
    const end = src.indexOf('/', at + 8);
    if (end === -1) return undefined;
    if (!EMBED_HOSTS.has(src.slice(at + 8, end))) continue;
    const lineStart = src.lastIndexOf('\n', at - 1) + 1;
    if (LINE_LEAD.test(src.slice(lineStart, at))) return lineStart;
  }
  return undefined;
}

export const embedKey = (provider: EmbedProvider, id: string) => `${provider}:${id}`;

/** Path of the endpoint that serves stored media (`/embed/<provider>/<id>/<slot>`). */
export const EMBED_MEDIA_PATH = '/embed/';

/** Cached data is refreshed (on view) after this time, and deleted when nobody has viewed it for PURGE. */
export const EMBED_TTL_MS: Record<EmbedProvider, number> = { youtube: 7 * 86_400_000, x: 86_400_000 };
export const EMBED_PURGE_MS = 30 * 86_400_000;

export interface EmbedMediaView {
  slot: string;
  kind: 'photo' | 'video' | 'gif';
  /** Our own URL (EMBED_MEDIA_PATH), never the provider's. */
  src: string;
  width?: number;
  height?: number;
  alt?: string;
}

/** What the app gets: ready to display, no storage IDs. */
export interface EmbedView {
  provider: EmbedProvider;
  id: string;
  /** `unavailable`: deleted, private or not embeddable. The link stays a link. */
  status: 'ok' | 'unavailable';
  fetchedAt: number;
  title?: string;
  author?: string;
  handle?: string;
  authorUrl?: string;
  text?: string;
  /** Post time (ms). */
  createdAt?: number;
  /** Video: thumbnail. Post: author's avatar. */
  avatar?: string;
  thumbnail?: string;
  media: EmbedMediaView[];
}
