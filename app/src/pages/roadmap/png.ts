// PNG files of the roadmap export (SELF-113): keep only the chunks an image needs, so no text,
// time stamp or EXIF block can carry anything into the file the owner shares. Browsers write none
// today; this makes sure it stays that way.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Image data and color information; everything else (tEXt, iTXt, zTXt, tIME, eXIf …) is dropped. */
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']);

export function isPng(bytes: Uint8Array) {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Chunk types in order (for tests and checks). */
export function pngChunks(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    out.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return out;
}

/** The PNG without ancillary chunks that could hold text or metadata. */
export function stripPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isPng(bytes)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let size = 8;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (end > bytes.length) break;
    if (KEEP.has(type)) {
      parts.push(bytes.subarray(at, end));
      size += end - at;
    }
    at = end;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
