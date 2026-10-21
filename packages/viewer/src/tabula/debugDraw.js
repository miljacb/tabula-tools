import { computeWorldVertices } from 'tabula-pixi/core/attachments.js';
import { attachmentKind, drawOrderSlots, slotHullVertices } from './geometry.js';

const BONE_COLOR = 0xff3b30;
const REGION_COLOR = 0x00d1ff;
const HULL_COLOR = 0xffd60a;
const TRIANGLE_COLOR = 0xffd60a;
const CLIP_COLOR = 0xc77dff;
const PATH_COLOR = 0xff9f0a;
const BOX_COLOR = 0x30d158;

/** @param {import('pixi.js').Graphics} gfx @param {ArrayLike<number>} v @param {number} count */
function outline(gfx, v, count) {
  if (count < 4) return;
  gfx.moveTo(v[0], v[1]);
  for (let i = 2; i < count; i += 2) gfx.lineTo(v[i], v[i + 1]);
  gfx.closePath();
}

/**
 * Draw the diagnostic overlays the debug toggles ask for, in the view's local space.
 * @param {import('pixi.js').Graphics} gfx
 * @param {import('../tabula/view.js').TabulaView} view
 * @param {Record<string, boolean>} flags
 */
export function drawStockDebug(gfx, view, flags) {
  const skeleton = view.skeleton;
  const atlas = view.asset.atlas;
  if (flags.bones) {
    gfx.lineStyle(1.5, BONE_COLOR, 0.95);
    for (const bone of skeleton.bones) {
      if (bone.active === false) continue;
      const length = bone.data.length || 0;
      gfx.moveTo(bone.worldX, bone.worldY);
      gfx.lineTo(bone.worldX + bone.a * length, bone.worldY + bone.c * length);
    }
    for (const bone of skeleton.bones) {
      if (bone.active === false) continue;
      gfx.beginFill(BONE_COLOR, 0.9);
      gfx.drawCircle(bone.worldX, bone.worldY, 3);
      gfx.endFill();
    }
  }
  const wantsSlots = flags.regions || flags.meshHull || flags.meshTriangles || flags.clipping || flags.paths;
  if (wantsSlots) {
    for (const slot of drawOrderSlots(skeleton)) {
      if (!slot.bone || slot.bone.active === false) continue;
      const attachment = slot.attachment;
      if (!attachment) continue;
      const kind = attachmentKind(attachment);
      if (kind === 'region' && flags.regions) {
        const verts = slotHullVertices(atlas, slot, attachment);
        if (verts) {
          gfx.lineStyle(1, REGION_COLOR, 0.9);
          outline(gfx, verts, verts.length);
        }
      } else if (kind === 'mesh' && (flags.meshHull || flags.meshTriangles)) {
        const len = attachment.worldVerticesLength;
        const all = new Float32Array(len);
        computeWorldVertices(attachment, slot, 0, len, all, 0, 2);
        if (flags.meshTriangles) {
          gfx.lineStyle(1, TRIANGLE_COLOR, 0.5);
          const tris = attachment.triangles;
          for (let i = 0; i + 2 < tris.length; i += 3) {
            const a = tris[i] * 2;
            const b = tris[i + 1] * 2;
            const c = tris[i + 2] * 2;
            gfx.moveTo(all[a], all[a + 1]);
            gfx.lineTo(all[b], all[b + 1]);
            gfx.lineTo(all[c], all[c + 1]);
            gfx.closePath();
          }
        }
        if (flags.meshHull) {
          gfx.lineStyle(1.5, HULL_COLOR, 0.95);
          outline(gfx, all, ((attachment.hullLength || len) >> 1) * 2);
        }
      } else if (kind === 'clip' && flags.clipping) {
        const len = attachment.worldVerticesLength;
        const verts = new Float32Array(len);
        computeWorldVertices(attachment, slot, 0, len, verts, 0, 2);
        gfx.lineStyle(1.5, CLIP_COLOR, 0.95);
        outline(gfx, verts, len);
      } else if (attachment.type === 'path' && flags.paths) {
        const len = attachment.worldVerticesLength;
        const verts = new Float32Array(len);
        computeWorldVertices(attachment, slot, 0, len, verts, 0, 2);
        gfx.lineStyle(1.5, PATH_COLOR, 0.95);
        gfx.moveTo(verts[0], verts[1]);
        for (let i = 2; i < len; i += 2) gfx.lineTo(verts[i], verts[i + 1]);
      }
    }
  }
  if (flags.boundingBoxes) {
    gfx.lineStyle(1.5, BOX_COLOR, 0.95);
    for (const box of view.clip.getBoundingBoxes()) outline(gfx, box.vertices, box.vertexCount * 2);
  }
}
