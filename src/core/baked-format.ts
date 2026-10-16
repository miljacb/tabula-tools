/**
 * Binary `.baked` format (version 4): compressed baked samples.
 *
 * Version 4 adds non-uniform sample times: each animation stores its base
 * grid (fps, count) and the extra refinement samples' times (float32); v3
 * files (grid only) still load.
 *
 * Every sample channel (6 matrix/translation floats per bone, 7 color floats
 * per slot, each deform float) is stored on its own:
 * - constant: one float32, when all samples are within the channel tolerance;
 * - keyframes: a subset of the samples, chosen so that linear interpolation
 *   by time reproduces every dropped sample within the tolerance, stored as
 *   16-bit fixed point over the channel's own [min, max] range (or float32
 *   when 16 bits cannot meet the tolerance).
 *
 * Loading decodes back to the dense sample arrays of {@link BakedAnimation},
 * so playback cost is unchanged; only the file shrinks.
 *
 * Tolerances come from one number, {@link BakeEncoding.maxError}: the largest
 * allowed vertex position error in skeleton units. A vertex is
 * `M·(v + d) + t` (weights sum to 1), so its error is bounded by
 * `|ΔM|·|v + d| + |M|·|Δd| + |Δt|`. Each term gets a third of the budget:
 * matrix terms use the bone's reach (the farthest vertex bound to it),
 * deform uses the largest bone matrix norm of the animation. Colors are kept
 * within a quarter of an 8-bit step. `maxError = 0` is lossless.
 */

import { ByteReader, ByteWriter } from './binary-io.js';
import { BONE_FLOATS, SLOT_FLOATS, bakeGridCount, bakeGridTime, attachmentReach } from './bake.js';
import type { BakedAnimation, BakedDeformTrack, BakedSkeletonData } from './bake.js';
import type { SkeletonData } from './types.js';

/** Magic number of the binary format: 'SLBK'. */
export const BAKED_MAGIC = 0x4b424c53;
/** Binary format version written by {@link serializeBakedData}. */
export const BAKED_FORMAT_VERSION = 4;
/** Oldest version {@link deserializeBakedData} reads (v3: base grid only, no tolerance field). */
const OLDEST_READABLE_VERSION = 3;
/** Default vertex error budget of the CLI, skeleton units (sub-pixel at 1:1 scale). */
export const DEFAULT_BAKE_MAX_ERROR = 0.05;

/** 16-bit fixed point: values are min + q · (max − min) / QUANT_STEPS. */
const QUANT_STEPS = 65535;
/** Color channel tolerance: a quarter of an 8-bit step. */
const COLOR_TOLERANCE = 0.25 / 255;
/** Reach assumed for bones without attachments (their rotation still matters for point transforms). */
const MIN_BONE_REACH = 100;
/** Slot color channel holding alpha: zero alpha skips drawing, so zero must stay exactly zero. */
const ALPHA_CHANNEL = 3;
/** Share of the error budget per term (matrix, translation, deform). */
const BUDGET_SHARE = 1 / 3;

const TAG_CONSTANT = 0;
const TAG_QUANTIZED = 1;
const TAG_FLOAT = 2;

/** How {@link serializeBakedData} compresses. */
export interface BakeEncoding {
  /** Largest allowed vertex position error, skeleton units. 0 = lossless. */
  maxError: number;
  /** Per bone: largest distance from the bone origin of any vertex bound to it, bone-local units ({@link boneReach}). */
  boneReach: ArrayLike<number>;
}

/** Encoding with the given error budget for `data` (computes {@link boneReach}). */
export function bakeEncoding(data: SkeletonData, maxError = DEFAULT_BAKE_MAX_ERROR): BakeEncoding {
  return { maxError, boneReach: boneReach(data) };
}

/**
 * Per bone, the largest distance from the bone origin (bone-local units) of
 * any vertex that bone transforms (see {@link attachmentReach}), at least
 * {@link MIN_BONE_REACH}.
 */
export function boneReach(data: SkeletonData): Float32Array {
  return attachmentReach(data, MIN_BONE_REACH);
}

/**
 * Serialize baked data. Without `encoding` (or with `maxError` 0) the samples
 * round-trip exactly; otherwise channels are compressed within the budget.
 */
