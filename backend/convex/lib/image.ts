import { IMAGE_PATH, IMAGE_TYPES, LIMITS, type ImageType } from '../shared/constants';

// Checks uploaded images (descriptions, comments). Only raster images are allowed (PNG, JPEG,
// WebP, GIF), recognized by their first bytes. SVG is deliberately excluded (it can contain
// scripts). The browser's declared Content-Type on upload must match the content. Images are
// served with the type detected here, `nosniff` and a CSP without scripts.

export type ImageCheck = { ok: true; contentType: ImageType } | { ok: false; reason: string };

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** Detects the image type from the first bytes (at least 12), otherwise null. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const TYPE_NAMES = 'PNG, JPEG, WebP and GIF';
export const IMAGE_TOO_LARGE = `The image is too large (at most ${LIMITS.imageMaxBytes / 1024 / 1024} MB).`;

/**
 * Checks an uploaded image: size, allowed type, content matches the declared type.
 * `head` is the first bytes of the file (12 are enough), `size` the full size.
 */
export function checkImage(head: Uint8Array, size: number, declaredType?: string | null): ImageCheck {
  if (size === 0) return { ok: false, reason: 'The file is empty.' };
  if (size > LIMITS.imageMaxBytes) return { ok: false, reason: IMAGE_TOO_LARGE };
  const declared = declaredType?.split(';')[0]?.trim().toLowerCase() || undefined;
  if (declared && !(IMAGE_TYPES as readonly string[]).includes(declared)) {
    return { ok: false, reason: `Only images are allowed (${TYPE_NAMES}).` };
  }
  const sniffed = sniffImage(head);
  if (!sniffed) return { ok: false, reason: `Only images are allowed (${TYPE_NAMES}); this file is none of them.` };
  if (declared && declared !== sniffed) return { ok: false, reason: "The image's content does not match its file type." };
  return { ok: true, contentType: sniffed };
}

/** URL of an image: our own endpoint with an unguessable token, not the storage URL. */
export function imageUrl(token: string) {
  const site = (process.env.CONVEX_SITE_URL ?? '').replace(/\/+$/, '');
  return `${site}${IMAGE_PATH}${token}`;
}

/** Size of the decoded bytes of a base64 string, without decoding it. */
const base64Size = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export type DecodedImage = { ok: true; bytes: Uint8Array<ArrayBuffer>; declaredType?: string } | { ok: false; reason: string };

/**
 * Decodes an image sent as plain base64 or as a data URL (`data:image/png;base64,…`) for the MCP
 * upload. The size is checked before decoding. Only the declared type (if any) and the size are
 * decided here; whether the bytes are an allowed image is `checkImage`'s job, the same as for UI uploads.
 */
export function decodeBase64Image(data: string): DecodedImage {
  let declaredType: string | undefined;
  let b64 = data.trim();
  if (/^data:/i.test(b64)) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*),/is.exec(b64);
    if (!m || !/;base64$/i.test(m[2]!)) return { ok: false, reason: 'A data URL must be base64-encoded: data:image/png;base64,…' };
    const type = m[1]!.trim().toLowerCase();
    declaredType = type === 'image/jpg' ? 'image/jpeg' : type || undefined;
    b64 = b64.slice(m[0].length);
  }
  b64 = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length === 0) return { ok: false, reason: 'The file is empty.' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, reason: 'The image data is not valid base64.' };
  if (b64.length % 4 === 1) return { ok: false, reason: 'The image data is not valid base64.' };
  if (base64Size(b64) > LIMITS.imageMaxBytes) return { ok: false, reason: IMAGE_TOO_LARGE };
  const raw = atob(b64.replace(/=+$/, ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { ok: true, bytes, declaredType };
}

/** Markdown line for an uploaded image; the file name (without extension) becomes the alt text. */
export function imageMarkdownLine(filename: string, url: string) {
  const alt = filename
    .replace(/^.*[\\/]/, '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]\\()<>]/g, '')
    .trim();
  return `![${alt || 'image'}](${url})`;
}
