/**
 * Skeleton instance state: bones (local, applied and world transforms), slots,
 * skin and draw order, with Spine world-transform semantics (all inherit
 * modes) and IK, transform, path and physics constraints applied in Spine
 * 4.2's update order (spine-core `Skeleton.updateCache`).
 *
 * World transforms use Spine's matrix convention:
 *   worldX' = a·x + b·y + worldX,   worldY' = c·x + d·y + worldY
 */

import { Inherit } from './types.js';
import type { Attachment, BoneData, Color, DarkColor, SkeletonData, SkinData, SlotData, BlendMode } from './types.js';
import { PathConstraint } from './path-constraint.js';
import { IkConstraint, Physics, PhysicsConstraint, TransformConstraint } from './constraints.js';
import { DEG_TO_RAD, RAD_TO_DEG } from './math.js';
import { resolveSkin, type SkinSelector } from './skins.js';

export { Physics } from './constraints.js';

/** Something in the update order: a bone or a constraint. */
interface Updatable {
  update(physics: Physics): unknown;
}

const cosDeg = (degrees: number): number => Math.cos(degrees * DEG_TO_RAD);
const sinDeg = (degrees: number): number => Math.sin(degrees * DEG_TO_RAD);

/** Below this squared scale a parent axis is treated as degenerate (spine-core constant). */
const DEGENERATE_SCALE = 0.0001;
const MIN_SCALE = 0.00001;

// ============================================================================
// Bone
// ============================================================================

/** A bone instance: local, applied and world transforms (see module doc for the matrix convention). */
export class Bone {
  /** Setup-pose data of this bone. */
  readonly data: BoneData;
  /** Skeleton that owns the bone. */
  readonly skeleton: Skeleton;
  /** Parent bone, or null for the root. */
  readonly parent: Bone | null;
  /** Direct child bones. */
  readonly children: Bone[] = [];
  /** False for a skin-required bone the current skin does not activate: not updated, its slots not drawn. */
  active = true;

  /** Local transform (setup pose + animation). */
  x = 0;
  /** Local Y (setup + animation). */
  y = 0;
  /** Local rotation in degrees. */
  rotation = 0;
  /** Local X scale. */
  scaleX = 1;
  /** Local Y scale. */
  scaleY = 1;
  /** Local X shear in degrees. */
  shearX = 0;
  /** Local Y shear in degrees. */
  shearY = 0;
  /** How the bone inherits its parent's transform (Spine 4.2 `inherit`, animatable). */
  inherit: Inherit = Inherit.Normal;

  /**
   * Applied transform: the local transform the world transform was last
   * computed from (constraints change it; spine-core `ax`, `arotation`, ...).
   */
  ax = 0;
  /** Applied local Y. */
  ay = 0;
  /** Applied rotation in degrees. */
  arotation = 0;
  /** Applied X scale. */
  ascaleX = 1;
  /** Applied Y scale. */
  ascaleY = 1;
  /** Applied X shear in degrees. */
  ashearX = 0;
  /** Applied Y shear in degrees. */
  ashearY = 0;

  /**
   * World transform, Spine convention (see module doc). Zero until the first
   * update, like spine-core, so an active child of a never-updated inactive
   * (skin-required) bone collapses to a point instead of drawing at the origin.
   */
  a = 0;
  /** World matrix element b (x of the Y axis). */
  b = 0;
  /** World matrix element c (y of the X axis). */
  c = 0;
  /** World matrix element d (y of the Y axis). */
  d = 0;
  /** World X of the bone origin. */
  worldX = 0;
  /** World Y of the bone origin. */
  worldY = 0;

  constructor(data: BoneData, skeleton: Skeleton, parent: Bone | null) {
    this.data = data;
    this.skeleton = skeleton;
    this.parent = parent;
    parent?.children.push(this);
    this.setToSetupPose();
  }

