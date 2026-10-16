/**
 * `.tbla`: Tabula's asset bundle. One file holds the files of an export
 * (compiled or raw skeletons, baked samples, page images and KTX2 pages,
 * sprite sheets, images, fonts), each by its path and with a CRC-32, so a
 * game downloads one file instead of dozens.
 *
 * Layout (little endian):
 *
 *   magic "TBLA" | version u16 | flags u16 | toc length u32 | toc (UTF-8 JSON) | padding to 16 | file data
 *
 * The toc is `{ meta, files: [{ path, offset, length, crc, codec?, size? }] }`;
 * offsets are from the start of the file data, every file starts on a
 * 16-byte boundary. Files are ordered so that what is needed first comes
 * first: the embedded manifest, skeletons and data, then KTX2 pages, then
 * images; within each, in the writer's order. A loader that has every file
 * it needs stops reading (with KTX2 working, the image fallbacks at the end
 * are never downloaded), see {@link BundleStream}.
 *
 * Version 2 adds packed files: data files (not KTX2 pages or images, which
 * are compressed already) may be stored deflated (`codec: 'deflate-raw'`,
 * `size` the unpacked length; the CRC is of the stored bytes). A bundle
 * without packed files is written as version 1, which older runtimes read.
 */

/** Bundle format version (the newest this runtime reads and writes). */
export const TBLA_VERSION = 2;
const MAGIC = [0x54, 0x42, 0x4c, 0x41]; // "TBLA"
const HEADER_BYTES = 12;
const ALIGN = 16;
/** Data files smaller than this are stored as they are. */
const MIN_PACKED = 256;

/** Path of the manifest inside a self-contained `.tbla` (read first). */
export const BUNDLE_MANIFEST = 'assets.manifest.json';

/** A file in a bundle. */
export interface BundleEntry {
  path: string;
  /** From the start of the file data. */
  offset: number;
  /** Stored length (packed, with `codec`). */
  length: number;
  /** CRC-32 of the stored bytes. */
  crc: number;
  /** How the stored bytes are packed (version 2); absent: stored as they are. */
  codec?: 'deflate-raw';
  /** Unpacked length (with `codec`). */
  size?: number;
}

/** The table of contents of a bundle. */
export interface BundleToc {
  /** Free-form description (tier, group, tool version, ...). */
  meta: Record<string, unknown>;
  files: BundleEntry[];
  /** Absolute offset of the file data (header + toc + padding). */
  dataOffset: number;
}

/** A file to write into a bundle. */
export interface BundleFile {
  path: string;
  bytes: Uint8Array;
  /**
   * Place among the files of its kind (lower first; files without come
   * after, by path). Kinds keep their order: manifest, data, KTX2, images.
   */
  order?: number;
}

/** Options of {@link writeBundle}. */
export interface WriteBundleOptions {
  /**
   * Deflate data files where it saves at least 10% (default true; ignored
   * where `CompressionStream` is missing). Packed bundles are version 2 and
   * need `DecompressionStream` (every current browser; Safari from 16.4).
   */
  compress?: boolean;
}

/** Load order of a file in a bundle: the manifest first, data next, KTX2 next, images last. */
export function bundleOrder(path: string): number {
  if (path === BUNDLE_MANIFEST) return -1;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'ktx2') return 1;
  if (ext === 'png' || ext === 'webp' || ext === 'jpg' || ext === 'jpeg' || ext === 'avif') return 2;
  return 0;
}

