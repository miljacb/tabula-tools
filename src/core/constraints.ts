/**
 * IK, transform and physics constraints, ported from spine-core 4.2
 * (`IkConstraint`, `TransformConstraint`, `PhysicsConstraint`) so posed
 * skeletons match the official runtime numerically. Instances live on a
 * {@link Skeleton}; {@link Skeleton.updateWorldTransform} runs them in Spine's
 * update order. Timelines change the mutable fields (mix, softness, ...);
 * `setToSetupPose` restores them from the data.
 */

import { Inherit } from './types.js';
import type { IkConstraintData, PhysicsConstraintData, TransformConstraintData } from './types.js';
import type { Bone, Skeleton } from './skeleton.js';
import { DEG_TO_RAD, RAD_TO_DEG } from './math.js';

const PI = Math.PI;
const PI2 = Math.PI * 2;
const INV_PI2 = 1 / PI2;

/**
 * How {@link Skeleton.updateWorldTransform} treats physics constraints
 * (spine-core `Physics`).
 */
export enum Physics {
  /** Physics is not applied. */
  None = 0,
  /** Physics state is reset to the current pose, then updated. */
  Reset = 1,
  /** Physics is stepped up to `skeleton.time` and applied. */
  Update = 2,
  /** The current physics state is applied without stepping. */
  Pose = 3,
}

// ============================================================================
// IK
// ============================================================================

/** Rotates 1 or 2 bones so the tip reaches a target bone (spine-core 4.2 `IkConstraint`). */
export class IkConstraint {
  /** Setup data. */
  readonly data: IkConstraintData;
  /** False for a skin-required constraint the current skin does not include (or whose bones are inactive). */
  active = true;
  /** Constrained bones (1 or 2: parent, then child). */
  readonly bones: Bone[];
  /** Bone the chain reaches for. */
  readonly target: Bone;
  /** Bend direction of 2-bone IK: 1 or -1 (animatable). */
  bendDirection = 1;
  /** 1-bone IK: scale the bone down when the target is closer than its length. */
  compress = false;
  /** Scale the bone(s) up when the target is out of reach. */
  stretch = false;
  /** Constraint strength 0–1 (animatable). */
  mix = 1;
  /** 2-bone IK: distance before full extension where the chain starts to slow down (animatable). */
  softness = 0;

  constructor(data: IkConstraintData, skeleton: Skeleton) {
    this.data = data;
    this.bones = data.bones.map((i) => skeleton.bones[i]!);
    this.target = skeleton.bones[data.target]!;
    this.setToSetupPose();
  }

  /** Restore mix, softness, bend direction, compress and stretch from the data. */
  setToSetupPose(): void {
    const d = this.data;
    this.mix = d.mix;
    this.softness = d.softness;
    this.bendDirection = d.bendDirection;
    this.compress = d.compress;
    this.stretch = d.stretch;
  }

  /** Apply to the constrained bones' applied and world transforms. */
  update(): void {
    if (this.mix === 0) return;
    const { target, bones } = this;
    if (bones.length === 1) {
      IkConstraint.apply1(bones[0]!, target.worldX, target.worldY, this.compress, this.stretch, this.data.uniform, this.mix);
    } else if (bones.length === 2) {
      IkConstraint.apply2(bones[0]!, bones[1]!, target.worldX, target.worldY, this.bendDirection, this.stretch, this.data.uniform, this.softness, this.mix);
    }
  }