  /** Reset this bone's local transform to the setup pose. */
  setToSetupPose(): void {
    const d = this.data;
    this.x = d.x;
    this.y = d.y;
    this.rotation = d.rotation;
    this.scaleX = d.scaleX;
    this.scaleY = d.scaleY;
    this.shearX = d.shearX;
    this.shearY = d.shearY;
    this.inherit = d.inherit;
  }

  /** Compute the world transform from the local transform and the parent's world transform. */
  updateWorldTransform(): void {
    this.ax = this.x;
    this.ay = this.y;
    this.arotation = this.rotation;
    this.ascaleX = this.scaleX;
    this.ascaleY = this.scaleY;
    this.ashearX = this.shearX;
    this.ashearY = this.shearY;
    this.computeWorld();
  }

  /** Update-order step: world transform from the applied transform. */
  update(): void {
    this.computeWorld();
  }

  /** Compute the world transform from the given local values (stored as the applied transform). */
  updateWorldTransformWith(x: number, y: number, rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number): void {
    this.ax = x;
    this.ay = y;
    this.arotation = rotation;
    this.ascaleX = scaleX;
    this.ascaleY = scaleY;
    this.ashearX = shearX;
    this.ashearY = shearY;
    this.computeWorld();
  }

  /**
   * World transform from the applied transform. Argument-free on purpose: the
   * per-frame update-order call is megamorphic and never inlined, and doubles
   * passed to a call that is not inlined are boxed (a heap allocation each).
   */
  private computeWorld(): void {
    const x = this.ax, y = this.ay, rotation = this.arotation, scaleX = this.ascaleX, scaleY = this.ascaleY;
    const shearX = this.ashearX, shearY = this.ashearY;
    const skeleton = this.skeleton;
    const sx = skeleton.scaleX;
    const sy = skeleton.scaleY;
    const parent = this.parent;

    if (!parent) {
      const rotationY = rotation + 90 + shearY;
      this.a = cosDeg(rotation + shearX) * scaleX * sx;
      this.b = cosDeg(rotationY) * scaleY * sx;
      this.c = sinDeg(rotation + shearX) * scaleX * sy;
      this.d = sinDeg(rotationY) * scaleY * sy;
      this.worldX = x * sx + skeleton.x;
      this.worldY = y * sy + skeleton.y;
      return;
    }

    let pa = parent.a;
    let pb = parent.b;
    let pc = parent.c;
    let pd = parent.d;
    this.worldX = pa * x + pb * y + parent.worldX;
    this.worldY = pc * x + pd * y + parent.worldY;

    switch (this.inherit) {
      case Inherit.Normal: {
        const rotationY = rotation + 90 + shearY;
        const la = cosDeg(rotation + shearX) * scaleX;
        const lb = cosDeg(rotationY) * scaleY;
        const lc = sinDeg(rotation + shearX) * scaleX;
        const ld = sinDeg(rotationY) * scaleY;
        this.a = pa * la + pb * lc;
        this.b = pa * lb + pb * ld;
        this.c = pc * la + pd * lc;
        this.d = pc * lb + pd * ld;
        return;
      }
      case Inherit.OnlyTranslation: {
        const rotationY = rotation + 90 + shearY;
        this.a = cosDeg(rotation + shearX) * scaleX;
        this.b = cosDeg(rotationY) * scaleY;
        this.c = sinDeg(rotation + shearX) * scaleX;
        this.d = sinDeg(rotationY) * scaleY;
        break;
      }
      case Inherit.NoRotationOrReflection: {
        let s: number;
        let prx: number;
        if (skeleton.semantics41) {
          // spine-core 4.1 (differs from 4.2 only when |skeleton scale| != 1).
          s = pa * pa + pc * pc;
          if (s > DEGENERATE_SCALE) {
            s = Math.abs(pa * pd - pb * pc) / s;
            pa /= sx;
            pc /= sy;
            pb = pc * s;
            pd = pa * s;
            prx = Math.atan2(pc, pa) * RAD_TO_DEG;
          } else {
            pa = 0;
            pc = 0;
            prx = 90 - Math.atan2(pd, pb) * RAD_TO_DEG;
          }
        } else {
          const isx = 1 / sx, isy = 1 / sy;
          pa *= isx;
          pc *= isy;
          s = pa * pa + pc * pc;
          if (s > DEGENERATE_SCALE) {
            s = Math.abs(pa * pd * isy - pb * isx * pc) / s;
            pb = pc * s;
            pd = pa * s;
            prx = Math.atan2(pc, pa) * RAD_TO_DEG;
          } else {
            pa = 0;
            pc = 0;
            prx = 90 - Math.atan2(pd, pb) * RAD_TO_DEG;
          }
        }
        const rx = rotation + shearX - prx;
        const ry = rotation + shearY - prx + 90;
        const la = cosDeg(rx) * scaleX;
        const lb = cosDeg(ry) * scaleY;
        const lc = sinDeg(rx) * scaleX;
        const ld = sinDeg(ry) * scaleY;
        this.a = pa * la - pb * lc;
        this.b = pa * lb - pb * ld;
        this.c = pc * la + pd * lc;
        this.d = pc * lb + pd * ld;
        break;
      }
      case Inherit.NoScale:
      case Inherit.NoScaleOrReflection: {
        const cos = cosDeg(rotation);
        const sin = sinDeg(rotation);
        let za = (pa * cos + pb * sin) / sx;
        let zc = (pc * cos + pd * sin) / sy;
        let s = Math.sqrt(za * za + zc * zc);
        if (s > MIN_SCALE) s = 1 / s;
        za *= s;
        zc *= s;
        s = Math.sqrt(za * za + zc * zc);
        if (this.inherit === Inherit.NoScale && pa * pd - pb * pc < 0 !== (sx < 0 !== sy < 0)) s = -s;
        const r = Math.PI / 2 + Math.atan2(zc, za);
        const zb = Math.cos(r) * s;
        const zd = Math.sin(r) * s;
        const la = cosDeg(shearX) * scaleX;
        const lb = cosDeg(90 + shearY) * scaleY;
        const lc = sinDeg(shearX) * scaleX;
        const ld = sinDeg(90 + shearY) * scaleY;
        this.a = za * la + zb * lc;
        this.b = za * lb + zb * ld;
        this.c = zc * la + zd * lc;
        this.d = zc * lb + zd * ld;
        break;
      }
    }
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
  }

