export { drawOrderSlots } from './geometry.js';

/**
 * @param {{ getCurrent: (track: number) => object | null } | null | undefined} state
 * @param {number} trackIndex
 */
export function currentTrackEntry(state, trackIndex) {
  return state ? state.getCurrent(trackIndex) : null;
}

/**
 * @param {{ worldX: number, worldY: number } | { bone?: { worldX: number, worldY: number } } | null | undefined} obj bone, or a constraint's bone
 * @returns {{ worldX: number, worldY: number } | null}
 */
export function worldPosition(obj) {
  if (!obj) return null;
  if (typeof obj.worldX === 'number' && typeof obj.worldY === 'number') return obj;
  return obj.bone ? worldPosition(obj.bone) : null;
}
