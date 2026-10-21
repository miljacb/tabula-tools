import * as PIXI from 'pixi.js';
import { MASK_COLORS } from '../constants.js';
import { slotHullVertices } from '../tabula/geometry.js';

const HIGHLIGHT_Z = 9999998;
const LINE_WIDTH = 2;
const FILL_ALPHA = 0.45;

/** @type {Map<string, PIXI.Graphics>} */
const overlayById = new Map();

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @returns {PIXI.Graphics}
 */
function ensureOverlay(inst) {
  let gfx = overlayById.get(inst.id);
  if (!gfx || gfx.destroyed) {
    gfx = new PIXI.Graphics();
    gfx.eventMode = 'none';
    gfx.zIndex = HIGHLIGHT_Z;
    inst.spine.sortableChildren = true;
    inst.spine.addChild(gfx);
    overlayById.set(inst.id, gfx);
  }
  return gfx;
}

/** @param {import('../app/sceneStore.js').SpineInstance | null | undefined} inst */
export function clearSlotHighlight(inst) {
  if (!inst) return;
  const gfx = overlayById.get(inst.id);
  if (gfx && !gfx.destroyed) gfx.clear();
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
export function disposeSlotHighlight(inst) {
  const gfx = overlayById.get(inst.id);
  if (gfx) {
    if (!gfx.destroyed) gfx.destroy();
    overlayById.delete(inst.id);
  }
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
function rgbToHex(r, g, b) {
  return ((r * 255) << 16) | ((g * 255) << 8) | (b * 255);
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @returns {{ r: number, g: number, b: number }}
 */
function highlightRgb(inst) {
  if (inst.pulse) {
    const step = Math.floor(Date.now() / 250) % 3;
    if (step === 0) return { r: 1, g: 0, b: 0 };
    if (step === 1) return { r: 0, g: 1, b: 0 };
    return { r: 0, g: 0, b: 1 };
  }
  const mc = MASK_COLORS[inst.maskColorIndex] || MASK_COLORS[0];
  return { r: mc.r, g: mc.g, b: mc.b };
}

/**
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {number}
 */
function rgbToHexFrom(rgb) {
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * @param {{ set?: Function, r: number, g: number, b: number, a: number }} color
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 */
function setColor(color, r, g, b, a) {
  if (typeof color.set === 'function') color.set(r, g, b, a);
  else {
    color.r = r;
    color.g = g;
    color.b = b;
    color.a = a;
  }
}

/**
 * Slot tint (re-applied each tick after animation; color keys can win until the next apply).
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {object} slot
 */
function applySlotColorTint(inst, slot) {
  if (!slot.color || slot.color.a === 0) return;
  const { r, g, b } = highlightRgb(inst);
  setColor(slot.color, r, g, b, slot.color.a);
}

/**
 * @param {PIXI.Graphics} gfx
 * @param {number} color
 * @param {Float32Array} vertices
 * @param {number} count
 */
function fillAndStrokePolygon(gfx, color, vertices, count) {
  if (count < 6) return;
  const flat = Array.from(vertices.subarray(0, count));
  gfx.beginFill(color, FILL_ALPHA);
  gfx.drawPolygon(flat);
  gfx.endFill();
  gfx.lineStyle(LINE_WIDTH, color, 1);
  gfx.moveTo(vertices[0], vertices[1]);
  for (let i = 2; i < count; i += 2) {
    gfx.lineTo(vertices[i], vertices[i + 1]);
  }
  gfx.closePath();
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance | null} inst
 */
export function applySlotHighlight(inst) {
  if (!inst?.spine?.skeleton) {
    clearSlotHighlight(inst);
    return;
  }
  const gfx = ensureOverlay(inst);
  gfx.clear();

  if (!inst.selectedSlot || inst.hiddenSlots?.has(inst.selectedSlot)) return;

  const skeleton = inst.spine.skeleton;
  const slot = skeleton.findSlot(inst.selectedSlot);
  if (!slot?.bone?.active) return;

  applySlotColorTint(inst, slot);

  if (slot.color && slot.color.a === 0) return;

  const attachment = slot.attachment;
  if (!attachment) return;

  const verts = slotHullVertices(inst.atlas.data, slot, attachment);
  if (!verts) return;
  fillAndStrokePolygon(gfx, rgbToHexFrom(highlightRgb(inst)), verts, verts.length);
}