  /** World rotation of the X axis in degrees. */
  get worldRotationX(): number {
    return Math.atan2(this.c, this.a) * RAD_TO_DEG;
  }

  /** World scale of the X axis. */
  get worldScaleX(): number {
    return Math.sqrt(this.a * this.a + this.c * this.c);
  }

  /**
   * Recompute the applied transform from the world transform (after a
   * constraint changed the world transform directly). Port of spine-core 4.2
   * `Bone.updateAppliedTransform`.
   */
  updateAppliedTransform(): void {
    const parent = this.parent;
    const skeleton = this.skeleton;
    if (!parent) {
      this.ax = this.worldX - skeleton.x;
      this.ay = this.worldY - skeleton.y;
      this.arotation = Math.atan2(this.c, this.a) * RAD_TO_DEG;
      this.ascaleX = Math.sqrt(this.a * this.a + this.c * this.c);
      this.ascaleY = Math.sqrt(this.b * this.b + this.d * this.d);
      this.ashearX = 0;
      this.ashearY = Math.atan2(this.a * this.b + this.c * this.d, this.a * this.d - this.b * this.c) * RAD_TO_DEG;
      return;
    }
    let pa = parent.a, pb = parent.b, pc = parent.c, pd = parent.d;
    let pid = 1 / (pa * pd - pb * pc);
    let ia = pd * pid, ib = pb * pid, ic = pc * pid, id = pa * pid;
    const dx = this.worldX - parent.worldX, dy = this.worldY - parent.worldY;
    this.ax = dx * ia - dy * ib;
    this.ay = dy * id - dx * ic;
    let ra: number, rb: number, rc: number, rd: number;
    if (skeleton.semantics41) {
      // spine-core 4.1: inherit modes ignored, shear sign as in 4.1.
      ra = ia * this.a - ib * this.c;
      rb = ia * this.b - ib * this.d;
      rc = id * this.c - ic * this.a;
      rd = id * this.d - ic * this.b;
      this.ashearX = 0;
      this.ascaleX = Math.sqrt(ra * ra + rc * rc);
      if (this.ascaleX > DEGENERATE_SCALE) {
        const det = ra * rd - rb * rc;
        this.ascaleY = det / this.ascaleX;
        this.ashearY = Math.atan2(ra * rb + rc * rd, det) * RAD_TO_DEG;
        this.arotation = Math.atan2(rc, ra) * RAD_TO_DEG;
      } else {
        this.ascaleX = 0;
        this.ascaleY = Math.sqrt(rb * rb + rd * rd);
        this.ashearY = 0;
        this.arotation = 90 - Math.atan2(rd, rb) * RAD_TO_DEG;
      }
      return;
    }
    if (this.inherit === Inherit.OnlyTranslation) {
      ra = this.a;
      rb = this.b;
      rc = this.c;
      rd = this.d;
    } else {
      switch (this.inherit) {
        case Inherit.NoRotationOrReflection: {
          const s = Math.abs(pa * pd - pb * pc) / (pa * pa + pc * pc);
          pb = (-pc * skeleton.scaleX * s) / skeleton.scaleY;
          pd = (pa * skeleton.scaleY * s) / skeleton.scaleX;
          pid = 1 / (pa * pd - pb * pc);
          ia = pd * pid;
          ib = pb * pid;
          break;
        }
        case Inherit.NoScale:
        case Inherit.NoScaleOrReflection: {
          const cos = cosDeg(this.rotation), sin = sinDeg(this.rotation);
          pa = (pa * cos + pb * sin) / skeleton.scaleX;
          pc = (pc * cos + pd * sin) / skeleton.scaleY;
          let s = Math.sqrt(pa * pa + pc * pc);
          if (s > MIN_SCALE) s = 1 / s;
          pa *= s;
          pc *= s;
          s = Math.sqrt(pa * pa + pc * pc);
          if (this.inherit === Inherit.NoScale && pid < 0 !== (skeleton.scaleX < 0 !== skeleton.scaleY < 0)) s = -s;
          const r = Math.PI / 2 + Math.atan2(pc, pa);
          pb = Math.cos(r) * s;
          pd = Math.sin(r) * s;
          pid = 1 / (pa * pd - pb * pc);
          ia = pd * pid;
          ib = pb * pid;
          ic = pc * pid;
          id = pa * pid;
          break;
        }
      }
      ra = ia * this.a - ib * this.c;
      rb = ia * this.b - ib * this.d;
      rc = id * this.c - ic * this.a;
      rd = id * this.d - ic * this.b;
    }
    this.ashearX = 0;
    this.ascaleX = Math.sqrt(ra * ra + rc * rc);
    if (this.ascaleX > DEGENERATE_SCALE) {
      const det = ra * rd - rb * rc;
      this.ascaleY = det / this.ascaleX;
      this.ashearY = -Math.atan2(ra * rb + rc * rd, det) * RAD_TO_DEG;
      this.arotation = Math.atan2(rc, ra) * RAD_TO_DEG;
    } else {
      this.ascaleX = 0;
      this.ascaleY = Math.sqrt(rb * rb + rd * rd);
      this.ashearY = 0;
      this.arotation = 90 - Math.atan2(rd, rb) * RAD_TO_DEG;
    }
  }
}