  /** One-bone IK toward a world-space target. */
  static apply1(bone: Bone, targetX: number, targetY: number, compress: boolean, stretch: boolean, uniform: boolean, alpha: number): void {
    const p = bone.parent;
    if (!p) throw new Error('IK bone must have a parent');
    const pa = p.a;
    let pb = p.b;
    const pc = p.c;
    let pd = p.d;
    const skeleton = bone.skeleton;
    let rotationIK = -bone.ashearX - bone.arotation;
    let tx = 0, ty = 0;
    switch (bone.inherit) {
      case Inherit.OnlyTranslation:
        tx = (targetX - bone.worldX) * Math.sign(skeleton.scaleX);
        ty = (targetY - bone.worldY) * Math.sign(skeleton.scaleY);
        break;
      // @ts-expect-error intentional fallthrough, as in spine-core
      case Inherit.NoRotationOrReflection: {
        const s = Math.abs(pa * pd - pb * pc) / Math.max(0.0001, pa * pa + pc * pc);
        const sa = pa / skeleton.scaleX;
        const sc = pc / skeleton.scaleY;
        pb = -sc * s * skeleton.scaleX;
        pd = sa * s * skeleton.scaleY;
        rotationIK += Math.atan2(sc, sa) * RAD_TO_DEG;
      }
      // falls through
      default: {
        const x = targetX - p.worldX, y = targetY - p.worldY;
        const d = pa * pd - pb * pc;
        if (Math.abs(d) <= 0.0001) {
          tx = 0;
          ty = 0;
        } else {
          tx = (x * pd - y * pb) / d - bone.ax;
          ty = (y * pa - x * pc) / d - bone.ay;
        }
      }
    }
    rotationIK += Math.atan2(ty, tx) * RAD_TO_DEG;
    if (bone.ascaleX < 0) rotationIK += 180;
    if (rotationIK > 180) rotationIK -= 360;
    else if (rotationIK < -180) rotationIK += 360;
    let sx = bone.ascaleX, sy = bone.ascaleY;
    if (compress || stretch) {
      if (bone.inherit === Inherit.NoScale || bone.inherit === Inherit.NoScaleOrReflection) {
        tx = targetX - bone.worldX;
        ty = targetY - bone.worldY;
      }
      const b = bone.data.length * sx;
      if (skeleton.semantics41) {
        // spine-core 4.1 operator precedence: the length guard only applies to stretch.
        const dd = Math.sqrt(tx * tx + ty * ty);
        if ((compress && dd < b) || (stretch && dd > b && b > 0.0001)) {
          const s = (dd / b - 1) * alpha + 1;
          sx *= s;
          if (uniform) sy *= s;
        }
      } else if (b > 0.0001) {
        const dd = tx * tx + ty * ty;
        if ((compress && dd < b * b) || (stretch && dd > b * b)) {
          const s = (Math.sqrt(dd) / b - 1) * alpha + 1;
          sx *= s;
          if (uniform) sy *= s;
        }
      }
    }
    bone.arotation = bone.arotation + rotationIK * alpha;
    bone.ascaleX = sx;
    bone.ascaleY = sy;
    bone.update();
  }

