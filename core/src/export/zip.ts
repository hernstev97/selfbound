// Minimal ZIP writer for the data export: no dependency, runs in the browser and in Node.
// Text is deflated with CompressionStream where it exists, images are stored as they are.
// ZIP64 only for the entry count (65,535 files and more); archives over 4 GB are refused.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // browsers before deflate-raw (Chrome < 103): store instead
  }
}

/** Date and time in MS-DOS form (local time, 2-second steps, from 1980). */
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 2)));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

type Entry = { name: Uint8Array; crc: number; method: number; compressed: number; size: number; offset: number };

const MAX32 = 0xffffffff;
const encoder = new TextEncoder();

export class ZipWriter {
  readonly parts: Uint8Array[] = [];
  #entries: Entry[] = [];
  #offset = 0;
  #names = new Set<string>();
  #time: { time: number; date: number };

  constructor(modifiedAt = Date.now()) {
    this.#time = dosTime(modifiedAt);
  }

  get size(): number {
    return this.#offset;
  }

  /** Adds a file. `compress: false` for data that is already compressed (images). */
  async add(path: string, content: string | Uint8Array, options: { compress?: boolean } = {}): Promise<void> {
    if (this.#names.has(path)) throw new Error(`Duplicate path in ZIP: ${path}`);
    this.#names.add(path);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const deflated = options.compress === false || data.length < 64 ? null : await deflateRaw(data);
    const useDeflate = deflated !== null && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = encoder.encode(path);
    const entry: Entry = { name, crc: crc32(data), method: useDeflate ? 8 : 0, compressed: body.length, size: data.length, offset: this.#offset };
    if (this.#offset + 30 + name.length + body.length > MAX32) throw new Error('The export is larger than 4 GB.');
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // names in UTF-8
    header.setUint16(8, entry.method, true);
    header.setUint16(10, this.#time.time, true);
    header.setUint16(12, this.#time.date, true);
    header.setUint32(14, entry.crc, true);
    header.setUint32(18, entry.compressed, true);
    header.setUint32(22, entry.size, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    this.#push(new Uint8Array(header.buffer), name, body);
    this.#entries.push(entry);
  }

  /** Writes the central directory. The archive is `parts` afterwards. */
  finish(): Uint8Array[] {
    const start = this.#offset;
    for (const e of this.#entries) {
      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, 20, true); // version made by
      header.setUint16(6, 20, true); // version needed
      header.setUint16(8, 0x0800, true);
      header.setUint16(10, e.method, true);
      header.setUint16(12, this.#time.time, true);
      header.setUint16(14, this.#time.date, true);
      header.setUint32(16, e.crc, true);
      header.setUint32(20, e.compressed, true);
      header.setUint32(24, e.size, true);
      header.setUint16(28, e.name.length, true);
      header.setUint32(42, e.offset, true);
      this.#push(new Uint8Array(header.buffer), e.name);
    }
    const cdSize = this.#offset - start;
    if (this.#offset > MAX32) throw new Error('The export is larger than 4 GB.');
    const count = this.#entries.length;
    // 0xffff itself means "see ZIP64" to readers, so it needs the record too.
    if (count >= 0xffff) {
      const zip64 = this.#offset;
      const record = new DataView(new ArrayBuffer(56 + 20));
      record.setUint32(0, 0x06064b50, true);
      record.setBigUint64(4, 44n, true); // size of the rest of the record
      record.setUint16(12, 45, true);
      record.setUint16(14, 45, true);
      record.setBigUint64(24, BigInt(count), true);
      record.setBigUint64(32, BigInt(count), true);
      record.setBigUint64(40, BigInt(cdSize), true);
      record.setBigUint64(48, BigInt(start), true);
      record.setUint32(56, 0x07064b50, true); // locator
      record.setBigUint64(64, BigInt(zip64), true);
      record.setUint32(72, 1, true);
      this.#push(new Uint8Array(record.buffer));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Math.min(count, 0xffff), true);
    end.setUint16(10, Math.min(count, 0xffff), true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, start, true);
    this.#push(new Uint8Array(end.buffer));
    return this.parts;
  }

  #push(...chunks: Uint8Array[]) {
    for (const chunk of chunks) {
      this.parts.push(chunk);
      this.#offset += chunk.length;
    }
  }
}