export function serializeBakedData(data: BakedSkeletonData, encoding?: BakeEncoding): ArrayBuffer {
  const maxError = encoding?.maxError ?? 0;
  if (maxError > 0 && encoding!.boneReach.length !== data.boneCount) throw new Error('BakeEncoding.boneReach does not match the bone count');
  const w = new ByteWriter();
  w.u32(BAKED_MAGIC);
  w.u16(BAKED_FORMAT_VERSION);
  w.u8(data.yDown ? 1 : 0);
  w.str(data.name);
  w.str(data.hash);
  w.f32(maxError);
  w.f32(data.tolerance);
  w.varuint(data.boneCount);
  w.varuint(data.slotCount);
  w.varuint(data.animations.length);
  for (const anim of data.animations) {
    w.str(anim.name);
    w.f32(anim.duration);
    w.f32(anim.fps);
    writeTimes(w, anim);
    const times = anim.times;
    const n = anim.frameCount;
    const positionTolerance = (maxError * BUDGET_SHARE) / Math.SQRT2;
    for (let b = 0; b < data.boneCount; b++) {
      // |ΔM·v| ≤ |ΔM|_F·|v| ≤ 2·tol·reach for per-term errors ≤ tol.
      const matrixTolerance = maxError > 0 ? (maxError * BUDGET_SHARE) / (2 * encoding!.boneReach[b]!) : 0;
      for (let c = 0; c < BONE_FLOATS; c++) {
        encodeChannel(w, anim.bones, b * BONE_FLOATS + c, data.boneCount * BONE_FLOATS, n, times, c < 4 ? matrixTolerance : positionTolerance);
      }
    }
    const colorTolerance = maxError > 0 ? COLOR_TOLERANCE : 0;
    for (let s = 0; s < data.slotCount; s++) {
      for (let c = 0; c < SLOT_FLOATS; c++) {
        encodeChannel(w, anim.slots, s * SLOT_FLOATS + c, data.slotCount * SLOT_FLOATS, n, times, colorTolerance, c === ALPHA_CHANNEL);
      }
    }
    const deformTolerance = (maxError * BUDGET_SHARE) / (Math.SQRT2 * maxMatrixNorm(anim, data.boneCount));
    w.varuint(anim.deform.length);
    for (const track of anim.deform) {
      w.varuint(track.slotIndex);
      w.varuint(track.length);
      w.raw(packBits(track.present));
      const filled = fillAbsentFrames(track, n);
      for (let k = 0; k < track.length; k++) encodeChannel(w, filled, k, track.length, n, times, deformTolerance);
    }
    writeSteps(w, anim.boneSteps, anim.boneJumps);
    writeSteps(w, anim.slotSteps, anim.slotJumps);
  }
  return w.finish();
}

/** Inverse of {@link serializeBakedData}: decodes to dense samples. Throws on a bad magic number or version. */
export function deserializeBakedData(bytes: ArrayBuffer | Uint8Array): BakedSkeletonData {
  const r = new ByteReader(bytes);
  if (r.length < 6 || r.u32() !== BAKED_MAGIC) throw new Error('Not a Tabula baked file (bad magic)');
  const version = r.u16();
  if (version < OLDEST_READABLE_VERSION || version > BAKED_FORMAT_VERSION) {
    throw new Error(`Unsupported baked format version ${version} (expected ${OLDEST_READABLE_VERSION}–${BAKED_FORMAT_VERSION}); re-bake the skeleton`);
  }
  const yDown = r.u8() === 1;
  const name = r.str();
  const hash = r.str();
  const maxError = r.f32();
  const tolerance = version >= 4 ? r.f32() : 0;
  const boneCount = r.varuint();
  const slotCount = r.varuint();
  const animations: BakedAnimation[] = [];
  for (let count = r.varuint(); count > 0; count--) {
    const name = r.str();
    const duration = r.f32();
    const fps = r.f32();
    const times = readTimes(r, version, duration, fps);
    const anim: BakedAnimation = {
      name,
      duration,
      fps,
      frameCount: times.length,
      times,
      bones: new Float32Array(0),
      slots: new Float32Array(0),
      deform: [],
      boneSteps: new Uint8Array(0),
      boneJumps: new Map(),
      slotSteps: new Uint8Array(0),
      slotJumps: new Map(),
    };
    const n = anim.frameCount;
    anim.bones = new Float32Array(n * boneCount * BONE_FLOATS);
    for (let i = 0; i < boneCount * BONE_FLOATS; i++) decodeChannel(r, anim.bones, i, boneCount * BONE_FLOATS, n, times);
    anim.slots = new Float32Array(n * slotCount * SLOT_FLOATS);
    for (let i = 0; i < slotCount * SLOT_FLOATS; i++) decodeChannel(r, anim.slots, i, slotCount * SLOT_FLOATS, n, times);
    for (let tracks = r.varuint(); tracks > 0; tracks--) {
      const slotIndex = r.varuint();
      const length = r.varuint();
      const present = unpackBits(r.raw(Math.ceil(n / 8)), n);
      const vertices = new Float32Array(n * length);
      for (let k = 0; k < length; k++) decodeChannel(r, vertices, k, length, n, times);
      anim.deform.push({ slotIndex, length, present, vertices });
    }
    anim.boneSteps = readSteps(r, n * boneCount, anim.boneJumps, BONE_FLOATS);
    anim.slotSteps = readSteps(r, n * slotCount, anim.slotJumps, SLOT_FLOATS);
    animations.push(anim);
  }
  return { name, hash, yDown, boneCount, slotCount, maxError, tolerance, animations };
}

