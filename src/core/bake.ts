/**
 * Animation baking (design §7.4 "matrix mode").
 *
 * A baked animation stores samples of everything the renderer reads from a
 * posed skeleton: bone world matrices (after path constraints), slot colors
 * and deform vertices. Samples sit on a base grid (a multiple of the key
 * rate) plus extra samples wherever interpolation would deviate from live
 * playback by more than the bake tolerance (error-driven refinement, split at
 * keys and bezier knots). Discrete state (attachments, draw order, sequence
 * frames) is evaluated from the IR's key lists at exact times, so switches
 * happen at the same instant as in live playback. Playback interpolates the
 * samples; at sample times it is bit-identical to live evaluation.
 *
 * Baked data is renderer-independent apart from the Y axis convention it was
 * baked with (`yDown`), which playback checks. The `.baked` file format and
 * its compression live in `baked-format.ts`.
 */

import { Skeleton } from './skeleton.js';
import { applyAnimation } from './animation.js';
import { bezierKnotTimes } from './curves.js';
import { hypot2 } from './math.js';
import type { AnimationData, Attachment, SkeletonData } from './types.js';

/** Sample rate when the key frame rate cannot be detected (design §10.3: 30 fps + interpolation). */
export const DEFAULT_BAKE_FPS = 30;

/**
 * Default bake tolerance: the largest vertex deviation from live playback
 * allowed between samples, in skeleton units. With the default encode
 * budget (0.05) the total stays under the design's 0.5 px at 1× scale;
 * games show these assets downscaled (the 1792-unit big-win overlay is
 * ~0.4–0.6 px per unit on screen).
 */
export const DEFAULT_BAKE_TOLERANCE = 0.25;

/** Floats per baked bone sample: a, b, c, d, worldX, worldY. */
export const BONE_FLOATS = 6;
/** Floats per baked slot color sample: r, g, b, a, darkR, darkG, darkB. */
export const SLOT_FLOATS = 7;

/** Sampled deform for one slot. */
export interface BakedDeformTrack {
  slotIndex: number;
  /** Floats per sample. */
  length: number;
  /** 1 if the slot had deform at that sample, 0 if not. */
  present: Uint8Array;
  /** frameCount × length floats. */
  vertices: Float32Array;
}

/** Samples of one animation. */
export interface BakedAnimation {
  name: string;
  duration: number;
  /** Base sample rate: the grid t = i / fps (the last grid sample at t = duration). */
  fps: number;
  /** Number of samples (grid samples plus refinement samples). */
  frameCount: number;
  /** Sample times, ascending, `frameCount` entries; the first is 0 and the last the duration. */
  times: Float64Array;
  /** frameCount × boneCount × {@link BONE_FLOATS}. */
  bones: Float32Array;
  /** frameCount × slotCount × {@link SLOT_FLOATS}. */
  slots: Float32Array;
  deform: BakedDeformTrack[];
  /**
   * Intervals containing a jump (the first key after the setup pose, a
   * stepped curve, a key between samples, an attachment switch moving a
   * path). Entry `frame × boneCount + bone` is {@link STEP_JUMP} when the
   * bone's pose jumps inside the interval from sample `frame` to `frame + 1`;
   * {@link boneJumps} then holds where and the poses on both sides, so
   * playback interpolates the motion on each side and snaps across the jump
   * instead of smearing it over the interval.
   */
  boneSteps: Uint8Array;
  /**
   * Per {@link boneSteps} entry: `[u, ...pre, ...post]`: the jump's position
   * in the interval (0–1), then the pose just before and just after it
   * ({@link BONE_FLOATS} floats each).
   */
  boneJumps: Map<number, Float32Array>;
  /** Same as {@link boneSteps} for slot colors (`frame × slotCount + slot`). */
  slotSteps: Uint8Array;
  /** Same as {@link boneJumps} for slot colors ({@link SLOT_FLOATS} floats per pose). */
  slotJumps: Map<number, Float32Array>;
}

/** Baked samples for the animations of one skeleton (the `.baked` file contents). */
export interface BakedSkeletonData {
  /** Skeleton name, for diagnostics. */
  name: string;
  /** Hash of the source skeleton; playback refuses mismatched data. */
  hash: string;
  /** Y axis convention the matrices were baked with. */
  yDown: boolean;
  /** Vertex error budget the samples were compressed with, skeleton units (0 = exact). */
  maxError: number;
  /** Vertex deviation from live allowed between samples when baking, skeleton units (0 = base grid only). */
  tolerance: number;
  boneCount: number;
  slotCount: number;
  animations: BakedAnimation[];
}

/** Options for {@link bakeSkeletonAnimations}. */
export interface BakeOptions {
  /** Sample rate in frames per second. Default: {@link autoBakeFps}. */
  fps?: number;
  /** Bake for a y-down renderer (Pixi). Default true. */
  yDown?: boolean;
  /** Skin to bake with (affects which attachments path constraints and deform see). Default: skeleton default. */
  skin?: string;
  /** Only bake these animations. Default: all. */
  animations?: string[];
  /**
   * Largest vertex deviation from live playback allowed between samples,
   * skeleton units: intervals that exceed it get extra samples (split at the
   * keys and bezier knots inside them, else halved), down to 1/128 of the
   * base interval. 0 = base grid only. Default {@link DEFAULT_BAKE_TOLERANCE}.
   */
  tolerance?: number;
}