// ============================================================================
// Slot
// ============================================================================

/** A slot instance: current attachment, colors, sequence frame and deform of one draw slot. */
export class Slot {
  /** Setup-pose data of this slot. */
  readonly data: SlotData;
  /** Bone the slot is attached to. */
  readonly bone: Bone;
  /** Light color (straight RGBA, 0–1), animatable. */
  readonly color: Color = { r: 1, g: 1, b: 1, a: 1 };
  /** Non-null only for slots with two-color tint. */
  readonly darkColor: DarkColor | null;
  /** Current attachment, or null for none. */
  attachment: Attachment | null = null;
  /** Sequence frame index, -1 = use the sequence's setup index. */
  sequenceIndex = -1;
  /** Deformed vertices for the current vertex attachment; empty = none. */
  deform: number[] = [];
  /** Bookkeeping of {@link AnimationState} for attachments no track keyed (spine-core `attachmentState`). */
  attachmentState = 0;

  constructor(data: SlotData, bone: Bone) {
    this.data = data;
    this.bone = bone;
    this.darkColor = data.darkColor ? { ...data.darkColor } : null;
  }

  /** Blend mode from the slot data. */
  get blendMode(): BlendMode {
    return this.data.blendMode;
  }

  /**
   * Set the attachment. Like spine-core, deform is kept only when switching between
   * vertex attachments that share a timeline attachment.
   */
  setAttachment(attachment: Attachment | null): void {
    if (this.attachment === attachment) return;
    const prev = this.attachment;
    // Guarded: assigning `length` goes through V8's slow setter even when it does not change.
    if (this.deform.length !== 0 &&
      (!attachment || !prev || attachment.type !== 'mesh' || prev.type !== 'mesh' || attachment.timelineAttachment !== prev.timelineAttachment)) {
      this.deform.length = 0;
    }
    this.attachment = attachment;
    this.sequenceIndex = -1;
  }
}