/** Write a bundle of `files` (any order; sorted by {@link bundleOrder}, then their `order`, then path). */
export async function writeBundle(files: readonly BundleFile[], meta: Record<string, unknown> = {}, options: WriteBundleOptions = {}): Promise<Uint8Array> {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`Bundle: "${f.path}" appears twice`);
    seen.add(f.path);
  }
  const rank = (f: BundleFile): number => f.order ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...files].sort((a, b) => bundleOrder(a.path) - bundleOrder(b.path) || rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Without CompressionStream (older browsers / webviews) the bundle is written unpacked, as version 1.
  const compress = (options.compress ?? true) && typeof CompressionStream !== 'undefined';
  const stored = await Promise.all(sorted.map(async (f): Promise<{ bytes: Uint8Array; size?: number }> => {
    if (!compress || bundleOrder(f.path) > 0 || f.bytes.length < MIN_PACKED) return { bytes: f.bytes };
    const packed = await transform(f.bytes, new CompressionStream('deflate-raw'));
    return packed.length <= f.bytes.length * 0.9 ? { bytes: packed, size: f.bytes.length } : { bytes: f.bytes };
  }));
  const entries: BundleEntry[] = [];
  let offset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = stored[i]!;
    entries.push({ path: sorted[i]!.path, offset, length: s.bytes.length, crc: crc32(s.bytes), ...(s.size !== undefined ? { codec: 'deflate-raw' as const, size: s.size } : {}) });
    offset = align(offset + s.bytes.length);
  }
  const toc = new TextEncoder().encode(JSON.stringify({ meta, files: entries }));
  const dataOffset = align(HEADER_BYTES + toc.length);
  const out = new Uint8Array(dataOffset + offset);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, entries.some((e) => e.codec) ? 2 : 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, toc.length, true);
  out.set(toc, HEADER_BYTES);
  for (let i = 0; i < sorted.length; i++) out.set(stored[i]!.bytes, dataOffset + entries[i]!.offset);
  return out;
}

/** True when `bytes` start like a bundle. */
export function isBundle(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * The table of contents, once `bytes` hold the header and toc; null when
 * more bytes are needed. Throws on a file that is not a bundle or a newer version.
 */
export function readBundleToc(bytes: Uint8Array): BundleToc | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (!isBundle(bytes)) throw new Error('Not a Tabula bundle (.tbla)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version < 1 || version > TBLA_VERSION) throw new Error(`.tbla version ${version} is not supported (this runtime reads 1-${TBLA_VERSION}); update tabula-pixi`);
  const tocLength = view.getUint32(8, true);
  if (bytes.length < HEADER_BYTES + tocLength) return null;
  const toc = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + tocLength))) as Omit<BundleToc, 'dataOffset'>;
  return { ...toc, dataOffset: align(HEADER_BYTES + tocLength) };
}

/** Size of the whole bundle a toc describes (the last file is padded too). */
export function bundleSize(toc: BundleToc): number {
  let end = 0;
  for (const e of toc.files) end = Math.max(end, e.offset + e.length);
  return toc.dataOffset + align(end);
}

/** Every file of a complete bundle, checked and unpacked (stored files are views into `bytes`). */
export async function readBundle(bytes: Uint8Array): Promise<{ toc: BundleToc; files: Map<string, Uint8Array> }> {
  const toc = readBundleToc(bytes);
  if (!toc) throw new Error('Bundle is truncated (no table of contents)');
  const unpacked = await Promise.all(toc.files.map((e) => unpack(e, sliceEntry(bytes, toc, e))));
  return { toc, files: new Map(toc.files.map((e, i) => [e.path, unpacked[i]!])) };
}

function sliceEntry(bytes: Uint8Array, toc: BundleToc, e: BundleEntry): Uint8Array {
  const start = toc.dataOffset + e.offset;
  if (start + e.length > bytes.length) throw new Error(`Bundle is truncated: "${e.path}" is incomplete`);
  const slice = bytes.subarray(start, start + e.length);
  if (crc32(slice) !== e.crc) throw new Error(`Bundle is damaged: "${e.path}" fails its checksum`);
  return slice;
}

/** The file's bytes from its stored bytes. */
async function unpack(e: BundleEntry, stored: Uint8Array): Promise<Uint8Array> {
  if (!e.codec) return stored;
  if (e.codec !== 'deflate-raw') throw new Error(`Bundle: "${e.path}" is packed as "${String(e.codec)}", which this runtime does not read; update tabula-pixi`);
  if (typeof DecompressionStream === 'undefined') throw new Error(`Bundle: "${e.path}" is deflated and this browser has no DecompressionStream; export the bundle without compression`);
  const bytes = await transform(stored, new DecompressionStream('deflate-raw'));
  if (bytes.length !== e.size) throw new Error(`Bundle is damaged: "${e.path}" unpacks to ${bytes.length} bytes, not ${e.size}`);
  return bytes;
}

/** `bytes` through a compression or decompression stream. */
async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Not awaited: the readable side is read below (awaiting would wait on backpressure forever).
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * A bundle read while it downloads: files resolve as soon as their bytes
 * arrive, and {@link stop} ends the download once nothing else is needed.
 * A file wanted after stopping is fetched with a range request (or, where
 * ranges are not served, from one more download of the whole bundle,
 * which then serves every later file).
 */