/** Time of sample `frame`. */
export function bakedFrameTime(anim: BakedAnimation, frame: number): number {
  return anim.times[Math.min(Math.max(frame, 0), anim.frameCount - 1)]!;
}

/** Number of base-grid samples of an animation: t = i / fps, the last at the duration. */
export function bakeGridCount(duration: number, fps: number): number {
  return Math.max(1, Math.ceil(duration * fps - 1e-6)) + 1;
}

/** Time of base-grid sample `i` (see {@link bakeGridCount}). */
export function bakeGridTime(i: number, count: number, duration: number, fps: number): number {
  return i >= count - 1 ? duration : i / fps;
}

/** Interval lookup tables (base-grid cell → last sample at or before the cell start), per animation. */
const cellIndex = new WeakMap<BakedAnimation, Int32Array>();
/** Animations with at most this many samples are searched linearly. */
const LINEAR_SEARCH_SAMPLES = 16;

/** Index of the last sample at or before `time` (0 before the start, the last sample at or after the end). */
export function bakedSampleBefore(anim: BakedAnimation, time: number): number {
  const times = anim.times;
  const last = times.length - 1;
  if (!(time > times[0]!)) return 0;
  if (time >= times[last]!) return last;
  let i: number;
  if (last < LINEAR_SEARCH_SAMPLES) {
    i = 0;
  } else {
    let cells = cellIndex.get(anim);
    if (!cells) {
      const n = Math.ceil(anim.duration * anim.fps) + 1;
      cells = new Int32Array(n);
      for (let k = 0, s = 0; k < n; k++) {
        while (s < last && times[s + 1]! <= k / anim.fps) s++;
        cells[k] = s;
      }
      cellIndex.set(anim, cells);
    }
    i = cells[Math.min(Math.floor(time * anim.fps), cells.length - 1)]!;
    while (i > 0 && times[i]! > time) i--;
  }
  while (i < last && times[i + 1]! <= time) i++;
  return i;
}

/** Step flag: the pose jumps inside the interval (see BakedAnimation.boneSteps). */
export const STEP_JUMP = 1;
/** An interval is checked for a jump when the live pose at its middle is off the samples' lerp by this share of their change... */
const JUMP_DEVIATION_SHARE = 0.25;
/** ...and a jump is confirmed when this share of the change happens within the located window (continuous fast motion is not). */
const JUMP_SHARE = 0.5;
/** Sub-samples per checked interval for locating the jump, then bisection steps (1/48 s / 16 / 2^10 ≈ 1.3 µs, less in refined intervals). */
const JUMP_SUBSTEPS = 16;
const JUMP_BISECTIONS = 10;
/** Noise floors (positions in units, matrix terms, color channels). */
const JUMP_MIN_POSITION = 1e-3;
const JUMP_MIN_MATRIX = 1e-5;
const JUMP_MIN_COLOR = 1e-4;

/** Authoring frame rates recognized from key times, in order of preference. */
const KEY_FRAME_RATES = [24, 25, 30, 50, 60];
/** Spine exports round key times to 4 decimals. */
const KEY_TIME_TOLERANCE = 2e-4;
/** Automatic sample rates are at least this high. */
const MIN_AUTO_FPS = 30;

/**
 * Frame rate the animations were keyed at: the first of 24, 25, 30, 50, 60 fps
 * whose grid contains every key time of the continuous (interpolated)
 * timelines, or null if none does.
 */
export function detectKeyFrameRate(animations: readonly AnimationData[]): number | null {
  const fits = (rate: number): boolean =>
    animations.every((animation) =>
      animation.timelines.every((tl) => {
        if (!('curves' in tl)) return true; // discrete timelines are evaluated live, not sampled
        for (const t of tl.times) if (Math.abs(t - Math.round(t * rate) / rate) > KEY_TIME_TOLERANCE) return false;
        return true;
      }));
  return KEY_FRAME_RATES.find(fits) ?? null;
}

/**
 * Default base sample rate. Every key must land on a sample, so changes
 * between two keys are never smeared across a key:
 * - with refinement (`refine`, a bake tolerance > 0): the detected key rate
 *   itself (24 fps keys → 24). Each base interval then holds one curve
 *   segment per timeline, and refinement adds samples where it is not linear
 *   enough.
 * - without: the smallest multiple of the key rate that is at least 30 fps
 *   (24 → 48).
 * Falls back to {@link DEFAULT_BAKE_FPS}.
 */
export function autoBakeFps(animations: readonly AnimationData[], refine = false): number {
  const rate = detectKeyFrameRate(animations);
  if (!rate) return DEFAULT_BAKE_FPS;
  return refine ? rate : rate * Math.ceil(MIN_AUTO_FPS / rate);
}