  /** Two-bone IK; `child` must be a direct child of `parent`. Both bones must use normal inheritance. */
  static apply2(parent: Bone, child: Bone, targetX: number, targetY: number, bendDir: number, stretch: boolean, uniform: boolean, softness: number, alpha: number): void {
    // 4.2 skips non-normal inheritance; 4.1 applies regardless.
    if (!parent.skeleton.semantics41 && (parent.inherit !== Inherit.Normal || child.inherit !== Inherit.Normal)) return;
    const px = parent.ax, py = parent.ay;
    let psx = parent.ascaleX, psy = parent.ascaleY, sx = psx, sy = psy, csx = child.ascaleX;
    let os1: number, os2: number, s2: number;
    if (psx < 0) {
      psx = -psx;
      os1 = 180;
      s2 = -1;
    } else {
      os1 = 0;
      s2 = 1;
    }
    if (psy < 0) {
      psy = -psy;
      s2 = -s2;
    }
    if (csx < 0) {
      csx = -csx;
      os2 = 180;
    } else os2 = 0;
    const cx = child.ax;
    let cy: number, cwx: number, cwy: number;
    let a = parent.a, b = parent.b, c = parent.c, d = parent.d;
    const u = Math.abs(psx - psy) <= 0.0001;
    if (!u || stretch) {
      cy = 0;
      cwx = a * cx + parent.worldX;
      cwy = c * cx + parent.worldY;
    } else {
      cy = child.ay;
      cwx = a * cx + b * cy + parent.worldX;
      cwy = c * cx + d * cy + parent.worldY;
    }
    const pp = parent.parent;
    if (!pp) throw new Error('IK parent must itself have a parent');
    a = pp.a;
    b = pp.b;
    c = pp.c;
    d = pp.d;
    let id = a * d - b * c, x = cwx - pp.worldX, y = cwy - pp.worldY;
    id = Math.abs(id) <= 0.0001 ? 0 : 1 / id;
    const dx = (x * d - y * b) * id - px, dy = (y * a - x * c) * id - py;
    const l1 = Math.sqrt(dx * dx + dy * dy);
    let l2 = child.data.length * csx, a1: number, a2: number;
    if (l1 < 0.0001) {
      IkConstraint.apply1(parent, targetX, targetY, false, stretch, false, alpha);
      child.ax = cx;
      child.ay = cy;
      child.arotation = 0;
      child.update();
      return;
    }
    x = targetX - pp.worldX;
    y = targetY - pp.worldY;
    let tx = (x * d - y * b) * id - px, ty = (y * a - x * c) * id - py;
    let dd = tx * tx + ty * ty;
    if (softness !== 0) {
      softness *= (psx * (csx + 1)) * 0.5;
      const td = Math.sqrt(dd), sd = td - l1 - l2 * psx + softness;
      if (sd > 0) {
        let p = Math.min(1, sd / (softness * 2)) - 1;
        p = (sd - softness * (1 - p * p)) / td;
        tx -= p * tx;
        ty -= p * ty;
        dd = tx * tx + ty * ty;
      }
    }
    outer: if (u) {
      l2 *= psx;
      let cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
      if (cos < -1) {
        cos = -1;
        a2 = PI * bendDir;
      } else if (cos > 1) {
        cos = 1;
        a2 = 0;
        if (stretch) {
          a = (Math.sqrt(dd) / (l1 + l2) - 1) * alpha + 1;
          sx *= a;
          if (uniform) sy *= a;
        }
      } else a2 = Math.acos(cos) * bendDir;
      a = l1 + l2 * cos;
      b = l2 * Math.sin(a2);
      a1 = Math.atan2(ty * a - tx * b, tx * a + ty * b);
    } else {
      a = psx * l2;
      b = psy * l2;
      const aa = a * a, bb = b * b, ta = Math.atan2(ty, tx);
      c = bb * l1 * l1 + aa * dd - aa * bb;
      const c1 = -2 * bb * l1, c2 = bb - aa;
      d = c1 * c1 - 4 * c2 * c;
      if (d >= 0) {
        let q = Math.sqrt(d);
        if (c1 < 0) q = -q;
        q = -(c1 + q) * 0.5;
        let r0 = q / c2;
        const r1 = c / q;
        const r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
        r0 = dd - r * r;
        if (r0 >= 0) {
          y = Math.sqrt(r0) * bendDir;
          a1 = ta - Math.atan2(y, r);
          a2 = Math.atan2(y / psy, (r - l1) / psx);
          break outer;
        }
      }
      let minAngle = PI, minX = l1 - a, minDist = minX * minX, minY = 0;
      let maxAngle = 0, maxX = l1 + a, maxDist = maxX * maxX, maxY = 0;
      c = (-a * l1) / (aa - bb);
      if (c >= -1 && c <= 1) {
        c = Math.acos(c);
        x = a * Math.cos(c) + l1;
        y = b * Math.sin(c);
        d = x * x + y * y;
        if (d < minDist) {
          minAngle = c;
          minDist = d;
          minX = x;
          minY = y;
        }
        if (d > maxDist) {
          maxAngle = c;
          maxDist = d;
          maxX = x;
          maxY = y;
        }
      }
      if (dd <= (minDist + maxDist) * 0.5) {
        a1 = ta - Math.atan2(minY * bendDir, minX);
        a2 = minAngle * bendDir;
      } else {
        a1 = ta - Math.atan2(maxY * bendDir, maxX);
        a2 = maxAngle * bendDir;
      }
    }
    const os = Math.atan2(cy, cx) * s2;
    let rotation = parent.arotation;
    a1 = (a1 - os) * RAD_TO_DEG + os1 - rotation;
    if (a1 > 180) a1 -= 360;
    else if (a1 < -180) a1 += 360;
    parent.ax = px;
    parent.ay = py;
    parent.arotation = rotation + a1 * alpha;
    parent.ascaleX = sx;
    parent.ascaleY = sy;
    parent.ashearX = 0;
    parent.ashearY = 0;
    parent.update();
    rotation = child.arotation;
    a2 = ((a2 + os) * RAD_TO_DEG - child.ashearX) * s2 + os2 - rotation;
    if (a2 > 180) a2 -= 360;
    else if (a2 < -180) a2 += 360;
    child.ax = cx;
    child.ay = cy;
    child.arotation = rotation + a2 * alpha;
    child.update();
  }
}

