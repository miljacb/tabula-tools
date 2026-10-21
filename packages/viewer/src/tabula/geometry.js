import { computeRegionGeometry, computeRegionWorldVertices, computeWorldVertices, currentRegionPath } from 'tabula-pixi/core/attachments.js';

/**
 * @param {{ type?: string } | null | undefined} attachment
 * @returns {'region' | 'mesh' | 'clip' | 'skip'}
 */
export function attachmentKind(attachment) {
  switch (attachment?.type) {
    case 'region': return 'region';
    case 'mesh': return 'mesh';
    case 'clipping': return 'clip';
    default: return 'skip';
  }
}

/** Slots in current draw order. */
export function drawOrderSlots(skeleton) {
  return skeleton?.drawOrder || skeleton?.slots || [];
}

/**
 * The atlas region a region or mesh attachment draws now (follows sequences).
 * @param {import('tabula-pixi').AtlasData} atlas
 */
export function regionOf(atlas, slot, attachment) {
  return atlas?.regions?.get(currentRegionPath(attachment, slot)) ?? null;
}

/**
 * World-space outline of the attachment in a slot: the quad of a region or the hull of a mesh.
 * @param {import('tabula-pixi').AtlasData} atlas
 * @returns {Float32Array | null} x,y pairs
 */
export function slotHullVertices(atlas, slot, attachment) {
  const kind = attachmentKind(attachment);
  if (kind === 'region') {
    const region = regionOf(atlas, slot, attachment);
    if (!region) return null;
    const out = new Float32Array(8);
    computeRegionWorldVertices(slot, computeRegionGeometry(attachment, region).offsets, out, 0, 2);
    return out;
  }
  if (kind === 'mesh') {
    const len = attachment.worldVerticesLength;
    if (!len) return null;
    const out = new Float32Array(len);
    computeWorldVertices(attachment, slot, 0, len, out, 0, 2);
    const hull = ((attachment.hullLength || len) >> 1) * 2;
    return hull >= len ? out : out.subarray(0, hull);
  }
  return null;
}