/**
 * True if `data` can be baked. Skeletons with physics constraints cannot:
 * their pose depends on the frame history (frame rate, previous animations,
 * skeleton movement), so they always play live. See docs/design.md.
 */
export function canBakeSkeleton(data: SkeletonData): boolean {
  return !(data.physicsConstraints?.length);
}

/**
 * Bake animations of `data` by evaluating them live at the sample times.
 * Returns no animations for skeletons with physics ({@link canBakeSkeleton}).
 *
 * @example
 * ```ts
 * const baked = bakeSkeletonAnimations(data, { animations: ['symbolWin'], tolerance: 0.25 });
 * const bytes = serializeBakedData(baked, bakeEncoding(data, 0.05));
 * ```
 */
export function bakeSkeletonAnimations(data: SkeletonData, options: BakeOptions = {}): BakedSkeletonData {
  const yDown = options.yDown ?? true;
  if (!canBakeSkeleton(data)) {
    const tolerance = options.tolerance ?? DEFAULT_BAKE_TOLERANCE;
    return { name: data.name, hash: data.hash, yDown, maxError: 0, tolerance, boneCount: data.bones.length, slotCount: data.slots.length, animations: [] };
  }
  const skeleton = new Skeleton(data);
  skeleton.scaleY = yDown ? -1 : 1;
  if (options.skin) skeleton.setSkin(options.skin);
  const names = options.animations ? new Set(options.animations) : null;
  const selected = data.animations.filter((a) => !names || names.has(a.name));
  const tolerance = options.tolerance ?? DEFAULT_BAKE_TOLERANCE;
  const fps = options.fps ?? autoBakeFps(selected, tolerance > 0);
  const scratch = new Skeleton(data);
  const reach = attachmentReach(data);
  const animations = selected.map((a) => bakeAnimation(skeleton, scratch, a, fps, tolerance, reach));
  return { name: data.name, hash: data.hash, yDown, maxError: 0, tolerance, boneCount: data.bones.length, slotCount: data.slots.length, animations };
}

/**
 * Per bone, the largest distance from the bone origin (bone-local units) of
 * any vertex that bone transforms: region corners, mesh, clipping and
 * bounding box vertices, point attachments, and deform offsets; at least
 * `minReach`. A matrix error ΔM moves those vertices by at most |ΔM|·reach.
 */
export function attachmentReach(data: SkeletonData, minReach = 0): Float32Array {
  const reach = new Float32Array(data.bones.length);
  const grow = (bone: number, r: number): void => {
    if (r > reach[bone]!) reach[bone] = r;
  };
  const deformExtra = new Map<Attachment, number>();
  for (const anim of data.animations) {
    for (const tl of anim.timelines) {
      if (tl.kind !== 'deform') continue;
      let max = 0;
      for (const frame of tl.frames) for (let i = 0; i < frame.length; i += 2) max = Math.max(max, Math.hypot(frame[i]!, frame[i + 1]!));
      deformExtra.set(tl.attachment, Math.max(deformExtra.get(tl.attachment) ?? 0, max));
    }
  }
  for (const skin of data.skins) {
    for (const [slotIndex, attachments] of skin.attachments) {
      const slotBone = data.slots[slotIndex]!.boneIndex;
      for (const a of attachments.values()) {
        switch (a.type) {
          case 'region':
            // The trimmed quad lies inside the untrimmed, rotated rectangle.
            grow(slotBone, Math.hypot(a.x, a.y) + Math.hypot(a.width * a.scaleX, a.height * a.scaleY) / 2);
            break;
          case 'point':
            grow(slotBone, Math.hypot(a.x, a.y));
            break;
          case 'path':
            break; // only drives constraints, whose results are baked into bone matrices
          default: {
            // Unweighted deform frames are absolute positions; weighted ones are offsets.
            const extra = deformExtra.get(a.type === 'mesh' ? a.timelineAttachment : a) ?? 0;
            const { bones, vertices } = a;
            if (!bones) {
              let max = extra;
              for (let i = 0; i < vertices.length; i += 2) max = Math.max(max, Math.hypot(vertices[i]!, vertices[i + 1]!));
              grow(slotBone, max);
              break;
            }
            for (let v = 0, b = 0; v < bones.length; ) {
              const n = bones[v++]!;
              for (const end = v + n; v < end; v++, b += 3) grow(bones[v]!, Math.hypot(vertices[b]!, vertices[b + 1]!) + extra);
            }
          }
        }
      }
    }
  }
  for (let i = 0; i < reach.length; i++) reach[i] = Math.max(reach[i]!, minReach);
  return reach;
}

/** Refinement stops at base interval / 2^MAX_REFINE_DEPTH (1/24 s → 0.33 ms). */
const MAX_REFINE_DEPTH = 7;
/** Where inside an interval the interpolated pose is checked against live. */
const REFINE_PROBES = [0.25, 0.5, 0.75];
/** Probes see only part of an interval, so refinement aims below the tolerance by this factor. */
const REFINE_MARGIN = 0.8;
/** Slot color deviation (0–1) allowed between samples. */
const COLOR_REFINE_TOLERANCE = 1 / 255;
/**
 * Breakpoints closer than this to an interval end are not split at (seconds;
 * far above float32 time resolution, far below a frame). Exported keys are
 * rounded to 0.1 ms, so a key often sits 33 µs after a 24 fps grid sample.
 */