// ============================================================================
// Transform
// ============================================================================

/** Moves constrained bones toward a target bone's transform (spine-core 4.2 `TransformConstraint`). */
export class TransformConstraint {
  /** Setup data. */
  readonly data: TransformConstraintData;
  /** False for a skin-required constraint the current skin does not include (or whose bones are inactive). */
  active = true;
  /** Constrained bones. */
  readonly bones: Bone[];
  /** Bone whose transform is copied. */
  readonly target: Bone;
  /** Rotation mix 0–1 (animatable). */
  mixRotate = 0;
  /** Translation X mix 0–1 (animatable). */
  mixX = 0;
  /** Translation Y mix 0–1 (animatable). */
  mixY = 0;
  /** Scale X mix 0–1 (animatable). */
  mixScaleX = 0;
  /** Scale Y mix 0–1 (animatable). */
  mixScaleY = 0;
  /** Shear Y mix 0–1 (animatable). */
  mixShearY = 0;

  private readonly semantics41: boolean;

  constructor(data: TransformConstraintData, skeleton: Skeleton) {
    this.data = data;
    this.semantics41 = skeleton.semantics41;
    this.bones = data.bones.map((i) => skeleton.bones[i]!);
    this.target = skeleton.bones[data.target]!;
    this.setToSetupPose();
  }

  /** Restore the six mix channels from the data. */
  setToSetupPose(): void {
    const d = this.data;
    this.mixRotate = d.mixRotate;
    this.mixX = d.mixX;
    this.mixY = d.mixY;
    this.mixScaleX = d.mixScaleX;
    this.mixScaleY = d.mixScaleY;
    this.mixShearY = d.mixShearY;
  }

  /** Apply in the configured space (world/local) and mode (absolute/relative). */
  update(): void {
    if (this.mixRotate === 0 && this.mixX === 0 && this.mixY === 0 && this.mixScaleX === 0 && this.mixScaleY === 0 && this.mixShearY === 0) return;
    if (this.data.local) {
      if (this.data.relative) this.applyRelativeLocal();
      else this.applyAbsoluteLocal();
    } else if (this.data.relative) this.applyRelativeWorld();
    else this.applyAbsoluteWorld();
  }