// ============================================================================
// Skeleton
// ============================================================================

/** A posable skeleton instance: bones, slots, skin, draw order and constraints. Usually owned by a {@link Clip}. */
export class Skeleton {
  /** Skeleton model (from `.tabula` or the JSON adapter). */
  readonly data: SkeletonData;
  /** Bones in data order (parents before children). */
  readonly bones: Bone[];
  /** Slots in data order (see {@link drawOrder} for drawing order). */
  readonly slots: Slot[];
  /** Path constraints, index-aligned with `data.pathConstraints`. */
  readonly pathConstraints: PathConstraint[];
  /** IK constraints, index-aligned with `data.ikConstraints`. */
  readonly ikConstraints: IkConstraint[];
  /** Transform constraints, index-aligned with `data.transformConstraints`. */
  readonly transformConstraints: TransformConstraint[];
  /** Physics constraints (Spine 4.2), index-aligned with `data.physicsConstraints`. */
  readonly physicsConstraints: PhysicsConstraint[];
  /** Physics clock in seconds, advanced by {@link update}. */
  time = 0;
  /** Y axis points down (Pixi); flips physics gravity for rotation like spine-core `Skeleton.yDown`. */
  yDown = false;
  /**
   * Follow spine-core 4.1 where it differs from 4.2 (set for Spine 4.1 data:
   * applied-transform recovery, local transform constraint wrapping, IK
   * compress/stretch edge cases, no-rotation inheritance under non-unit
   * skeleton scale). 4.2 data uses 4.2 semantics.
   */
  readonly semantics41: boolean;
  /** Slots in draw order. */
  drawOrder: Slot[];
  /** Active skin (attachments are looked up here, then in the default skin). */
  skin: SkinData | null = null;

  /** Skeleton position X (world units). */
  x = 0;
  /** Skeleton position Y (world units). */
  y = 0;
  /** Skeleton X scale (-1 mirrors). */
  scaleX = 1;
  /** Set to -1 for y-down renderers (Pixi): the skeleton is authored y-up. */
  scaleY = 1;

  /** Bones and constraints in update order (spine-core `_updateCache`). */
  private updateOrder: Updatable[] = [];

