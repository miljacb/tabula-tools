/**
 * Keyframe search and curve interpolation with Spine 4.x semantics.
 *
 * Bezier segments are evaluated exactly the way spine-core does it: each segment
 * is flattened into {@link BEZIER_SAMPLES} points with forward differencing and
 * then linearly interpolated. Matching this (instead of solving the cubic
 * exactly) keeps poses identical to the official runtime.
 */

import type { CurveData } from './types.js';

/** Number of sampled points per bezier segment (spine-core BEZIER_SIZE / 2). */
export const BEZIER_SAMPLES = 9;

/** Flattened bezier samples (x,y pairs) per (curve array, channel). */
const sampleCache = new WeakMap<number[] | Float32Array, Float32Array[]>();

/**
 * Index of the last frame whose time is <= `time`. Assumes `time >= times[0]`.
 */
export function searchFrame(times: ArrayLike<number>, time: number): number {
  const n = times.length;
  for (let i = 1; i < n; i++) {
    if (times[i]! > time) return i - 1;
  }
  return n - 1;
}

/**
 * Interpolated value of one channel between frame `i` and `i + 1`.
 *
 * @param curve Curve stored on frame `i`.
 * @param channel Channel index inside a multi-channel timeline.
 * @param t1 Time of frame i. @param v1 Value at frame i.
 * @param t2 Time of frame i+1. @param v2 Value at frame i+1.
 * @param time Current time, t1 <= time <= t2.
 */
export function interpolate(curve: CurveData, channel: number, t1: number, v1: number, t2: number, v2: number, time: number): number {
  if (curve === null) return v1 + ((time - t1) / (t2 - t1)) * (v2 - v1);
  if (curve === 'stepped') return v1;
  const samples = bezierSamples(curve, channel, t1, v1, t2, v2);
  if (samples[0]! > time) return v1 + ((time - t1) / (samples[0]! - t1)) * (samples[1]! - v1);
  const n = BEZIER_SAMPLES * 2;
  for (let i = 2; i < n; i += 2) {
    if (samples[i]! >= time) {
      const x = samples[i - 2]!;
      const y = samples[i - 1]!;
      return y + ((time - x) / (samples[i]! - x)) * (samples[i + 1]! - y);
    }
  }
  const x = samples[n - 2]!;
  const y = samples[n - 1]!;
  return y + ((time - x) / (t2 - x)) * (v2 - y);
}

/** Interpolation percent in [0,1] for timelines whose bezier values are percentages (deform). */
export function curvePercent(curve: CurveData, t1: number, t2: number, time: number): number {
  return interpolate(curve, 0, t1, 0, t2, 1, time);
}

function bezierSamples(curve: number[] | Float32Array, channel: number, t1: number, v1: number, t2: number, v2: number): Float32Array {
  let perChannel = sampleCache.get(curve);
  if (!perChannel) {
    perChannel = [];
    sampleCache.set(curve, perChannel);
  }
  let samples = perChannel[channel];
  if (!samples) {
    const k = channel * 4;
    samples = flattenBezier(t1, v1, curve[k] ?? t1, curve[k + 1] ?? v1, curve[k + 2] ?? t2, curve[k + 3] ?? v2, t2, v2);
    perChannel[channel] = samples;
  }
  return samples;
}

/**
 * Times of the {@link BEZIER_SAMPLES} points a bezier segment from `t1` to `t2`
 * (time control points `cx1`, `cx2`) is flattened into. Between these knots
 * (and the keys) a curve value changes linearly with time, so they are where
 * its slope can change; the baker splits intervals at them.
 */
export function bezierKnotTimes(t1: number, cx1: number, cx2: number, t2: number): Float32Array {
  const flat = flattenBezier(t1, 0, cx1, 0, cx2, 0, t2, 0);
  const out = new Float32Array(BEZIER_SAMPLES);
  for (let i = 0; i < BEZIER_SAMPLES; i++) out[i] = flat[i * 2]!;
  return out;
}

/** Forward-differenced flattening identical to spine-core `CurveTimeline.setBezier`. */
function flattenBezier(time1: number, value1: number, cx1: number, cy1: number, cx2: number, cy2: number, time2: number, value2: number): Float32Array {
  const out = new Float32Array(BEZIER_SAMPLES * 2);
  const tmpx = (time1 - cx1 * 2 + cx2) * 0.03;
  const tmpy = (value1 - cy1 * 2 + cy2) * 0.03;
  const dddx = ((cx1 - cx2) * 3 - time1 + time2) * 0.006;
  const dddy = ((cy1 - cy2) * 3 - value1 + value2) * 0.006;
  let ddx = tmpx * 2 + dddx;
  let ddy = tmpy * 2 + dddy;
  let dx = (cx1 - time1) * 0.3 + tmpx + dddx * 0.16666667;
  let dy = (cy1 - value1) * 0.3 + tmpy + dddy * 0.16666667;
  let x = time1 + dx;
  let y = value1 + dy;
  for (let i = 0; i < out.length; i += 2) {
    out[i] = x;
    out[i + 1] = y;
    dx += ddx;
    dy += ddy;
    ddx += dddx;
    ddy += dddy;
    x += dx;
    y += dy;
  }
  return out;
}