const MIN_SPLIT_GAP = 1e-6;

/** One live pose: bone floats then slot floats ({@link posedValues} layout), and deform per tracked slot. */
interface PoseSample {
  time: number;
  values: Float32Array;
  deform: (number[] | null)[];
}

/** A jump inside one interval ({@link detectJumps}). */
interface JumpRecord {
  bone: boolean;
  entity: number;
  record: Float32Array;
}

/**
 * Sorted times inside the animation where some curve value's slope can
 * change: every key time, and the knots of flattened bezier segments.
 */
function collectBreakpoints(animation: AnimationData): Float64Array {
  const set = new Set<number>();
  for (const tl of animation.timelines) {
    if (tl.kind === 'event') continue;
    const times = tl.times;
    for (let i = 0; i < times.length; i++) {
      set.add(times[i]!);
      if (!('curves' in tl) || i + 1 >= times.length) continue;
      const curve = tl.curves[i];
      if (curve === null || curve === 'stepped' || curve === undefined) continue;
      for (let k = 0; k + 3 < curve.length; k += 4) for (const x of bezierKnotTimes(times[i]!, curve[k]!, curve[k + 2]!, times[i + 1]!)) set.add(x);
    }
  }
  return Float64Array.from(set).sort();
}

/**
 * Where to split [t0, t1]: the breakpoint inside it closest to the middle,
 * else the middle. Splitting exactly at a kink makes both sides linear, so
 * even a breakpoint near an end beats halving.
 */
function splitTime(breakpoints: Float64Array, t0: number, t1: number): number {
  const mid = (t0 + t1) / 2;
  const margin = MIN_SPLIT_GAP;
  let best = mid;
  let bestDistance = Infinity;
  // First breakpoint > t0 + margin (binary search).
  let lo = 0, hi = breakpoints.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (breakpoints[m]! <= t0 + margin) lo = m + 1;
    else hi = m;
  }
  for (let i = lo; i < breakpoints.length && breakpoints[i]! < t1 - margin; i++) {
    const d = Math.abs(breakpoints[i]! - mid);
    if (d < bestDistance) {
      bestDistance = d;
      best = breakpoints[i]!;
    }
  }
  return best;
}

function bakeAnimation(
  skeleton: Skeleton, scratch: Skeleton, animation: AnimationData, fps: number, tolerance: number, reach: Float32Array,
): BakedAnimation {
  const boneCount = skeleton.bones.length;
  const slotCount = skeleton.slots.length;
  const boneFloats = boneCount * BONE_FLOATS;
  const deformSlots = [...new Set(animation.timelines.flatMap((tl) => (tl.kind === 'deform' ? [tl.target] : [])))].sort((a, b) => a - b);
  const pose = (time: number): PoseSample => ({
    time,
    values: posedValues(skeleton, animation, time),
    deform: deformSlots.map((s) => {
      const d = skeleton.slots[s]!.deform;
      return d.length > 0 ? d.slice() : null;
    }),
  });
  const breakpoints = collectBreakpoints(animation);
  const samples: PoseSample[] = [];
  const intervals: JumpRecord[][] = [];

  // Interpolated pose inside [a, b] exactly as playback computes it (applyBakedPose on a two-sample bake),
  // compared with live at a few probes; returns the deviation relative to the tolerances (> 1 = too far).
  const deviation = (a: PoseSample, b: PoseSample, jumps: JumpRecord[]): number => {
    const pair = assemble(animation.name, b.time, fps, [a, b], [jumps], boneCount, slotCount, deformSlots);
    let worst = 0;
    for (const u of REFINE_PROBES) {
      const t = a.time + u * (b.time - a.time);
      const live = pose(t);
      for (const slotIndex of deformSlots) scratch.slots[slotIndex]!.deform.length = 0; // the pair has no track where neither side deforms
      applyBakedPose(pair, scratch, t, false);
      for (let i = 0, o = 0; i < boneCount; i++, o += BONE_FLOATS) {
        const bone = scratch.bones[i]!;
        const v = live.values;
        const matrix = spectralNorm(bone.a - v[o]!, bone.b - v[o + 1]!, bone.c - v[o + 2]!, bone.d - v[o + 3]!);
        const error = Math.hypot(bone.worldX - v[o + 4]!, bone.worldY - v[o + 5]!) + matrix * reach[i]!;
        worst = Math.max(worst, error / tolerance);
      }
      for (let i = 0, o = boneFloats; i < slotCount; i++, o += SLOT_FLOATS) {
        const { color: c, darkColor: d } = scratch.slots[i]!;
        const v = live.values;
        const error = Math.max(
          Math.abs(c.r - v[o]!), Math.abs(c.g - v[o + 1]!), Math.abs(c.b - v[o + 2]!), Math.abs(c.a - v[o + 3]!),
          d ? Math.max(Math.abs(d.r - v[o + 4]!), Math.abs(d.g - v[o + 5]!), Math.abs(d.b - v[o + 6]!)) : 0,
        );
        worst = Math.max(worst, error / COLOR_REFINE_TOLERANCE);
      }
      deformSlots.forEach((slotIndex, k) => {
        const want = live.deform[k];
        const got = scratch.slots[slotIndex]!.deform;
        // Deform starting or stopping inside the interval: playback holds the side sample's state, so split.
        if ((want?.length ?? 0) !== got.length) {
          worst = Infinity;
          return;
        }
        if (!want) return;
        let max = 0;
        for (let j = 0; j < want.length; j++) max = Math.max(max, Math.abs(got[j]! - want[j]!));
        const o = skeleton.slots[slotIndex]!.data.boneIndex * BONE_FLOATS;
        const v = live.values;
        worst = Math.max(worst, (max * Math.SQRT2 * spectralNorm(v[o]!, v[o + 1]!, v[o + 2]!, v[o + 3]!)) / tolerance);
      });
    }
    return worst;
  };

  const refine = (a: PoseSample, b: PoseSample, depth: number): void => {
    const jumps = detectJumps(skeleton, animation, a, b);
    if (tolerance > 0 && depth < MAX_REFINE_DEPTH && deviation(a, b, jumps) > REFINE_MARGIN) {
      const t = Math.fround(splitTime(breakpoints, a.time, b.time));
      if (t > a.time && t < b.time) {
        const m = pose(t);
        refine(a, m, depth + 1);
        refine(m, b, depth + 1);
        return;
      }
    }
    intervals.push(jumps);
    samples.push(b);
  };

  const gridCount = bakeGridCount(animation.duration, fps);
  let previous = pose(0);
  samples.push(previous);
  for (let g = 1; g < gridCount; g++) {
    const next = pose(bakeGridTime(g, gridCount, animation.duration, fps));
    refine(previous, next, 0);
    previous = next;
  }
  return assemble(animation.name, animation.duration, fps, samples, intervals, boneCount, slotCount, deformSlots);
}