  constructor(data: SkeletonData) {
    this.data = data;
    this.semantics41 = /^4\.1(\.|-|$)/.test(data.spineVersion ?? '');
    this.bones = [];
    for (const boneData of data.bones) {
      const parent = boneData.parentIndex >= 0 ? this.bones[boneData.parentIndex]! : null;
      this.bones.push(new Bone(boneData, this, parent));
    }
    this.slots = data.slots.map((slotData) => new Slot(slotData, this.bones[slotData.boneIndex]!));
    this.drawOrder = this.slots.slice();
    // Index-aligned with the data arrays (timelines target constraints by index).
    this.pathConstraints = data.pathConstraints.map((c) => new PathConstraint(c, this));
    this.ikConstraints = (data.ikConstraints ?? []).map((c) => new IkConstraint(c, this));
    this.transformConstraints = (data.transformConstraints ?? []).map((c) => new TransformConstraint(c, this));
    this.physicsConstraints = (data.physicsConstraints ?? []).map((c) => new PhysicsConstraint(c, this));
    this.skin = data.defaultSkin ?? data.skins[0] ?? null;
    this.updateCache();
    this.setToSetupPose();
  }

  /** True if the skeleton has physics constraints (stateful: its pose depends on the frame history). */
  get hasPhysics(): boolean {
    return this.physicsConstraints.length > 0;
  }

  /**
   * Build the update order: constraints by `order`, each after the bones it
   * reads, its constrained bones' descendants re-queued after it, then the
   * remaining bones (port of spine-core 4.2 `Skeleton.updateCache`). Skin
   * required bones and constraints are active only when the current skin
   * lists them; {@link setSkin} rebuilds the order.
   */
  updateCache(): void {
    const order: Updatable[] = [];
    const sorted = new Set<Bone>();
    // Skin-required bones are active only when the skin lists them (or a descendant); inactive bones
    // count as sorted so they are never queued (spine-core `bone.sorted = data.skinRequired`).
    for (const bone of this.bones) {
      bone.active = !bone.data.skinRequired;
      if (!bone.active) sorted.add(bone);
    }
    for (const index of this.skin?.bones ?? []) {
      for (let bone: Bone | null = this.bones[index] ?? null; bone; bone = bone.parent) {
        bone.active = true;
        sorted.delete(bone);
      }
    }
    const skinConstraints = new Set(this.skin?.constraints ?? []);
    const constraintActive = (data: { name: string; skinRequired?: boolean }, bone: Bone): boolean =>
      bone.active && (!data.skinRequired || skinConstraints.has(data.name));
    const sortBone = (bone: Bone | null): void => {
      if (!bone || sorted.has(bone)) return;
      sortBone(bone.parent);
      sorted.add(bone);
      order.push(bone);
    };
    const sortReset = (bones: readonly Bone[]): void => {
      for (const bone of bones) {
        if (!bone.active) continue;
        if (sorted.has(bone)) sortReset(bone.children);
        sorted.delete(bone);
      }
    };
    const sortPathAttachment = (attachment: Attachment | null | undefined, slotBone: Bone): void => {
      if (!attachment || attachment.type !== 'path') return;
      const pathBones = attachment.bones;
      if (!pathBones) {
        sortBone(slotBone);
        return;
      }
      for (let i = 0; i < pathBones.length; ) {
        const n = pathBones[i++]! + i;
        while (i < n) sortBone(this.bones[pathBones[i++]!]!);
      }
    };
    const entries: { order: number; sort: () => void }[] = [];
    for (const c of this.ikConstraints) {
      entries.push({ order: c.data.order, sort: () => {
        c.active = constraintActive(c.data, c.target);
        if (!c.active) return;
        sortBone(c.target);
        const parent = c.bones[0]!;
        sortBone(parent);
        if (c.bones.length === 1) {
          order.push(c);
          sortReset(parent.children);
        } else {
          const child = c.bones[c.bones.length - 1]!;
          sortBone(child);
          order.push(c);
          sortReset(parent.children);
          sorted.add(child);
        }
      } });
    }
    for (const c of this.transformConstraints) {
      entries.push({ order: c.data.order, sort: () => {
        c.active = constraintActive(c.data, c.target);
        if (!c.active) return;
        sortBone(c.target);
        for (const bone of c.bones) {
          if (c.data.local) sortBone(bone.parent);
          sortBone(bone);
        }
        order.push(c);
        for (const bone of c.bones) sortReset(bone.children);
        for (const bone of c.bones) sorted.add(bone);
      } });
    }
    for (const c of this.pathConstraints) {
      entries.push({ order: c.data.order, sort: () => {
        const slot = c.target;
        c.active = constraintActive(c.data, slot.bone);
        if (!c.active) return;
        const slotIndex = slot.data.index;
        const skins = new Set([this.skin, this.data.defaultSkin, ...this.data.skins]);
        for (const skin of skins) for (const attachment of skin?.attachments.get(slotIndex)?.values() ?? []) sortPathAttachment(attachment, slot.bone);
        sortPathAttachment(slot.attachment, slot.bone);
        for (const bone of c.bones) sortBone(bone);
        order.push(c);
        for (const bone of c.bones) sortReset(bone.children);
        for (const bone of c.bones) sorted.add(bone);
      } });
    }
    for (const c of this.physicsConstraints) {
      entries.push({ order: c.data.order, sort: () => {
        c.active = constraintActive(c.data, c.bone);
        if (!c.active) return;
        sortBone(c.bone);
        order.push(c);
        sortReset(c.bone.children);
        sorted.add(c.bone);
      } });
    }
    // Stable by order; spine-core visits IK, transform, path, physics for equal orders in that sequence.
    entries.sort((p, q) => p.order - q.order);
    for (const e of entries) e.sort();
    for (const bone of this.bones) sortBone(bone);
    this.updateOrder = order;
  }