export class BundleStream {
  /** The table of contents (resolves with the first bytes). */
  readonly toc: Promise<BundleToc>;
  /** Bytes received so far. */
  received = 0;
  /** Bundle size: from the table of contents once read (the server's content-length is the compressed size when the transfer is encoded). */
  readonly total: number | null = null;
  private buffer: Uint8Array;
  private tocValue: BundleToc | null = null;
  /** Entries by offset, and the first one not yet received. */
  private pending: BundleEntry[] = [];
  private next = 0;
  private resolveToc!: (toc: BundleToc) => void;
  private rejectToc!: (err: Error) => void;
  private readonly waiting = new Map<string, { resolve: (b: Promise<Uint8Array>) => void; reject: (e: Error) => void }[]>();
  private readonly ready = new Map<string, Promise<Uint8Array>>();
  private done = false;
  private failure: Error | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** The first range request, until it shows whether ranges are served. */
  private rangeProbe: Promise<void> | null = null;
  private rangesServed = false;
  /** The whole bundle, from a server that ignored a range request. */
  private whole: Uint8Array | null = null;
  private readonly onProgress: ((received: number, total: number | null) => void) | undefined;

  /**
   * @param url bundle URL (for range requests after {@link stop})
   * @param fetchImpl fetch to use
   */
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch, options: { onProgress?: (received: number, total: number | null) => void; priority?: 'low' | 'high'; response?: Response } = {}) {
    this.onProgress = options.onProgress;
    this.toc = new Promise((res, rej) => {
      this.resolveToc = res;
      this.rejectToc = rej;
    });
    this.toc.catch(() => undefined);
    this.buffer = new Uint8Array(0);
    void this.run(options.priority, options.response);
  }

  private async run(priority?: 'low' | 'high', given?: Response): Promise<void> {
    try {
      const response = given ?? await this.fetchImpl(this.url, priority ? { priority } as RequestInit : undefined);
      if (!response.ok) throw new Error(`Failed to load "${this.url}": HTTP ${response.status}`);
      // A first guess; the table of contents gives the exact size.
      this.buffer = new Uint8Array(Number(response.headers.get('content-length')) || 1 << 20);
      if (!response.body) {
        this.append(new Uint8Array(await response.arrayBuffer()));
      } else {
        this.reader = response.body.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.append(value);
        }
      }
      this.finish(null);
    } catch (err) {
      this.finish(this.done ? null : err as Error);
    }
  }

  private append(chunk: Uint8Array): void {
    if (this.received + chunk.length > this.buffer.length) this.resize(Math.max(this.buffer.length * 2, this.received + chunk.length));
    this.buffer.set(chunk, this.received);
    this.received += chunk.length;
    if (!this.tocValue) {
      const toc = readBundleToc(this.buffer.subarray(0, this.received));
      if (toc) {
        this.tocValue = toc;
        this.pending = [...toc.files].sort((a, b) => a.offset - b.offset);
        const size = bundleSize(toc);
        (this as { total: number | null }).total = size;
        if (size >= this.received && size !== this.buffer.length) this.resize(size);
        this.resolveToc(toc);
      }
    }
    this.onProgress?.(this.received, this.total);
    const toc = this.tocValue;
    if (!toc) return;
    const view = this.buffer.subarray(0, this.received);
    while (this.next < this.pending.length) {
      const e = this.pending[this.next]!;
      if (toc.dataOffset + e.offset + e.length > this.received) break;
      this.next++;
      if (this.ready.has(e.path)) continue;
      const stored = sliceEntry(view, toc, e);
      // Stored files are copied out of the growing buffer, so it can be dropped when done.
      this.deliver(e.path, e.codec ? unpack(e, stored) : Promise.resolve(stored.slice()));
    }
  }

  private resize(bytes: number): void {
    const resized = new Uint8Array(bytes);
    resized.set(this.buffer.subarray(0, this.received));
    this.buffer = resized;
  }

  private deliver(path: string, bytes: Promise<Uint8Array>): void {
    bytes.catch(() => undefined);
    this.ready.set(path, bytes);
    for (const w of this.waiting.get(path) ?? []) w.resolve(bytes);
    this.waiting.delete(path);
  }

  private finish(error: Error | null): void {
    this.done = true;
    this.reader = null;
    this.buffer = new Uint8Array(0);
    if (error) {
      this.failure = error;
      this.rejectToc(error);
    } else if (!this.tocValue) this.rejectToc(new Error(`"${this.url}" ended before its table of contents`));
    for (const [path, list] of this.waiting) {
      for (const w of list) {
        if (error) w.reject(error);
        else w.resolve(this.fetchLater(path));
      }
    }
    this.waiting.clear();
  }

  /** True when the bundle lists `path`. */
  async has(path: string): Promise<boolean> {
    return (await this.toc).files.some((e) => e.path === path);
  }

  /** The bytes of `path` (checked and unpacked), once they arrived; after {@link stop}, by a range request. */
  async file(path: string): Promise<Uint8Array> {
    const toc = await this.toc;
    if (!toc.files.some((e) => e.path === path)) throw new Error(`"${path}" is not in ${this.url}`);
    const ready = this.ready.get(path);
    if (ready) return ready;
    if (this.done) {
      if (this.failure) throw this.failure;
      return this.fetchLater(path);
    }
    return new Promise((resolve, reject) => {
      const list = this.waiting.get(path) ?? [];
      list.push({ resolve, reject });
      this.waiting.set(path, list);
    });
  }

  /** Stop downloading (files already received stay available). */
  stop(): void {
    if (this.done) return;
    this.done = true;
    void this.reader?.cancel().catch(() => undefined);
  }

  /** Drop the received files (after their textures and assets were created). */
  release(): void {
    this.stop();
    this.ready.clear();
    this.whole = null;
  }

  /** `path` after the download ended (one request per file, shared by everyone waiting for it). */
  private fetchLater(path: string): Promise<Uint8Array> {
    let promise = this.ready.get(path);
    if (!promise) {
      promise = this.fetchRange(path);
      const p = promise;
      p.catch(() => { if (this.ready.get(path) === p) this.ready.delete(path); });
      this.ready.set(path, p);
    }
    return promise;
  }

  private async fetchRange(path: string): Promise<Uint8Array> {
    const toc = await this.toc;
    const e = toc.files.find((f) => f.path === path)!;
    // Until the first range request answers, the others wait: a server that ignores ranges is downloaded from once.
    while (this.rangeProbe) await this.rangeProbe;
    if (this.whole) return unpack(e, sliceEntry(this.whole, toc, e));
    const request = this.requestRange(toc, e);
    if (!this.rangesServed) {
      const probe: Promise<void> = request.then(() => undefined, () => undefined).finally(() => { if (this.rangeProbe === probe) this.rangeProbe = null; });
      this.rangeProbe = probe;
    }
    return request;
  }

  private async requestRange(toc: BundleToc, e: BundleEntry): Promise<Uint8Array> {
    const start = toc.dataOffset + e.offset;
    const response = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-${start + e.length - 1}` } });
    if (!response.ok) throw new Error(`Failed to load "${e.path}" from "${this.url}": HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) {
      this.rangesServed = true;
      if (bytes.length !== e.length || crc32(bytes) !== e.crc) throw new Error(`Bundle is damaged: "${e.path}" fails its checksum`);
      return unpack(e, bytes);
    }
    // 200: the server ignored the range and sent the whole bundle; it serves the files asked for later too.
    this.whole = bytes;
    return unpack(e, sliceEntry(bytes, toc, e));
  }
}

