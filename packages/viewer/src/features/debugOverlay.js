import * as PIXI from 'pixi.js';
import { scene } from '../app/sceneStore.js';
import { worldPosition } from '../tabula/skeletonAccess.js';
import { drawStockDebug } from '../tabula/debugDraw.js';

const DEBUG_Z = 9999999;
const IK_COLOR = 0x4fc3f7;
const PHYS_COLOR = 0xe8a87c;
const EVENT_LABEL_MS = 1200;
const EVENT_FONT_PX = 26;
const EVENT_TRAVEL_PX = 120;

/** @type {Map<string, PIXI.Graphics>} */
const gizmosById = new Map();

/** @type {Map<string, {
 *   spine: any,
 *   listener: { event: Function },
 *   layer: PIXI.Container,
 *   items: { text: PIXI.Text, born: number, name: string }[],
 * }>} */
const eventFxById = new Map();

/** @type {Record<string, boolean>} */
export const DEFAULT_DEBUG_FLAGS = {
  bones: false,
  meshHull: false,
  meshTriangles: false,
  clipping: false,
  regions: false,
  paths: false,
  boundingBoxes: false,
  events: false,
  ik: false,
  physics: false,
};

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {Record<string, boolean>} flags
 */
export function paintConstraintGizmos(inst, flags) {
  syncEventLabels(inst, flags);
  tickEventLabels(inst);
  const gfx = ensureGizmo(inst);
  if (!gfx) return;
  gfx.clear();
  const skeleton = inst?.spine?.skeleton;
  if (!skeleton) return;
  drawStockDebug(gfx, inst.spine, flags);
  if (flags.ik) drawIk(gfx, skeleton);
  if (flags.physics) drawPhysics(gfx, skeleton);
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
export function disposeConstraintGizmos(inst) {
  disposeEventLabels(inst);
  const gfx = gizmosById.get(inst.id);
  if (gfx) {
    if (!gfx.destroyed) gfx.destroy();
    gizmosById.delete(inst.id);
  }
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {Record<string, boolean>} flags
 */
function syncEventLabels(inst, flags) {
  if (!flags.events || !inst?.spine?.state) {
    disposeEventLabels(inst);
    return;
  }
  const current = eventFxById.get(inst.id);
  if (current && current.spine === inst.spine) return;
  disposeEventLabels(inst);
  const spine = inst.spine;
  const layer = new PIXI.Container();
  layer.eventMode = 'none';
  layer.zIndex = DEBUG_Z + 1;
  spine.sortableChildren = true;
  spine.addChild(layer);
  /** @type {{ text: PIXI.Text, born: number, name: string }[]} */
  const items = [];
  const listener = {
    event(_entry, event) {
      const name = event?.name;
      if (!name) return;
      const now = performance.now();
      const existing = items.find((item) => item.name === name && !item.text.destroyed);
      if (existing) {
        existing.born = now;
        existing.text.alpha = 1;
        existing.text.y = 0;
        return;
      }
      const text = new PIXI.Text(name, eventLabelStyle(spine));
      text.anchor.set(0.5, 1);
      text.resolution = 2;
      text.alpha = 1;
      text.y = 0;
      layer.addChild(text);
      items.push({ text, born: now, name });
    },
  };
  spine.state.addListener(listener);
  eventFxById.set(inst.id, { spine, listener, layer, items });
}

/** @param {any} spine */
function worldScale(spine) {
  const zoom = Number(scene.camera?.zoom) || 1;
  const local = Math.abs(spine?.scale?.x || spine?.scale?.y || 1);
  return Math.max(0.2, local * zoom);
}

/** @param {any} spine */
function eventLabelStyle(spine) {
  const scale = worldScale(spine);
  const fontSize = Math.max(16, Math.round(EVENT_FONT_PX / scale));
  const stroke = Math.max(3, Math.round(4 / scale));
  return {
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    fontSize,
    fontWeight: '700',
    fill: 0xffe566,
    stroke: 0x111111,
    strokeThickness: stroke,
    dropShadow: true,
    dropShadowColor: 0x000000,
    dropShadowAlpha: 0.9,
    dropShadowBlur: Math.max(2, Math.round(4 / scale)),
    dropShadowDistance: Math.max(1, Math.round(2 / scale)),
    align: 'center',
    padding: 8,
  };
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function tickEventLabels(inst) {
  const fx = eventFxById.get(inst.id);
  if (!fx) return;
  const now = performance.now();
  const scale = worldScale(fx.spine);
  const travel = EVENT_TRAVEL_PX / scale;
  for (let i = fx.items.length - 1; i >= 0; i -= 1) {
    const item = fx.items[i];
    const t = Math.min(1, (now - item.born) / EVENT_LABEL_MS);
    if (t >= 1 || item.text.destroyed) {
      if (!item.text.destroyed) item.text.destroy();
      fx.items.splice(i, 1);
      continue;
    }
    item.text.alpha = 1 - t;
    item.text.y = -t * travel;
  }
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function disposeEventLabels(inst) {
  const fx = eventFxById.get(inst.id);
  if (!fx) return;
  try {
    fx.spine?.state?.removeListener?.(fx.listener);
  } catch {
    /* spine already torn down */
  }
  if (fx.layer && !fx.layer.destroyed) fx.layer.destroy({ children: true });
  eventFxById.delete(inst.id);
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function ensureGizmo(inst) {
  if (!inst?.spine) return null;
  let gfx = gizmosById.get(inst.id);
  if (!gfx || gfx.destroyed) {
    gfx = new PIXI.Graphics();
    gfx.eventMode = 'none';
    gfx.zIndex = DEBUG_Z;
    inst.spine.sortableChildren = true;
    inst.spine.addChild(gfx);
    gizmosById.set(inst.id, gfx);
  }
  return gfx;
}

/** @param {PIXI.Graphics} gfx @param {any} skeleton */
function drawIk(gfx, skeleton) {
  const list = skeleton.ikConstraints || [];
  gfx.lineStyle(1.5, IK_COLOR, 0.95);
  for (const ik of list) {
    const bone = worldPosition(ik.bone || ik.bones?.[ik.bones.length - 1]);
    const target = worldPosition(ik.target);
    if (!bone || !target) continue;
    gfx.moveTo(bone.worldX, bone.worldY);
    gfx.lineTo(target.worldX, target.worldY);
    gfx.beginFill(IK_COLOR, 0.9);
    gfx.drawCircle(target.worldX, target.worldY, 4);
    gfx.endFill();
    if (ik.bendDirection != null && ik.bones?.length) {
      const mid = worldPosition(ik.bones[0]);
      if (mid) {
        gfx.lineStyle(1, IK_COLOR, 0.45);
        gfx.moveTo(mid.worldX, mid.worldY);
        gfx.lineTo(target.worldX, target.worldY);
        gfx.lineStyle(1.5, IK_COLOR, 0.95);
      }
    }
  }
}

/** @param {PIXI.Graphics} gfx @param {any} skeleton */
function drawPhysics(gfx, skeleton) {
  const list = skeleton.physicsConstraints || [];
  gfx.lineStyle(1.5, PHYS_COLOR, 0.9);
  for (const phys of list) {
    const bone = worldPosition(phys.bone);
    if (!bone) continue;
    gfx.beginFill(PHYS_COLOR, 0.85);
    gfx.drawCircle(bone.worldX, bone.worldY, 5);
    gfx.endFill();
    const parent = worldPosition(phys.bone?.parent || phys.bone?.bone?.parent);
    if (parent) {
      gfx.moveTo(parent.worldX, parent.worldY);
      gfx.lineTo(bone.worldX, bone.worldY);
    }
  }
}