/**
 * Sample times: the base grid size, then the refinement samples (times not on
 * the grid) as float32. The baker rounds refinement times to float32, so they
 * round-trip exactly.
 */
function writeTimes(w: ByteWriter, anim: BakedAnimation): void {
  const gridCount = bakeGridCount(anim.duration, anim.fps);
  const extra: number[] = [];
  for (let f = 0, g = 0; f < anim.frameCount; f++) {
    const t = anim.times[f]!;
    if (g < gridCount && t === bakeGridTime(g, gridCount, anim.duration, anim.fps)) g++;
    else extra.push(t);
  }
  if (anim.frameCount - extra.length !== gridCount) throw new Error(`Baked animation "${anim.name}": sample times do not contain its base grid`);
  w.varuint(gridCount);
  w.varuint(extra.length);
  for (const t of extra) w.f32(t);
}

function readTimes(r: ByteReader, version: number, duration: number, fps: number): Float64Array {
  const gridCount = r.varuint();
  const extraCount = version >= 4 ? r.varuint() : 0;
  const times = new Float64Array(gridCount + extraCount);
  let f = 0;
  let next = extraCount > 0 ? r.f32() : Infinity;
  let read = extraCount > 0 ? 1 : 0;
  for (let g = 0; g < gridCount; g++) {
    const t = bakeGridTime(g, gridCount, duration, fps);
    while (next < t) {
      times[f++] = next;
      next = read < extraCount ? (read++, r.f32()) : Infinity;
    }
    times[f++] = t;
  }
  if (f !== times.length) throw new Error('Corrupt baked file: sample times');
  return times;
}

/** Largest Frobenius norm of any bone matrix in the animation (≥ 1e-6). */
function maxMatrixNorm(anim: BakedAnimation, boneCount: number): number {
  let max = 1e-6;
  const m = anim.bones;
  for (let i = 0; i < anim.frameCount * boneCount; i++) {
    const o = i * BONE_FLOATS;
    max = Math.max(max, Math.hypot(m[o]!, m[o + 1]!, m[o + 2]!, m[o + 3]!));
  }
  return max;
}

/** Deform samples with absent frames filled from the nearest present one, so they never cost keyframes. */
function fillAbsentFrames(track: BakedDeformTrack, n: number): Float32Array {
  const out = track.vertices.slice();
  const len = track.length;
  let last = -1;
  for (let f = 0; f < n; f++) {
    if (track.present[f]) last = f;
    else if (last >= 0) out.copyWithin(f * len, last * len, last * len + len);
  }
  const first = track.present.indexOf(1);
  for (let f = 0; f < first; f++) out.copyWithin(f * len, first * len, first * len + len);
  return out;
}

/** Sparse jumps: count, then per jump the delta-coded step index, the flag and its record `[u, ...pre, ...post]` (float32, exact). */
function writeSteps(w: ByteWriter, steps: Uint8Array, jumps: Map<number, Float32Array>): void {
  const set: number[] = [];
  steps.forEach((v, i) => v && set.push(i));
  w.varuint(set.length);
  set.forEach((index, k) => {
    w.varuint(index - (k > 0 ? set[k - 1]! : 0));
    w.u8(steps[index]!);
    for (const v of jumps.get(index)!) w.f32(v);
  });
}

function readSteps(r: ByteReader, length: number, jumps: Map<number, Float32Array>, floats: number): Uint8Array {
  const steps = new Uint8Array(length);
  for (let n = r.varuint(), index = 0, k = 0; k < n; k++) {
    index += r.varuint();
    steps[index] = r.u8();
    const record = new Float32Array(1 + 2 * floats);
    for (let f = 0; f < record.length; f++) record[f] = r.f32();
    jumps.set(index, record);
  }
  return steps;
}

function packBits(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(flags.length / 8));
  flags.forEach((v, i) => {
    if (v) out[i >> 3] = out[i >> 3]! | (1 << (i & 7));
  });
  return out;
}

function unpackBits(bits: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bits[i >> 3]! >> (i & 7)) & 1;
  return out;
}