const align = (n: number): number => Math.ceil(n / ALIGN) * ALIGN;

/** Slice-by-8 tables: table k at k * 256 (about 4x the speed of one table). */
let crcTables: Uint32Array | null = null;

function makeCrcTables(): Uint32Array {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let i = 256; i < t.length; i++) {
    const p = t[i - 256]!;
    t[i] = (p >>> 8) ^ t[p & 0xff]!;
  }
  return t;
}

/** CRC-32 (IEEE) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTables ??= makeCrcTables();
  const b = bytes;
  let crc = 0xffffffff;
  let i = 0;
  for (const end = b.length - (b.length & 7); i < end; i += 8) {
    const a = crc ^ (b[i]! | b[i + 1]! << 8 | b[i + 2]! << 16 | b[i + 3]! << 24);
    crc = t[1792 + (a & 0xff)]! ^ t[1536 + ((a >>> 8) & 0xff)]! ^ t[1280 + ((a >>> 16) & 0xff)]! ^ t[1024 + (a >>> 24)]!
      ^ t[768 + b[i + 4]!]! ^ t[512 + b[i + 5]!]! ^ t[256 + b[i + 6]!]! ^ t[b[i + 7]!]!;
  }
  for (; i < b.length; i++) crc = t[(crc ^ b[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
