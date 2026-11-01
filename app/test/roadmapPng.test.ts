import { describe, expect, test } from 'vitest';
import { deflateSync } from 'node:zlib';
import { isPng, pngChunks, stripPng } from '../src/pages/roadmap/png.ts';
import { fileName } from '../src/pages/roadmap/exportImage.ts';

// Roadmap export (SELF-113): the PNG keeps image data only, nothing that could carry text.

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out; // CRC left zero: the stripper does not check it
}

function file(...parts: Uint8Array[]) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const size = parts.reduce((n, p) => n + p.length, sig.length);
  const out = new Uint8Array(size);
  out.set(sig);
  let at = sig.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('roadmap PNG', () => {
  const ihdr = chunk('IHDR', new Uint8Array(13));
  const idat = chunk('IDAT', new Uint8Array(deflateSync(Buffer.from([0, 1, 2]))));
  const text = chunk('tEXt', new TextEncoder().encode('Comment\0Secret boss ACME-12'));
  const itxt = chunk('iTXt', new TextEncoder().encode('XML:com.adobe.xmp\0\0\0\0\0<x/>'));
  const time = chunk('tIME', new Uint8Array(7));
  const exif = chunk('eXIf', new Uint8Array(8));
  const srgb = chunk('sRGB', new Uint8Array(1));
  const iend = chunk('IEND', new Uint8Array(0));

  test('text, time and EXIF chunks are dropped, image and color chunks stay in order', () => {
    const input = file(ihdr, text, srgb, idat, itxt, time, exif, iend);
    expect(pngChunks(input)).toEqual(['IHDR', 'tEXt', 'sRGB', 'IDAT', 'iTXt', 'tIME', 'eXIf', 'IEND']);
    const out = stripPng(input);
    expect(isPng(out)).toBe(true);
    expect(pngChunks(out)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    expect(new TextDecoder('latin1').decode(out)).not.toContain('Secret');
  });

  test('anything after IEND is cut; a non-PNG is refused', () => {
    const out = stripPng(file(ihdr, idat, iend, new TextEncoder().encode('trailing data')));
    expect(pngChunks(out)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(() => stripPng(new TextEncoder().encode('GIF89a'))).toThrow();
  });

  test('file names come from the export title only', () => {
    expect(fileName('Emberfall: Früh & „Wild“', 'roadmap', '2026-11-01')).toBe('emberfall-fruh-wild-roadmap-2026-11-01.png');
    expect(fileName('***', 'progress', '2026-11-01')).toBe('roadmap-progress-2026-11-01.png');
  });
});