  /** Advance the physics clock (spine-core `Skeleton.update`). */
  update(delta: number): void {
    this.time += delta;
  }

  /** Move physics state by a world-space offset, e.g. when the skeleton is teleported (spine-core `physicsTranslate`). */
  physicsTranslate(x: number, y: number): void {
    for (const c of this.physicsConstraints) c.translate(x, y);
  }

  /** Rotate physics state about (x, y) by `degrees` (spine-core `physicsRotate`). */
  physicsRotate(x: number, y: number, degrees: number): void {
    for (const c of this.physicsConstraints) c.rotate(x, y, degrees);
  }

  /** Reset bones, slots, constraints and draw order to the setup pose. */
  setToSetupPose(): void {
    this.setBonesToSetupPose();
    this.setSlotsToSetupPose();
  }

  /** Reset bone transforms and constraint mixes (not the physics simulation state). */
  setBonesToSetupPose(): void {
    for (const bone of this.bones) bone.setToSetupPose();
    for (const constraint of this.ikConstraints) constraint.setToSetupPose();
    for (const constraint of this.transformConstraints) constraint.setToSetupPose();
    for (const constraint of this.pathConstraints) constraint.setToSetupPose();
    for (const constraint of this.physicsConstraints) constraint.setToSetupPose();
  }

