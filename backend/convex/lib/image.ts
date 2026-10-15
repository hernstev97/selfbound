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
