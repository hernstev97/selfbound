import { ID_PATTERN, type EmbedProvider } from '../shared/embeds';
import { sniffImage } from './image';

// Fetching the data for embeds (XLR8-73): video and post metadata plus the thumbnail of a video.
// Runs only in the backend, so the browser never talks to the provider. Only official interfaces:
// YouTube and X oEmbed. Rules for every request: https only, fixed hosts per provider, redirects
// only to those hosts, short timeout, size limit.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Transient failure (network, rate limit, unexpected answer): nothing is cached. */
export class EmbedFetchError extends Error {}

/** Hosts a provider's requests may go to (the first request and every redirect). */
const HOSTS: Record<EmbedProvider, readonly string[]> = {
  youtube: ['www.youtube.com', 'i.ytimg.com'],
  x: ['publish.x.com', 'publish.twitter.com'],
};

const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
export const EMBED_LIMITS = { jsonBytes: 256 * 1024, imageBytes: 2 * 1024 * 1024, textChars: 2000 } as const;

async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new EmbedFetchError('response too large');
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel();
      throw new EmbedFetchError('response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface Fetched {
  status: number;
  bytes: Uint8Array;
}

/** GET with the rules above. Returns every status (404 means something else than 500); throws on network errors. */
export async function safeGet(url: string, provider: EmbedProvider, fetchImpl: FetchLike, maxBytes: number): Promise<Fetched> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    if (target.protocol !== 'https:' || !HOSTS[provider].includes(target.hostname) || target.port || target.username) {
      throw new EmbedFetchError(`host not allowed: ${target.hostname}`);
    }
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'Selfbound-embeds/1.0 (+https://github.com/hernstev97/selfbound)', accept: '*/*' },
      });
    } catch {
      throw new EmbedFetchError('request failed');
    }
    // Redirects are followed here, host by host. A runtime that followed one by itself (`redirected`)
    // would have skipped the check: do not trust that answer.
    if (res.redirected || (res.url && !HOSTS[provider].includes(new URL(res.url).hostname))) {
      void res.body?.cancel();
      throw new EmbedFetchError('redirected to an unchecked host');
    }
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel();
      const location = res.headers.get('location');
      if (!location) throw new EmbedFetchError('redirect without target');
      current = new URL(location, current).toString();
      continue;
    }
    return { status: res.status, bytes: await readLimited(res, maxBytes) };
  }
  throw new EmbedFetchError('too many redirects');
}

/** A picture to download for the card (a video's thumbnail). `slot` is part of the URL under which it is served. */
export interface MediaSource {
  slot: string;
  kind: 'thumb';
  url: string;
  width?: number;
  height?: number;
}

/** Everything but the picture bytes. */
export interface EmbedMeta {
  status: 'ok' | 'unavailable';
  title?: string;
  author?: string;
  handle?: string;
  authorUrl?: string;
  text?: string;
  createdAt?: number;
  sources: MediaSource[];
}

export interface DownloadedMedia extends Omit<MediaSource, 'url'> {
  bytes: Uint8Array;
  contentType: string;
}

const UNAVAILABLE: EmbedMeta = { status: 'unavailable', sources: [] };
const decoder = new TextDecoder();

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', nbsp: ' ', hellip: '…' };
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (whole, dec: string, hex: string, name: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

// ---------------------------------------------------------------- YouTube

/** oEmbed answer of YouTube → card data. Thumbnail from the video ID, not from the answer. */
export function parseYoutube(json: unknown, id: string): EmbedMeta {
  if (!isRecord(json)) throw new EmbedFetchError('unexpected answer');
  const authorUrl = str(json.author_url, 300);
  return {
    status: 'ok',
    title: str(json.title, 300),
    author: str(json.author_name, 200),
    authorUrl: authorUrl?.startsWith('https://www.youtube.com/') ? authorUrl : undefined,
    // hqdefault has bars above and below; the card crops to 16:9 (exactly the picture).
    sources: [{ slot: 'thumb', kind: 'thumb', url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 }],
  };
}

async function fetchYoutube(id: string, fetchImpl: FetchLike): Promise<EmbedMeta> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  const res = await safeGet(url, 'youtube', fetchImpl, EMBED_LIMITS.jsonBytes);
  // 401: embedding disabled, 404: private or deleted. In both cases the player would not show either.
  // (403 can be throttling: a failure, not an answer.)
  if (res.status === 401 || res.status === 404) return UNAVAILABLE;
  if (res.status !== 200) throw new EmbedFetchError(`oEmbed answered ${res.status}`);
  return parseYoutube(parseJson(res.bytes), id);
}

