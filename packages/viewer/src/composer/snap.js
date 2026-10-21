/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 * @typedef {{ axis: 'x' | 'y', at: number }} Guide
 */

/**
 * Snap `moving` to edges and centers of `others`.
 * Coordinates are in the same space as `threshold` (screen pixels).
 * @param {Box} moving
 * @param {Box[]} others
 * @param {number} threshold
 * @returns {{ box: Box, guides: Guide[] }}
 */
export function snapBox(moving, others, threshold) {
  const box = { ...moving };
  /** @type {Guide[]} */
  const guides = [];
  const xSnap = bestAxis(box, others, threshold, 'x');
  const ySnap = bestAxis(box, others, threshold, 'y');
  if (xSnap) {
    box.x += xSnap.delta;
    guides.push({ axis: 'x', at: xSnap.at });
  }
  if (ySnap) {
    box.y += ySnap.delta;
    guides.push({ axis: 'y', at: ySnap.at });
  }
  return { box, guides };
}

/**
 * @param {Box} moving
 * @param {Box[]} others
 * @param {number} threshold
 * @param {'x' | 'y'} axis
 * @returns {{ delta: number, at: number } | null}
 */
function bestAxis(moving, others, threshold, axis) {
  const size = axis === 'x' ? moving.width : moving.height;
  const origin = axis === 'x' ? moving.x : moving.y;
  const movingEdges = [origin, origin + size / 2, origin + size];
  let best = /** @type {{ delta: number, at: number } | null} */ (null);
  for (const other of others) {
    const o = axis === 'x' ? other.x : other.y;
    const oSize = axis === 'x' ? other.width : other.height;
    const targets = [o, o + oSize / 2, o + oSize];
    for (const edge of movingEdges) {
      for (const target of targets) {
        const delta = target - edge;
        if (Math.abs(delta) > threshold) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, at: target };
        }
      }
    }
  }
  return best;
}

/**
 * Snap a world-space box's left/top to a grid, within `threshold` world units.
 * @param {{ x: number, y: number, width: number, height: number }} moving
 * @param {number} gridSize
 * @param {number} threshold
 * @returns {{ box: { x: number, y: number, width: number, height: number }, guides: Guide[] }}
 */
export function snapToGrid(moving, gridSize, threshold) {
  const box = { ...moving };
  /** @type {Guide[]} */
  const guides = [];
  if (!(gridSize > 0)) return { box, guides };
  const left = nearestGrid(box.x, gridSize);
  const top = nearestGrid(box.y, gridSize);
  if (Math.abs(left - box.x) <= threshold) {
    box.x = left;
    guides.push({ axis: 'x', at: left });
  }
  if (Math.abs(top - box.y) <= threshold) {
    box.y = top;
    guides.push({ axis: 'y', at: top });
  }
  return { box, guides };
}

/** @param {number} value @param {number} size */
export function nearestGrid(value, size) {
  if (!(size > 0)) return value;
  return Math.round(value / size) * size;
}