/** Largest factor by which the 2×2 matrix [a b; c d] stretches a vector (its largest singular value). */
function spectralNorm(a: number, b: number, c: number, d: number): number {
  const f = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt((f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2);
}

/** Build a {@link BakedAnimation} from samples and the jumps of each interval between them. */
function assemble(
  name: string, duration: number, fps: number, samples: PoseSample[], intervals: JumpRecord[][],
  boneCount: number, slotCount: number, deformSlots: number[],
): BakedAnimation {
  const frameCount = samples.length;
  const boneFloats = boneCount * BONE_FLOATS;
  const slotFloats = slotCount * SLOT_FLOATS;
  const baked: BakedAnimation = {
    name,
    duration,
    fps,
    frameCount,
    times: Float64Array.from(samples, (s) => s.time),
    bones: new Float32Array(frameCount * boneFloats),
    slots: new Float32Array(frameCount * slotFloats),
    deform: [],
    boneSteps: new Uint8Array(frameCount * boneCount),
    boneJumps: new Map(),
    slotSteps: new Uint8Array(frameCount * slotCount),
    slotJumps: new Map(),
  };
  samples.forEach((s, f) => {
    baked.bones.set(s.values.subarray(0, boneFloats), f * boneFloats);
    baked.slots.set(s.values.subarray(boneFloats, boneFloats + slotFloats), f * slotFloats);
  });
  intervals.forEach((jumps, f) => {
    for (const { bone, entity, record } of jumps) {
      const index = f * (bone ? boneCount : slotCount) + entity;
      (bone ? baked.boneSteps : baked.slotSteps)[index] = STEP_JUMP;
      (bone ? baked.boneJumps : baked.slotJumps).set(index, record);
    }
  });
  deformSlots.forEach((slotIndex, k) => {
    const length = samples.reduce((max, s) => Math.max(max, s.deform[k]?.length ?? 0), 0);
    if (length === 0) return;
    const present = new Uint8Array(frameCount);
    const vertices = new Float32Array(frameCount * length);
    samples.forEach((s, f) => {
      const d = s.deform[k];
      if (!d) return;
      present[f] = 1;
      vertices.set(d, f * length);
    });
    baked.deform.push({ slotIndex, length, present, vertices });
  });
  return baked;
}

/**
 * Find jumps inside the interval from sample `a` to sample `b`. Checked per
 * bone (matrix and position separately) and slot: if the live pose at the
 * interval's middle is far off the samples' lerp, the interval is
 * sub-sampled to find the window with the largest change; if that window
 * holds most of the change, it is bisected down to µs and the poses on both
 * sides are recorded ({@link STEP_JUMP}). Fast continuous motion spreads its
 * change over the sub-samples and is left to interpolation (and refinement).
 */
function detectJumps(skeleton: Skeleton, animation: AnimationData, a: PoseSample, b: PoseSample): JumpRecord[] {
  const t0 = a.time;
  const t1 = b.time;
  const boneCount = skeleton.bones.length;
  const slotCount = skeleton.slots.length;
  const boneFloats = boneCount * BONE_FLOATS;
  const s0 = a.values;
  const s1 = b.values;
  const change = (x: Float32Array, y: Float32Array, o: number, n: number): number => {
    let max = 0;
    for (let k = o; k < o + n; k++) max = Math.max(max, Math.abs(y[k]! - x[k]!));
    return max;
  };

  // Groups: [offset, floats, noise floor, entity offset, entity floats, is bone, entity index].
  type Group = [number, number, number, number, number, boolean, number];
  const candidates: Group[] = [];
  let mid: Float32Array | null = null;
  const check = (group: Group): void => {
    const [o, n, floor] = group;
    const total = change(s0, s1, o, n);
    if (total <= floor) return;
    const m = (mid ??= posedValues(skeleton, animation, (t0 + t1) / 2));
    let deviation = 0;
    for (let k = o; k < o + n; k++) deviation = Math.max(deviation, Math.abs(m[k]! - (s0[k]! + s1[k]!) / 2));
    if (deviation > floor && deviation >= JUMP_DEVIATION_SHARE * total) candidates.push(group);
  };
  for (let i = 0; i < boneCount; i++) {
    const o = i * BONE_FLOATS;
    check([o, 4, JUMP_MIN_MATRIX, o, BONE_FLOATS, true, i]);
    check([o + 4, 2, JUMP_MIN_POSITION, o, BONE_FLOATS, true, i]);
  }
  for (let i = 0; i < slotCount; i++) {
    const o = boneFloats + i * SLOT_FLOATS;
    check([o, SLOT_FLOATS, JUMP_MIN_COLOR, o, SLOT_FLOATS, false, i]);
  }
  const found: JumpRecord[] = [];
  if (candidates.length === 0) return found;

  const h = (t1 - t0) / JUMP_SUBSTEPS;
  const sub: Float32Array[] = [s0];
  for (let j = 1; j < JUMP_SUBSTEPS; j++) sub.push(posedValues(skeleton, animation, t0 + j * h));
  sub.push(s1);
  const done = new Set<number>();
  for (const [o, n, , eo, en, bone, entity] of candidates) {
    const key = bone ? entity : boneCount + entity;
    if (done.has(key)) continue; // matrix and position of one bone jumping together
    const total = change(s0, s1, o, n);
    let window = 0;
    for (let j = 1; j < JUMP_SUBSTEPS; j++) if (change(sub[j]!, sub[j + 1]!, o, n) > change(sub[window]!, sub[window + 1]!, o, n)) window = j;
    if (change(sub[window]!, sub[window + 1]!, o, n) < JUMP_SHARE * total) continue;
    let lo = t0 + window * h, hi = lo + h;
    let before = sub[window]!, after = sub[window + 1]!;
    for (let k = 0; k < JUMP_BISECTIONS; k++) {
      const tm = (lo + hi) / 2;
      const m = posedValues(skeleton, animation, tm);
      if (change(before, m, o, n) >= change(m, after, o, n)) {
        hi = tm;
        after = m;
      } else {
        lo = tm;
        before = m;
      }
    }
    if (change(before, after, o, n) < JUMP_SHARE * total) continue;
    const record = new Float32Array(1 + 2 * en);
    record[0] = ((lo + hi) / 2 - t0) / (t1 - t0);
    record.set(before.subarray(eo, eo + en), 1);
    record.set(after.subarray(eo, eo + en), 1 + en);
    done.add(key);
    found.push({ bone, entity, record });
  }
  return found;
}

/** Live pose at `time` as bone floats followed by slot floats (same layout as one sample). Reuses a buffer. */
function posedValues(skeleton: Skeleton, animation: AnimationData, time: number): Float32Array {
  skeleton.setToSetupPose();
  applyAnimation(animation, skeleton, time);
  skeleton.updateWorldTransform();
  const size = skeleton.bones.length * BONE_FLOATS + skeleton.slots.length * SLOT_FLOATS;
  const out = new Float32Array(size);
  let o = 0;
  for (const bone of skeleton.bones) {
    out[o++] = bone.a;
    out[o++] = bone.b;
    out[o++] = bone.c;
    out[o++] = bone.d;
    out[o++] = bone.worldX;
    out[o++] = bone.worldY;
  }
  for (const slot of skeleton.slots) {
    const { color, darkColor } = slot;
    out[o++] = color.r;
    out[o++] = color.g;
    out[o++] = color.b;
    out[o++] = color.a;
    out[o++] = darkColor ? darkColor.r : 0;
    out[o++] = darkColor ? darkColor.g : 0;
    out[o++] = darkColor ? darkColor.b : 0;
  }
  return out;
}

/**
 * Pose `skeleton` from baked samples at `time`: restores world matrices, slot
 * colors and deform. Discrete state (attachments, draw order, sequence frames)
 * must be applied first by evaluating the animation's discrete timelines.
 */
export function applyBakedPose(baked: BakedAnimation, skeleton: Skeleton, time: number, flipY: boolean): void {
  const times = baked.times;
  const i = bakedSampleBefore(baked, time);
  let alpha = 0;
  if (i < baked.frameCount - 1) {
    const t0 = times[i]!;
    const t1 = times[i + 1]!;
    alpha = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
  }
  const j = alpha > 0 ? i + 1 : i;
  const sy = flipY ? -1 : 1;

  const bones = skeleton.bones;
  const boneData = baked.bones;
  const boneSteps = baked.boneSteps;
  let p = i * bones.length * BONE_FLOATS;
  let q = j * bones.length * BONE_FLOATS;
  for (let b = 0, step = i * bones.length; b < bones.length; b++, p += BONE_FLOATS, q += BONE_FLOATS, step++) {
    const bone = bones[b]!;
    if (alpha === 0) {
      bone.a = boneData[p]!;
      bone.b = boneData[p + 1]!;
      bone.c = boneData[p + 2]! * sy;
      bone.d = boneData[p + 3]! * sy;
      bone.worldX = boneData[p + 4]!;
      bone.worldY = boneData[p + 5]! * sy;
      continue;
    }
    // Across a jump, interpolate on its side: sample → pre-jump pose, or post-jump pose → sample.
    let d0 = boneData, o0 = p, d1 = boneData, o1 = q, w = alpha;
    if (boneSteps[step]) {
      const jump = baked.boneJumps.get(step)!;
      const u = jump[0]!;
      if (alpha < u) {
        d1 = jump;
        o1 = 1;
        w = alpha / u;
      } else {
        d0 = jump;
        o0 = 1 + BONE_FLOATS;
        w = u < 1 ? (alpha - u) / (1 - u) : 1;
      }
    }
    // Interpolate the 2×2 linear part of two baked bone matrices. Component-wise
    // lerp shrinks the result when the rotation changes a lot between samples
    // (a spinning icon pulses), so each matrix is split into a rotation and an
    // upper-triangular scale/shear part (M = R(θ)·[sx k; 0 sy]); θ is interpolated
    // along the shorter arc and the scale/shear part linearly. Exact for rotation
    // plus scale; rotations of more than 180° between samples are ambiguous.
    //
    // When one matrix is (nearly) zero, e.g. a bone scaling to 0, its rotation is
    // undefined (atan2(0, 0) = 0, or noise after compression) and the arc would
    // swing toward it; component-wise lerp is exact there.
    // (Inline rather than a helper: a call per bone that V8 does not inline
    // boxes its double arguments, a heap allocation per bone per frame.)
    const a0 = d0[o0]!, b0 = d0[o0 + 1]!, c0 = d0[o0 + 2]!, e0 = d0[o0 + 3]!;
    const a1 = d1[o1]!, b1 = d1[o1 + 1]!, c1 = d1[o1 + 2]!, e1 = d1[o1 + 3]!;
    // Same linear part on both sides: about half of all bone samples (static or only translating).
    const same = a0 === a1 && b0 === b1 && c0 === c1 && e0 === e1;
    let n0 = 0, n1 = 0;
    if (!same) {
      n0 = a0 * a0 + b0 * b0 + c0 * c0 + e0 * e0;
      n1 = a1 * a1 + b1 * b1 + c1 * c1 + e1 * e1;
    }
    if (same) {
      bone.a = a0;
      bone.b = b0;
      bone.c = c0 * sy;
      bone.d = e0 * sy;
    } else if (Math.min(n0, n1) <= DEGENERATE_NORM_RATIO_SQ * Math.max(n0, n1)) {
      const beta = 1 - w;
      bone.a = a0 * beta + a1 * w;
      bone.b = b0 * beta + b1 * w;
      bone.c = (c0 * beta + c1 * w) * sy;
      bone.d = (e0 * beta + e1 * w) * sy;
    } else {
      const r0 = Math.atan2(c0, a0);
      const r1 = Math.atan2(c1, a1);
      let delta = r1 - r0;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;
      // Unrotated parts: R(-θ)·M = [sx k; 0 sy] with sx = |column 0|.
      const cos0 = Math.cos(r0), sin0 = Math.sin(r0), cos1 = Math.cos(r1), sin1 = Math.sin(r1);
      // sx = hypot2(a, c), fast path inlined (same operations, bit-identical; a
      // NaN in x alone also yields NaN here): a call V8 does not inline boxes
      // its double arguments and result. Zero, infinite or NaN max -> hypot2.
      let sx0: number, sx1: number;
      {
        const x = Math.abs(a0), y = Math.abs(c0);
        const max = x > y ? x : y;
        if (max > 0 && max < Infinity) {
          const n0 = x / max, n1 = y / max;
          sx0 = Math.sqrt(n0 * n0 + n1 * n1) * max;
        } else sx0 = hypot2(a0, c0);
      }
      {
        const x = Math.abs(a1), y = Math.abs(c1);
        const max = x > y ? x : y;
        if (max > 0 && max < Infinity) {
          const n0 = x / max, n1 = y / max;
          sx1 = Math.sqrt(n0 * n0 + n1 * n1) * max;
        } else sx1 = hypot2(a1, c1);
      }
      const k0 = cos0 * b0 + sin0 * e0, sy0 = cos0 * e0 - sin0 * b0;
      const k1 = cos1 * b1 + sin1 * e1, sy1 = cos1 * e1 - sin1 * b1;
      const beta = 1 - w;
      const isx = sx0 * beta + sx1 * w;
      const k = k0 * beta + k1 * w;
      const isy = sy0 * beta + sy1 * w;
      const r = r0 + delta * w;
      const cos = Math.cos(r), sin = Math.sin(r);
      bone.a = cos * isx;
      bone.b = cos * k - sin * isy;
      bone.c = sin * isx * sy;
      bone.d = (sin * k + cos * isy) * sy;
    }
    bone.worldX = d0[o0 + 4]! * (1 - w) + d1[o1 + 4]! * w;
    bone.worldY = (d0[o0 + 5]! * (1 - w) + d1[o1 + 5]! * w) * sy;
  }

  const slots = skeleton.slots;
  const slotData = baked.slots;
  const slotSteps = baked.slotSteps;
  p = i * slots.length * SLOT_FLOATS;
  q = j * slots.length * SLOT_FLOATS;
  for (let s = 0, step = i * slots.length; s < slots.length; s++, p += SLOT_FLOATS, q += SLOT_FLOATS, step++) {
    const slot = slots[s]!;
    let d0 = slotData, o0 = p, d1 = slotData, o1 = q, w1 = alpha;
    if (alpha > 0 && slotSteps[step]) {
      const jump = baked.slotJumps.get(step)!;
      const u = jump[0]!;
      if (alpha < u) {
        d1 = jump;
        o1 = 1;
        w1 = alpha / u;
      } else {
        d0 = jump;
        o0 = 1 + SLOT_FLOATS;
        w1 = u < 1 ? (alpha - u) / (1 - u) : 1;
      }
    }
    const w0 = 1 - w1;
    const c = slot.color;
    c.r = d0[o0]! * w0 + d1[o1]! * w1;
    c.g = d0[o0 + 1]! * w0 + d1[o1 + 1]! * w1;
    c.b = d0[o0 + 2]! * w0 + d1[o1 + 2]! * w1;
    c.a = d0[o0 + 3]! * w0 + d1[o1 + 3]! * w1;
    const dark = slot.darkColor;
    if (dark) {
      dark.r = d0[o0 + 4]! * w0 + d1[o1 + 4]! * w1;
      dark.g = d0[o0 + 5]! * w0 + d1[o1 + 5]! * w1;
      dark.b = d0[o0 + 6]! * w0 + d1[o1 + 6]! * w1;
    }
  }

  for (const track of baked.deform) {
    const deform = skeleton.slots[track.slotIndex]!.deform;
    if (!track.present[i]) {
      if (deform.length !== 0) deform.length = 0;
      continue;
    }
    const n = track.length;
    const v = track.vertices;
    const blend = track.present[j] ? alpha : 0;
    const keep = 1 - blend;
    if (deform.length !== n) deform.length = n;
    for (let k = 0, a = i * n, b = j * n; k < n; k++) deform[k] = v[a + k]! * keep + v[b + k]! * blend;
  }
}

const deformMasks = new WeakMap<BakedAnimation, Uint8Array>();

/**
 * Slots whose deform {@link applyBakedPose} fully rewrites (index → 1), for
 * `skeleton.setSlotsToSetupPose(mask)`: those keep their deform storage
 * between frames instead of being cleared and reallocated.
 */
export function bakedDeformSlots(baked: BakedAnimation, slotCount: number): Uint8Array {
  let mask = deformMasks.get(baked);
  if (!mask || mask.length !== slotCount) {
    mask = new Uint8Array(slotCount);
    for (const track of baked.deform) if (track.slotIndex < slotCount) mask[track.slotIndex] = 1;
    deformMasks.set(baked, mask);
  }
  return mask;
}

/** Matrices whose norm is below this share of the other sample's are interpolated component-wise (squared). */
const DEGENERATE_NORM_RATIO_SQ = 0.1 * 0.1;

/** Apply only the discrete timelines (attachments, draw order, sequences) of `animation` at `time`. */
export function applyDiscreteTimelines(animation: AnimationData, skeleton: Skeleton, time: number): void {
  applyAnimation(discreteView(animation), skeleton, time);
}

const discreteCache = new WeakMap<AnimationData, AnimationData>();

function discreteView(animation: AnimationData): AnimationData {
  let view = discreteCache.get(animation);
  if (!view) {
    view = {
      name: animation.name,
      duration: animation.duration,
      timelines: animation.timelines.filter((t) => t.kind === 'attachment' || t.kind === 'drawOrder' || t.kind === 'sequence'),
    };
    discreteCache.set(animation, view);
  }
  return view;
}
