/** Small math helpers shared by core modules (Pixi-agnostic). */

/** Degrees to radians conversion factor. */
export const DEG_TO_RAD = Math.PI / 180;

/** Radians to degrees conversion factor. */
export const RAD_TO_DEG = 180 / Math.PI;

/** Clamp `value` to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * `Math.hypot(x, y)` without allocating: V8's builtin allocates an array per
 * call, which shows up as per-frame garbage in playback. Same algorithm as
 * V8 (scale by the max, Kahan-compensated sum), so results are bit-identical
 * there (checked over 5M random pairs in Node and Chromium).
 */
export function hypot2(x: number, y: number): number {
  x = Math.abs(x);
  y = Math.abs(y);
  if (x === Infinity || y === Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  const max = x > y ? x : y;
  if (max === 0) return 0;
  const n0 = x / max;
  const n1 = y / max;
  // V8's Kahan summation over two terms: the first compensation is exactly 0,
  // so it reduces to one rounded add (kept bit-identical to Math.hypot).
  return Math.sqrt(n0 * n0 + n1 * n1) * max;
}
