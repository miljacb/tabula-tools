import * as PIXI from 'pixi.js';
import { MASK_COLORS } from '../constants.js';
import { slotHullVertices } from '../tabula/geometry.js';

const HIGHLIGHT_Z = 9999998;
const LINE_WIDTH = 2;
const HALO_COLOR = 0x000000;
const HALO_ALPHA = 0.6;

/** Off hides every selection mark (slot outlines, bone marks) so the art can be seen clean. */
let marksVisible = true;

export function selectionMarksVisible() {
  return marksVisible;
}

/** @param {boolean} visible */
export function setSelectionMarksVisible(visible) {
  marksVisible = visible;
}

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
function strokePolygon(gfx, color, vertices, count) {
  if (count < 6) return;
  // Outline only, so the slot's art stays visible; a dark halo under it keeps it readable on light art.
  for (const [width, lineColor, alpha] of [[LINE_WIDTH + 2, HALO_COLOR, HALO_ALPHA], [LINE_WIDTH, color, 1]]) {
    gfx.lineStyle(width, lineColor, alpha);
    gfx.moveTo(vertices[0], vertices[1]);
    for (let i = 2; i < count; i += 2) {
      gfx.lineTo(vertices[i], vertices[i + 1]);
    }
    gfx.closePath();
  }
}

const BONE_MARK_COLOR = 0xd2ff00;

/**
 * Mark the selected bone: a ring at its origin and a line along its length, in skeleton space like the slot hulls.
 * @param {PIXI.Graphics} gfx
 * @param {any} bone
 * @param {number} [alpha] fainter for a hovered row
 */
function drawBoneMark(gfx, bone, alpha = 1) {
  const length = bone.data?.length || 0;
  gfx.lineStyle(2, BONE_MARK_COLOR, alpha);
  if (length > 0) {
    gfx.moveTo(bone.worldX, bone.worldY);
    gfx.lineTo(bone.worldX + length * bone.a, bone.worldY + length * bone.c);
  }
  gfx.beginFill(BONE_MARK_COLOR, 0.25 * alpha);
  gfx.drawCircle(bone.worldX, bone.worldY, 6);
  gfx.endFill();
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance | null} inst
 * @param {{ bone?: boolean }} [options] `bone` also marks the selected bone (the asset shown in the inspector)
 */
export function applySlotHighlight(inst, { bone = false } = {}) {
  if (!inst?.spine?.skeleton) {
    clearSlotHighlight(inst);
    return;
  }
  const gfx = ensureOverlay(inst);
  gfx.clear();

  if (bone && inst.selectedBone) {
    const picked = inst.spine.skeleton.findBone(inst.selectedBone);
    if (picked?.active !== false && picked) drawBoneMark(gfx, picked);
  }
  // Hovering a bone (or slot) row in the outliner shows where it is, without selecting it.
  if (inst.hoverBone && !(bone && inst.hoverBone === inst.selectedBone)) {
    const hovered = inst.spine.skeleton.findBone(inst.hoverBone);
    if (hovered && hovered.active !== false) drawBoneMark(gfx, hovered, 0.5);
  }

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
  strokePolygon(gfx, rgbToHexFrom(highlightRgb(inst)), verts, verts.length);
}
