import { scene } from '../app/sceneStore.js';
import { clientToGlobal } from '../app/stage.js';

/**
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 */
export function clientDragRect(x0, y0, x1, y1) {
  const a = clientToGlobal(x0, y0);
  const b = clientToGlobal(x1, y1);
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} inner
 * @param {{ x: number, y: number, width: number, height: number }} outer
 */
export function rectFullyInside(inner, outer) {
  if (inner.width <= 0 || inner.height <= 0) return false;
  const innerRight = inner.x + inner.width;
  const innerBottom = inner.y + inner.height;
  const outerRight = outer.x + outer.width;
  const outerBottom = outer.y + outer.height;
  return inner.x >= outer.x
    && inner.y >= outer.y
    && innerRight <= outerRight
    && innerBottom <= outerBottom;
}

/**
 * Instances whose bounds are fully inside the drag rectangle (stage/global space).
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 */
export function instanceIdsFullyInsideMarquee(x0, y0, x1, y1) {
  const outer = clientDragRect(x0, y0, x1, y1);
  if (outer.width < 1 || outer.height < 1) return [];
  /** @type {string[]} */
  const ids = [];
  for (const inst of scene.instances) {
    if (!inst.visible) continue;
    const inner = inst.spine.getBounds();
    if (rectFullyInside(inner, outer)) ids.push(inst.id);
  }
  return ids;
}