  /**
   * Reset slot colors, attachments and draw order.
   *
   * @param keepDeform Slots (index → non-zero) whose deform the caller rewrites
   * right after (baked playback): left alone instead of cleared, so the array
   * keeps its storage (clearing frees it and the rewrite reallocates).
   * @param colors Reset slot colors too (default). Baked playback passes false:
   * it writes every slot's light and dark color right after.
   */
  setSlotsToSetupPose(keepDeform?: Uint8Array | null, colors = true): void {
    const slots = this.slots;
    const setup = this.setupAttachments();
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const d = slot.data;
      if (colors) {
        slot.color.r = d.color.r;
        slot.color.g = d.color.g;
        slot.color.b = d.color.b;
        slot.color.a = d.color.a;
        if (slot.darkColor && d.darkColor) {
          slot.darkColor.r = d.darkColor.r;
          slot.darkColor.g = d.darkColor.g;
          slot.darkColor.b = d.darkColor.b;
        }
      }
      slot.setAttachment(setup[i]!);
      if (slot.deform.length !== 0 && !keepDeform?.[i]) slot.deform.length = 0;
      slot.sequenceIndex = -1;
      this.drawOrder[i] = slot;
    }
    this.drawOrder.length = slots.length;
  }

  private _setupAttachments: (Attachment | null)[] | null = null;
  private _setupAttachmentsSkin: SkinData | null = null;

  /**
   * Setup-pose attachment per slot for the current skin (skins are immutable once parsed),
   * cached by skin identity so the per-frame setup reset does no name lookups.
   */
  private setupAttachments(): (Attachment | null)[] {
    if (this._setupAttachments && this._setupAttachmentsSkin === this.skin) return this._setupAttachments;
    const slots = this.slots;
    const setup: (Attachment | null)[] = new Array(slots.length);
    for (let i = 0; i < slots.length; i++) {
      const name = slots[i]!.data.attachmentName;
      setup[i] = name ? this.getAttachment(i, name) : null;
    }
    this._setupAttachments = setup;
    this._setupAttachmentsSkin = this.skin;
    return setup;
  }

  /**
   * Change the skin: an exported skin, a {@link defineSkin} name, or several
   * skins to combine (`['10', 'explode']`). Returns false if a name is unknown.
   */
  setSkin(skin: SkinSelector): boolean {
    const resolved = resolveSkin(this.data, skin);
    if (!resolved) return false;
    this.skin = resolved;
    this.setSlotsToSetupPose();
    this.updateCache();
    return true;
  }

  /** Look up an attachment in the current skin, then in the default skin. */
  getAttachment(slotIndex: number, name: string): Attachment | null {
    const fromSkin = this.skin?.attachments.get(slotIndex)?.get(name);
    if (fromSkin) return fromSkin;
    return this.data.defaultSkin?.attachments.get(slotIndex)?.get(name) ?? null;
  }

  /**
   * Compute world transforms: applied transforms reset to the local ones,
   * then bones and constraints in update order. `physics` (default
   * {@link Physics.Pose}: apply the current physics state without stepping)
   * controls physics constraints: Update steps the simulation to
   * {@link time}, Reset restarts it first, None ignores physics.
   */
  updateWorldTransform(physics: Physics = Physics.Pose): void {
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]!;
      bone.ax = bone.x;
      bone.ay = bone.y;
      bone.arotation = bone.rotation;
      bone.ascaleX = bone.scaleX;
      bone.ascaleY = bone.scaleY;
      bone.ashearX = bone.shearX;
      bone.ashearY = bone.shearY;
    }
    const order = this.updateOrder;
    for (let i = 0; i < order.length; i++) order[i]!.update(physics);
  }

  /** IK constraint by name, or null. */
  findIkConstraint(name: string): IkConstraint | null {
    return this.ikConstraints.find((c) => c.data.name === name) ?? null;
  }

  /** Transform constraint by name, or null. */
  findTransformConstraint(name: string): TransformConstraint | null {
    return this.transformConstraints.find((c) => c.data.name === name) ?? null;
  }

  /** Physics constraint by name, or null. */
  findPhysicsConstraint(name: string): PhysicsConstraint | null {
    return this.physicsConstraints.find((c) => c.data.name === name) ?? null;
  }

  /**
   * Bone by name, or null.
   *
   * @example
   * ```ts
   * const bone = clip.skeleton.findBone('coin');
   * if (bone) console.log(bone.worldX, bone.worldY);
   * ```
   */
  findBone(name: string): Bone | null {
    const index = this.data.boneIndex.get(name);
    return index === undefined ? null : this.bones[index] ?? null;
  }

  /** Slot by name, or null. */
  findSlot(name: string): Slot | null {
    const index = this.data.slotIndex.get(name);
    return index === undefined ? null : this.slots[index] ?? null;
  }
}