// ---------------------------------------------------------------- X

/** Plain text of oEmbed HTML: `<br>` becomes a line break, tags are removed until none is left. */
function plainText(html: string): string {
  let text = html.replace(/<br\s*\/?>/gi, '\n');
  // One pass is not enough: removing `<b>` from `<scr<b>ipt>` leaves a tag.
  for (let before = ''; before !== text; ) {
    before = text;
    text = text.replace(/<[^<>]*>/g, '');
  }
  return decodeEntities(text);
}

/**
 * oEmbed answer of X (a blockquote as HTML) → author, text and date. oEmbed has no pictures, so a
 * card shows no media. The text is plain text (rendered escaped); null if the answer has no post.
 */
export function parseXOembed(json: unknown): EmbedMeta | null {
  if (!isRecord(json) || typeof json.html !== 'string') return null;
  const html = json.html;
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];
  if (paragraph === undefined) return null;
  const text = plainText(paragraph).trim().slice(0, EMBED_LIMITS.textChars);
  // The handle is in the author link, or in the signature after the text ("— Name (@handle)"), never in the post itself.
  const authorHandle = typeof json.author_url === 'string' ? /^https:\/\/(?:x|twitter)\.com\/([^/?#]+)\/?$/.exec(json.author_url)?.[1] : undefined;
  const handle = authorHandle && HANDLE.test(authorHandle) ? authorHandle : /\(@([A-Za-z0-9_]{1,15})\)/.exec(html.slice(html.indexOf('</p>')))?.[1];
  const day = /<a [^>]*>([^<]+)<\/a>\s*<\/blockquote>/.exec(html)?.[1];
  const created = day ? Date.parse(`${decodeEntities(day)} UTC`) : NaN;
  return {
    status: 'ok',
    author: str(json.author_name, 100),
    handle,
    text: text || undefined,
    createdAt: Number.isFinite(created) ? created : undefined,
    sources: [],
  };
}

async function fetchX(id: string, fetchImpl: FetchLike): Promise<EmbedMeta> {
  const target = `https://x.com/i/status/${id}`;
  const res = await safeGet(`https://publish.x.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(target)}`, 'x', fetchImpl, EMBED_LIMITS.jsonBytes);
  // 404: no such post, 403: protected account or removed. In both cases there is nothing to show.
  if (res.status === 404 || res.status === 403) return UNAVAILABLE;
  if (res.status !== 200) throw new EmbedFetchError(`oEmbed answered ${res.status}`);
  const meta = parseXOembed(parseJson(res.bytes));
  if (!meta) throw new EmbedFetchError('unexpected answer');
  return meta;
}

// ---------------------------------------------------------------- Registry and media

const FETCHERS: Record<EmbedProvider, (id: string, fetchImpl: FetchLike) => Promise<EmbedMeta>> = {
  youtube: fetchYoutube,
  x: fetchX,
};

/** Metadata for an embed; `unavailable` if it is gone, throws EmbedFetchError if it could not be fetched. */
export async function fetchEmbedMeta(provider: EmbedProvider, id: string, fetchImpl: FetchLike = (url, init) => fetch(url, init)): Promise<EmbedMeta> {
  if (!ID_PATTERN[provider].test(id)) throw new EmbedFetchError('invalid id');
  return await FETCHERS[provider](id, fetchImpl);
}

/** Downloads the media; a file that fails or is no raster image is left out (the card works without). */
export async function downloadMedia(provider: EmbedProvider, sources: MediaSource[], fetchImpl: FetchLike = (url, init) => fetch(url, init)): Promise<DownloadedMedia[]> {
  const results = await Promise.all(
    sources.map(async ({ url, ...rest }): Promise<DownloadedMedia | null> => {
      try {
        const res = await safeGet(url, provider, fetchImpl, EMBED_LIMITS.imageBytes);
        const contentType = res.status === 200 ? sniffImage(res.bytes) : null;
        return contentType ? { ...rest, bytes: res.bytes, contentType } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((m): m is DownloadedMedia => m !== null);
}
