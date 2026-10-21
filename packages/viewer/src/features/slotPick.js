import { drawOrderSlots, slotHullVertices } from '../tabula/geometry.js';

/**
 * @param {string} name
 * @param {string} query
 */
export function matchesFilter(name, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return String(name || '').toLowerCase().includes(q);
}

/**
 * @param {number} x
 * @param {number} y
 * @param {ArrayLike<number>} verts interleaved x,y
 * @param {number} [count]
 */
export function pointInPolygon(x, y, verts, count = verts.length) {
  if (count < 6) return false;
  let inside = false;
  const n = Math.floor(count / 2);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i * 2];
    const yi = verts[i * 2 + 1];
    const xj = verts[j * 2];
    const yj = verts[j * 2 + 1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Pick the front-most region/mesh slot under a point in spine-local space.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {{ x: number, y: number }} local
 * @returns {string | null}
 */
export function pickSlotAtLocal(inst, local) {
  const slots = drawOrderSlots(inst?.spine?.skeleton);
  if (!slots?.length) return null;
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const name = slot?.data?.name;
    if (!name || inst.hiddenSlots?.has(name)) continue;
    if (slot.bone && slot.bone.active === false) continue;
    const attachment = slot.attachment;
    if (!attachment) continue;
    const verts = slotHullVertices(inst.atlas.data, slot, attachment);
    if (!verts) continue;
    if (pointInPolygon(local.x, local.y, verts, verts.length)) return name;
  }
  return null;
}