/** Value at sample k on the line between keys s and e, exactly as the decoder computes it (float32). */
function lerpByTime(vs: number, ve: number, times: Float64Array, s: number, e: number, k: number): number {
  return Math.fround(vs + ((ve - vs) * (times[k]! - times[s]!)) / (times[e]! - times[s]!));
}

/**
 * Write one channel (`n` samples at `src[offset + f * stride]`).
 * @param zeroExact Reconstructed values are 0 exactly where the samples are 0, and nowhere else.
 */
function encodeChannel(
  w: ByteWriter, src: Float32Array, offset: number, stride: number, n: number, times: Float64Array, tolerance: number, zeroExact = false,
): void {
  let min = Infinity;
  let max = -Infinity;
  for (let f = 0, o = offset; f < n; f++, o += stride) {
    const v = src[o]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mid = Math.fround((min + max) / 2);
  const mixesZero = zeroExact && min === 0 && max > 0;
  if (!mixesZero && max - mid <= tolerance && mid - min <= tolerance) {
    w.u8(TAG_CONSTANT);
    w.f32(mid);
    return;
  }

  const lo = Math.fround(min);
  const hi = Math.fround(max);
  const step = (hi - lo) / QUANT_STEPS;
  // Rounding to the grid costs at most step / 2; keep half the tolerance for interpolation.
  const quantized = tolerance > 0 && step <= tolerance;
  const stored = new Float64Array(n);
  const codes = quantized ? new Uint16Array(n) : null;
  for (let f = 0, o = offset; f < n; f++, o += stride) {
    if (codes) {
      let q = Math.min(QUANT_STEPS, Math.max(0, Math.round((src[o]! - lo) / step)));
      // A tiny non-zero sample must not round to an exact 0 (one step is within the tolerance).
      if (zeroExact && q === 0 && lo === 0 && src[o]! !== 0) q = 1;
      codes[f] = q;
      stored[f] = Math.fround(lo + q * step);
    } else {
      stored[f] = src[o]!;
    }
  }
  const close = (value: number, sample: number): boolean =>
    Math.abs(value - sample) <= tolerance && (!zeroExact || (value === 0) === (sample === 0));
  const fits = (s: number, e: number): boolean => {
    if (!close(stored[e]!, src[offset + e * stride]!)) return false;
    for (let k = s + 1; k < e; k++) if (!close(lerpByTime(stored[s]!, stored[e]!, times, s, e, k), src[offset + k * stride]!)) return false;
    return true;
  };
  const keys = [0];
  for (let s = 0; s < n - 1; ) {
    let e = s + 1;
    while (e + 1 < n && fits(s, e + 1)) e++;
    keys.push(e);
    s = e;
  }

  w.u8(quantized ? TAG_QUANTIZED : TAG_FLOAT);
  w.varuint(keys.length);
  for (let i = 1; i < keys.length; i++) w.varuint(keys[i]! - keys[i - 1]!);
  if (codes) {
    w.f32(lo);
    w.f32(hi);
    for (const k of keys) w.u16(codes[k]!);
  } else {
    for (const k of keys) w.f32(stored[k]!);
  }
}

let keyScratch = new Int32Array(64);
let valueScratch = new Float64Array(64);

function decodeChannel(r: ByteReader, out: Float32Array, offset: number, stride: number, n: number, times: Float64Array): void {
  const tag = r.u8();
  if (tag === TAG_CONSTANT) {
    const v = r.f32();
    for (let f = 0, o = offset; f < n; f++, o += stride) out[o] = v;
    return;
  }
  const count = r.varuint();
  if (keyScratch.length < count) {
    keyScratch = new Int32Array(count);
    valueScratch = new Float64Array(count);
  }
  const keys = keyScratch;
  const values = valueScratch;
  keys[0] = 0;
  for (let i = 1; i < count; i++) keys[i] = keys[i - 1]! + r.varuint();
  if (tag === TAG_QUANTIZED) {
    const lo = r.f32();
    const step = (r.f32() - lo) / QUANT_STEPS;
    for (let i = 0; i < count; i++) values[i] = Math.fround(lo + r.u16() * step);
  } else if (tag === TAG_FLOAT) {
    for (let i = 0; i < count; i++) values[i] = r.f32();
  } else {
    throw new Error(`Corrupt baked file: channel tag ${tag}`);
  }
  out[offset] = values[0]!;
  for (let i = 1; i < count; i++) {
    const s = keys[i - 1]!;
    const e = keys[i]!;
    const vs = values[i - 1]!;
    const ve = values[i]!;
    for (let k = s + 1; k < e; k++) out[offset + k * stride] = vs + ((ve - vs) * (times[k]! - times[s]!)) / (times[e]! - times[s]!);
    out[offset + e * stride] = ve;
  }
}