  private applyAbsoluteWorld(): void {
    const { mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY, target, data } = this;
    const translate = mixX !== 0 || mixY !== 0;
    const ta = target.a, tb = target.b, tc = target.c, td = target.d;
    const degRadReflect = ta * td - tb * tc > 0 ? DEG_TO_RAD : -DEG_TO_RAD;
    const offsetRotation = data.offsetRotation * degRadReflect;
    const offsetShearY = data.offsetShearY * degRadReflect;
    for (const bone of this.bones) {
      if (mixRotate !== 0) {
        const a = bone.a, b = bone.b, c = bone.c, d = bone.d;
        let r = Math.atan2(tc, ta) - Math.atan2(c, a) + offsetRotation;
        if (r > PI) r -= PI2;
        else if (r < -PI) r += PI2;
        r *= mixRotate;
        const cos = Math.cos(r), sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
      if (translate) {
        const x = data.offsetX * ta + data.offsetY * tb + target.worldX;
        const y = data.offsetX * tc + data.offsetY * td + target.worldY;
        bone.worldX += (x - bone.worldX) * mixX;
        bone.worldY += (y - bone.worldY) * mixY;
      }
      if (mixScaleX !== 0) {
        let s = Math.sqrt(bone.a * bone.a + bone.c * bone.c);
        if (s !== 0) s = (s + (Math.sqrt(ta * ta + tc * tc) - s + data.offsetScaleX) * mixScaleX) / s;
        bone.a *= s;
        bone.c *= s;
      }
      if (mixScaleY !== 0) {
        let s = Math.sqrt(bone.b * bone.b + bone.d * bone.d);
        if (s !== 0) s = (s + (Math.sqrt(tb * tb + td * td) - s + data.offsetScaleY) * mixScaleY) / s;
        bone.b *= s;
        bone.d *= s;
      }
      if (mixShearY > 0) {
        const b = bone.b, d = bone.d;
        const by = Math.atan2(d, b);
        let r = Math.atan2(td, tb) - Math.atan2(tc, ta) - (by - Math.atan2(bone.c, bone.a));
        if (r > PI) r -= PI2;
        else if (r < -PI) r += PI2;
        r = by + (r + offsetShearY) * mixShearY;
        const s = Math.sqrt(b * b + d * d);
        bone.b = Math.cos(r) * s;
        bone.d = Math.sin(r) * s;
      }
      bone.updateAppliedTransform();
    }
  }

  private applyRelativeWorld(): void {
    const { mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY, target, data } = this;
    const translate = mixX !== 0 || mixY !== 0;
    const ta = target.a, tb = target.b, tc = target.c, td = target.d;
    const degRadReflect = ta * td - tb * tc > 0 ? DEG_TO_RAD : -DEG_TO_RAD;
    const offsetRotation = data.offsetRotation * degRadReflect, offsetShearY = data.offsetShearY * degRadReflect;
    for (const bone of this.bones) {
      if (mixRotate !== 0) {
        const a = bone.a, b = bone.b, c = bone.c, d = bone.d;
        let r = Math.atan2(tc, ta) + offsetRotation;
        if (r > PI) r -= PI2;
        else if (r < -PI) r += PI2;
        r *= mixRotate;
        const cos = Math.cos(r), sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
      if (translate) {
        const x = data.offsetX * ta + data.offsetY * tb + target.worldX;
        const y = data.offsetX * tc + data.offsetY * td + target.worldY;
        bone.worldX += x * mixX;
        bone.worldY += y * mixY;
      }
      if (mixScaleX !== 0) {
        const s = (Math.sqrt(ta * ta + tc * tc) - 1 + data.offsetScaleX) * mixScaleX + 1;
        bone.a *= s;
        bone.c *= s;
      }
      if (mixScaleY !== 0) {
        const s = (Math.sqrt(tb * tb + td * td) - 1 + data.offsetScaleY) * mixScaleY + 1;
        bone.b *= s;
        bone.d *= s;
      }
      if (mixShearY > 0) {
        let r = Math.atan2(td, tb) - Math.atan2(tc, ta);
        if (r > PI) r -= PI2;
        else if (r < -PI) r += PI2;
        const b = bone.b, d = bone.d;
        r = Math.atan2(d, b) + (r - PI / 2 + offsetShearY) * mixShearY;
        const s = Math.sqrt(b * b + d * d);
        bone.b = Math.cos(r) * s;
        bone.d = Math.sin(r) * s;
      }
      bone.updateAppliedTransform();
    }
  }

  private applyAbsoluteLocal(): void {
    const { mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY, target, data } = this;
    const wrap = this.semantics41; // 4.1 takes the shortest way round for rotation and shear
    for (const bone of this.bones) {
      let rotation = bone.arotation;
      if (mixRotate !== 0) {
        let r = target.arotation - rotation + data.offsetRotation;
        if (wrap) r -= (16384 - ((16384.499999999996 - r / 360) | 0)) * 360;
        rotation += r * mixRotate;
      }
      let x = bone.ax, y = bone.ay;
      x += (target.ax - x + data.offsetX) * mixX;
      y += (target.ay - y + data.offsetY) * mixY;
      let scaleX = bone.ascaleX, scaleY = bone.ascaleY;
      // Matches spine-core 4.2 exactly, including dividing by the bone's own scale.
      if (mixScaleX !== 0 && scaleX !== 0) scaleX = (scaleX + (target.ascaleX - scaleX + data.offsetScaleX) * mixScaleX) / scaleX;
      if (mixScaleY !== 0 && scaleY !== 0) scaleY = (scaleY + (target.ascaleY - scaleY + data.offsetScaleY) * mixScaleY) / scaleY;
      let shearY = bone.ashearY;
      if (mixShearY !== 0) {
        let r = target.ashearY - shearY + data.offsetShearY;
        if (wrap) r -= (16384 - ((16384.499999999996 - r / 360) | 0)) * 360;
        shearY += r * mixShearY;
      }
      bone.ax = x;
      bone.ay = y;
      bone.arotation = rotation;
      bone.ascaleX = scaleX;
      bone.ascaleY = scaleY;
      bone.ashearY = shearY;
      bone.update();
    }
  }

  private applyRelativeLocal(): void {
    const { mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY, target, data } = this;
    for (const bone of this.bones) {
      const rotation = bone.arotation + (target.arotation + data.offsetRotation) * mixRotate;
      const x = bone.ax + (target.ax + data.offsetX) * mixX;
      const y = bone.ay + (target.ay + data.offsetY) * mixY;
      const scaleX = bone.ascaleX * ((target.ascaleX - 1 + data.offsetScaleX) * mixScaleX + 1);
      const scaleY = bone.ascaleY * ((target.ascaleY - 1 + data.offsetScaleY) * mixScaleY + 1);
      const shearY = bone.ashearY + (target.ashearY + data.offsetShearY) * mixShearY;
      bone.ax = x;
      bone.ay = y;
      bone.arotation = rotation;
      bone.ascaleX = scaleX;
      bone.ascaleY = scaleY;
      bone.ashearY = shearY;
      bone.update();
    }
  }
}

// ============================================================================
// Physics
// ============================================================================

/**
 * Spring simulation that moves, rotates, scales or shears one bone in reaction
 * to its motion (spine-core 4.2 `PhysicsConstraint`), stepped at a fixed rate
 * (`data.step`) with an accumulator, so results are frame-rate independent.
 */
export class PhysicsConstraint {
  /** Setup data. */
  readonly data: PhysicsConstraintData;
  /** False for a skin-required constraint the current skin does not include (or whose bones are inactive). */
  active = true;
  /** Simulated bone. */
  readonly bone: Bone;
  /** Owning skeleton (its `time` drives the simulation). */
  readonly skeleton: Skeleton;
  /** How much bone movement feeds the spring, 0–1 (animatable). */
  inertia = 0;
  /** Spring stiffness (animatable). */
  strength = 0;
  /** Velocity kept per 1/60 s, 0–1 (animatable). */
  damping = 0;
  /** 1 / mass (animatable via mass keys). */
  massInverse = 0;
  /** Constant force along X, in reference-scale units (animatable). */
  wind = 0;
  /** Constant force along -Y, in reference-scale units (animatable). */
  gravity = 0;
  /** Strength of the simulated offsets, 0–1 (animatable). */
  mix = 0;

  private needsReset = true;
  private ux = 0;
  private uy = 0;
  private cx = 0;
  private cy = 0;
  private tx = 0;
  private ty = 0;
  /** Simulated X offset (state). */
  xOffset = 0;
  /** Simulated X velocity (state). */
  xVelocity = 0;
  /** Simulated Y offset (state). */
  yOffset = 0;
  /** Simulated Y velocity (state). */
  yVelocity = 0;
  /** Simulated rotation offset in radians (state). */
  rotateOffset = 0;
  /** Simulated rotation velocity (state). */
  rotateVelocity = 0;
  /** Simulated X scale offset (state). */
  scaleOffset = 0;
  /** Simulated X scale velocity (state). */
  scaleVelocity = 0;
  /** Unsimulated time carried to the next update, seconds. */
  remaining = 0;
  /** `skeleton.time` at the last update. */
  lastTime = 0;

  constructor(data: PhysicsConstraintData, skeleton: Skeleton) {
    this.data = data;
    this.skeleton = skeleton;
    this.bone = skeleton.bones[data.bone]!;
    this.setToSetupPose();
  }

  /** Discard the simulation state; the next update starts from the current pose. */
  reset(): void {
    this.remaining = 0;
    this.lastTime = this.skeleton.time;
    this.needsReset = true;
    this.xOffset = 0;
    this.xVelocity = 0;
    this.yOffset = 0;
    this.yVelocity = 0;
    this.rotateOffset = 0;
    this.rotateVelocity = 0;
    this.scaleOffset = 0;
    this.scaleVelocity = 0;
  }

  /** Restore inertia, strength, damping, mass, wind, gravity and mix from the data (not the simulation state). */
  setToSetupPose(): void {
    const d = this.data;
    this.inertia = d.inertia;
    this.strength = d.strength;
    this.damping = d.damping;
    this.massInverse = d.massInverse;
    this.wind = d.wind;
    this.gravity = d.gravity;
    this.mix = d.mix;
  }

  /** Step (per `physics`) and apply to the bone's world transform. */
  update(physics: Physics): void {
    const mix = this.mix;
    if (mix === 0) return;
    const data = this.data;
    const x = data.x > 0, y = data.y > 0, rotateOrShearX = data.rotate > 0 || data.shearX > 0, scaleX = data.scaleX > 0;
    const bone = this.bone;
    const l = bone.data.length;
    const skeleton = this.skeleton;
    switch (physics) {
      case Physics.None:
        return;
      // @ts-expect-error intentional fallthrough, as in spine-core
      case Physics.Reset:
        this.reset();
      // falls through
      case Physics.Update: {
        const delta = Math.max(skeleton.time - this.lastTime, 0);
        this.remaining += delta;
        this.lastTime = skeleton.time;
        const bx = bone.worldX, by = bone.worldY;
        if (this.needsReset) {
          this.needsReset = false;
          this.ux = bx;
          this.uy = by;
        } else {
          let a = this.remaining, d = -1;
          const i = this.inertia, t = data.step, f = skeleton.data.referenceScale ?? 100;
          let qx = data.limit * delta;
          const qy = qx * Math.abs(skeleton.scaleY);
          qx *= Math.abs(skeleton.scaleX);
          if (x || y) {
            if (x) {
              const u = (this.ux - bx) * i;
              this.xOffset += u > qx ? qx : u < -qx ? -qx : u;
              this.ux = bx;
            }
            if (y) {
              const u = (this.uy - by) * i;
              this.yOffset += u > qy ? qy : u < -qy ? -qy : u;
              this.uy = by;
            }
            if (a >= t) {
              d = Math.pow(this.damping, 60 * t);
              const m = this.massInverse * t, e = this.strength, w = this.wind * f * skeleton.scaleX, g = this.gravity * f * skeleton.scaleY;
              do {
                if (x) {
                  this.xVelocity += (w - this.xOffset * e) * m;
                  this.xOffset += this.xVelocity * t;
                  this.xVelocity *= d;
                }
                if (y) {
                  this.yVelocity -= (g + this.yOffset * e) * m;
                  this.yOffset += this.yVelocity * t;
                  this.yVelocity *= d;
                }
                a -= t;
              } while (a >= t);
            }
            if (x) bone.worldX += this.xOffset * mix * data.x;
            if (y) bone.worldY += this.yOffset * mix * data.y;
          }
          if (rotateOrShearX || scaleX) {
            const ca = Math.atan2(bone.c, bone.a);
            let c = 0, s = 0, mr = 0;
            let dx = this.cx - bone.worldX, dy = this.cy - bone.worldY;
            if (dx > qx) dx = qx;
            else if (dx < -qx) dx = -qx;
            if (dy > qy) dy = qy;
            else if (dy < -qy) dy = -qy;
            if (rotateOrShearX) {
              mr = (data.rotate + data.shearX) * mix;
              let r = Math.atan2(dy + this.ty, dx + this.tx) - ca - this.rotateOffset * mr;
              this.rotateOffset += (r - Math.ceil(r * INV_PI2 - 0.5) * PI2) * i;
              r = this.rotateOffset * mr + ca;
              c = Math.cos(r);
              s = Math.sin(r);
              if (scaleX) {
                r = l * bone.worldScaleX;
                if (r > 0) this.scaleOffset += ((dx * c + dy * s) * i) / r;
              }
            } else {
              c = Math.cos(ca);
              s = Math.sin(ca);
              const r = l * bone.worldScaleX;
              if (r > 0) this.scaleOffset += ((dx * c + dy * s) * i) / r;
            }
            a = this.remaining;
            if (a >= t) {
              if (d === -1) d = Math.pow(this.damping, 60 * t);
              const m = this.massInverse * t, e = this.strength, w = this.wind, g = skeleton.yDown ? -this.gravity : this.gravity, h = l / f;
              for (;;) {
                a -= t;
                if (scaleX) {
                  this.scaleVelocity += (w * c - g * s - this.scaleOffset * e) * m;
                  this.scaleOffset += this.scaleVelocity * t;
                  this.scaleVelocity *= d;
                }
                if (rotateOrShearX) {
                  this.rotateVelocity -= ((w * s + g * c) * h + this.rotateOffset * e) * m;
                  this.rotateOffset += this.rotateVelocity * t;
                  this.rotateVelocity *= d;
                  if (a < t) break;
                  const r = this.rotateOffset * mr + ca;
                  c = Math.cos(r);
                  s = Math.sin(r);
                } else if (a < t) break;
              }
            }
          }
          this.remaining = a;
        }
        this.cx = bone.worldX;
        this.cy = bone.worldY;
        break;
      }
      case Physics.Pose:
        if (x) bone.worldX += this.xOffset * mix * data.x;
        if (y) bone.worldY += this.yOffset * mix * data.y;
    }
    if (rotateOrShearX) {
      let o = this.rotateOffset * mix, s: number, c: number, a: number;
      if (data.shearX > 0) {
        let r = 0;
        if (data.rotate > 0) {
          r = o * data.rotate;
          s = Math.sin(r);
          c = Math.cos(r);
          a = bone.b;
          bone.b = c * a - s * bone.d;
          bone.d = s * a + c * bone.d;
        }
        r += o * data.shearX;
        s = Math.sin(r);
        c = Math.cos(r);
        a = bone.a;
        bone.a = c * a - s * bone.c;
        bone.c = s * a + c * bone.c;
      } else {
        o *= data.rotate;
        s = Math.sin(o);
        c = Math.cos(o);
        a = bone.a;
        bone.a = c * a - s * bone.c;
        bone.c = s * a + c * bone.c;
        a = bone.b;
        bone.b = c * a - s * bone.d;
        bone.d = s * a + c * bone.d;
      }
    }
    if (scaleX) {
      const s = 1 + this.scaleOffset * mix * data.scaleX;
      bone.a *= s;
      bone.c *= s;
    }
    if (physics !== Physics.Pose) {
      this.tx = l * bone.a;
      this.ty = l * bone.c;
    }
    bone.updateAppliedTransform();
  }

  /** Shift the simulation's reference positions (spine-core `translate`). */
  translate(x: number, y: number): void {
    this.ux -= x;
    this.uy -= y;
    this.cx -= x;
    this.cy -= y;
  }

  /** Rotate the simulation's reference positions about (x, y) (spine-core `rotate`). */
  rotate(x: number, y: number, degrees: number): void {
    const r = degrees * DEG_TO_RAD, cos = Math.cos(r), sin = Math.sin(r);
    const dx = this.cx - x, dy = this.cy - y;
    this.translate(dx * cos - dy * sin - dx, dx * sin + dy * cos - dy);
  }
}
