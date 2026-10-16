/**
 * Little-endian binary reader/writer shared by the compiled skeleton format
 * (`.tabula`) and the baked sample format (`.baked`).
 *
 * Typed arrays are written 4-byte aligned (relative to the start of the
 * buffer), so the reader can return them as views into the source buffer
 * instead of copying: loading allocates the view objects, never the data.
 */

/** True when the host stores typed arrays little-endian (every current browser and Node platform). */
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const ALIGN = 4;
const INITIAL_CAPACITY = 1 << 16;

/** Growable little-endian writer. */
export class ByteWriter {
  private buf = new ArrayBuffer(INITIAL_CAPACITY);
  private view = new DataView(this.buf);
  private bytesView = new Uint8Array(this.buf);
  private pos = 0;
  private readonly encoder = new TextEncoder();

  /** Bytes written so far. */
  get length(): number {
    return this.pos;
  }

  /** Append an unsigned byte. */
  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  /** Append a little-endian uint16. */
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  /** Append a little-endian uint32. */
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  /** Append a little-endian float32. */
  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  /** Unsigned LEB128 integer. */
  varuint(v: number): void {
    if (!Number.isInteger(v) || v < 0) throw new Error(`varuint out of range: ${v}`);
    do {
      let byte = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) byte |= 0x80;
      this.u8(byte);
    } while (v > 0);
  }

  /** Signed integer, zigzag + LEB128. */
  varint(v: number): void {
    this.varuint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  /** Length-prefixed UTF-8 string. */
  str(s: string): void {
    this.bytes(this.encoder.encode(s));
  }

  /** Length-prefixed raw bytes. */
  bytes(b: Uint8Array): void {
    this.varuint(b.length);
    this.raw(b);
  }

  /** Raw bytes without a length prefix. */
  raw(b: Uint8Array): void {
    this.ensure(b.length);
    this.bytesView.set(b, this.pos);
    this.pos += b.length;
  }

  /** Length-prefixed, aligned float32 array. */
  f32array(a: ArrayLike<number>): void {
    this.typed(a, 4, (o, v) => this.view.setFloat32(o, v, true));
  }

  /** Length-prefixed, aligned uint16 array. */
  u16array(a: ArrayLike<number>): void {
    this.typed(a, 2, (o, v) => this.view.setUint16(o, v, true));
  }

  /** Length-prefixed, aligned int32 array. */
  i32array(a: ArrayLike<number>): void {
    this.typed(a, 4, (o, v) => this.view.setInt32(o, v, true));
  }

  /** The written bytes (a copy, sized exactly). */
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.pos);
  }

  private typed(a: ArrayLike<number>, size: number, set: (offset: number, v: number) => void): void {
    this.varuint(a.length);
    this.align();
    this.ensure(a.length * size);
    for (let i = 0; i < a.length; i++) set(this.pos + i * size, a[i]!);
    this.pos += a.length * size;
  }

  private align(): void {
    const padded = Math.ceil(this.pos / ALIGN) * ALIGN;
    this.ensure(padded - this.pos);
    while (this.pos < padded) this.bytesView[this.pos++] = 0;
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytesView.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.bytesView = new Uint8Array(next);
  }
}

/** Little-endian reader; typed arrays come back as views into the buffer when possible. */
export class ByteReader {
  /** Current read offset in bytes. */
  pos = 0;
  private readonly view: DataView;
  private readonly bytesView: Uint8Array;
  private readonly decoder = new TextDecoder();

  /**
   * @param data File contents. A `Uint8Array` whose offset is not 4-byte
   *   aligned (e.g. a pooled Node `Buffer`) is copied once so views stay aligned.
   */
  constructor(data: ArrayBuffer | Uint8Array) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const aligned = bytes.byteOffset % ALIGN === 0 ? bytes : bytes.slice();
    this.bytesView = aligned;
    this.view = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength);
  }

  /** Total length in bytes. */
  get length(): number {
    return this.bytesView.byteLength;
  }

  /** Read an unsigned byte. */
  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  /** Read a little-endian uint16. */
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  /** Read a little-endian uint32. */
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Read a little-endian float32. */
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Read an unsigned LEB128 varint. */
  varuint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = this.view.getUint8(this.pos++);
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) return result;
      scale *= 128;
    }
  }

  /** Read a zigzag-encoded signed varint. */
  varint(): number {
    const v = this.varuint();
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }

  /** Read a varint-length-prefixed UTF-8 string. */
  str(): string {
    const n = this.varuint();
    const s = this.decoder.decode(this.bytesView.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  /** Length-prefixed bytes, as a view. */
  bytes(): Uint8Array {
    const n = this.varuint();
    return this.raw(n);
  }

  /** `n` raw bytes, as a view. */
  raw(n: number): Uint8Array {
    const out = this.bytesView.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read a length-prefixed, 4-byte aligned float32 array (a view into the buffer when aligned). */
  f32array(): Float32Array {
    const n = this.varuint();
    this.align();
    const out = HOST_LITTLE_ENDIAN
      ? new Float32Array(this.view.buffer, this.view.byteOffset + this.pos, n)
      : Float32Array.from({ length: n }, (_, i) => this.view.getFloat32(this.pos + i * 4, true));
    this.pos += n * 4;
    return out;
  }

  /** Read a length-prefixed, aligned uint16 array (view into the buffer). */
  u16array(): Uint16Array {
    const n = this.varuint();
    this.align();
    const out = HOST_LITTLE_ENDIAN
      ? new Uint16Array(this.view.buffer, this.view.byteOffset + this.pos, n)
      : Uint16Array.from({ length: n }, (_, i) => this.view.getUint16(this.pos + i * 2, true));
    this.pos += n * 2;
    return out;
  }

  /** Read a length-prefixed, aligned int32 array (view into the buffer). */
  i32array(): Int32Array {
    const n = this.varuint();
    this.align();
    const out = HOST_LITTLE_ENDIAN
      ? new Int32Array(this.view.buffer, this.view.byteOffset + this.pos, n)
      : Int32Array.from({ length: n }, (_, i) => this.view.getInt32(this.pos + i * 4, true));
    this.pos += n * 4;
    return out;
  }

  private align(): void {
    this.pos = Math.ceil(this.pos / ALIGN) * ALIGN;
  }
}
