/**
 * Size of what the skeleton draws now, in its own units (unscaled by the instance transform).
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @returns {{ width: number, height: number } | null}
 */
export function liveSkeletonBounds(inst) {
  const view = inst?.spine;
  if (!view || typeof view.getPoseBounds !== 'function') return null;
  const rect = view.getPoseBounds();
  if (Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  return null;
}

/**
 * @param {number} value
 */
export function formatDimension(value) {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  const fixed = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0$/, '').replace(/(\.\d*[1-9])0$/, '$1');
}
