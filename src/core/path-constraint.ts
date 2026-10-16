/**
 * Path constraint, ported from spine-core 4.1 `PathConstraint` so that bones
 * following a path match the official runtime.
 */

import { PositionMode, RotateMode, SpacingMode } from './types.js';
import type { PathAttachment, PathConstraintData } from './types.js';
import type { Bone, Skeleton, Slot } from './skeleton.js';
import { computeWorldVertices } from './attachments.js';

const NONE = -1;
const BEFORE = -2;
const AFTER = -3;
const EPSILON = 0.00001;
const PI2 = Math.PI * 2;
/** Below this curve percent the tangent comes from the first control point (spine-core). */
const TANGENT_EPSILON = 0.001;

/**
 * Port of spine-core 4.1 `PathConstraint`: positions and rotates a chain of
 * bones along a path attachment.
 */
export class PathConstraint {
  /** Setup data. */
  readonly data: PathConstraintData;
  /** False for a skin-required constraint the current skin does not include (or whose bones are inactive). */
  active = true;
  /** Constrained bones, positioned along the path in order. */
  readonly bones: Bone[];
  /** Slot whose path attachment is followed. */
  readonly target: Slot;
  /** Position along the path (animatable; units per `data.positionMode`). */
  position = 0;
  /** Spacing between bones (animatable; units per `data.spacingMode`). */
  spacing = 0;
  /** Rotation mix 0–1 (animatable). */
  mixRotate = 0;
  /** Translation X mix 0–1 (animatable). */
  mixX = 0;
  /** Translation Y mix 0–1 (animatable). */
  mixY = 0;

  private spaces: number[] = [];
  private positions: number[] = [];
  private world: number[] = [];
  private curves: number[] = [];
  private lengths: number[] = [];
  private segments: number[] = new Array<number>(10).fill(0);

  constructor(data: PathConstraintData, skeleton: Skeleton) {
    this.data = data;
    this.bones = data.bones.map((i) => skeleton.bones[i]!);
    this.target = skeleton.slots[data.targetSlotIndex]!;
    this.setToSetupPose();
  }

  /** Reset position, spacing and mixes to the setup values. */
  setToSetupPose(): void {
    const d = this.data;
    this.position = d.position;
    this.spacing = d.spacing;
    this.mixRotate = d.mixRotate;
    this.mixX = d.mixX;
    this.mixY = d.mixY;
  }

  /**
   * Apply the constraint to the constrained bones' world transforms.
   * @returns false if nothing was changed (no path attachment or zero mix).
   */
  update(): boolean {
    const attachment = this.target.attachment;
    if (!attachment || attachment.type !== 'path') return false;
    const { mixRotate, mixX, mixY } = this;
    if (mixRotate === 0 && mixX === 0 && mixY === 0) return false;

    const data = this.data;
    const tangents = data.rotateMode === RotateMode.Tangent;
    const scale = data.rotateMode === RotateMode.ChainScale;
    const bones = this.bones;
    const boneCount = bones.length;
    const spacesCount = tangents ? boneCount : boneCount + 1;
    const spaces = this.spaces;
    if (spaces.length !== spacesCount) spaces.length = spacesCount;
    spaces[0] = 0;
    const lengths = this.lengths;
    if (scale && lengths.length !== boneCount) lengths.length = boneCount;
    const spacing = this.spacing;

    switch (data.spacingMode) {
      case SpacingMode.Percent: {
        if (scale) {
          for (let i = 0, n = spacesCount - 1; i < n; i++) {
            const bone = bones[i]!;
            const setupLength = bone.data.length;
            if (setupLength < EPSILON) lengths[i] = 0;
            else {
              const x = setupLength * bone.a;
              const y = setupLength * bone.c;
              lengths[i] = Math.sqrt(x * x + y * y);
            }
          }
        }
        for (let i = 1; i < spacesCount; i++) spaces[i] = spacing;
        break;
      }
      case SpacingMode.Proportional: {
        let sum = 0;
        for (let i = 0, n = spacesCount - 1; i < n; ) {
          const bone = bones[i]!;
          const setupLength = bone.data.length;
          if (setupLength < EPSILON) {
            if (scale) lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            const x = setupLength * bone.a;
            const y = setupLength * bone.c;
            const length = Math.sqrt(x * x + y * y);
            if (scale) lengths[i] = length;
            spaces[++i] = length;
            sum += length;
          }
        }
        if (sum > 0) {
          sum = (spacesCount / sum) * spacing;
          for (let i = 1; i < spacesCount; i++) spaces[i]! *= sum;
        }
        break;
      }
      default: {
        const lengthSpacing = data.spacingMode === SpacingMode.Length;
        for (let i = 0, n = spacesCount - 1; i < n; ) {
          const bone = bones[i]!;
          const setupLength = bone.data.length;
          if (setupLength < EPSILON) {
            if (scale) lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            const x = setupLength * bone.a;
            const y = setupLength * bone.c;
            const length = Math.sqrt(x * x + y * y);
            if (scale) lengths[i] = length;
            spaces[++i] = ((lengthSpacing ? setupLength + spacing : spacing) * length) / setupLength;
          }
        }
      }
    }

    const positions = this.computeWorldPositions(attachment, spacesCount, tangents);
    let boneX = positions[0]!;
    let boneY = positions[1]!;
    let offsetRotation = data.offsetRotation;
    let tip: boolean;
    if (offsetRotation === 0) tip = data.rotateMode === RotateMode.Chain;
    else {
      tip = false;
      const p = this.target.bone;
      offsetRotation *= p.a * p.d - p.b * p.c > 0 ? Math.PI / 180 : -Math.PI / 180;
    }

    for (let i = 0, p = 3; i < boneCount; i++, p += 3) {
      const bone = bones[i]!;
      bone.worldX += (boneX - bone.worldX) * mixX;
      bone.worldY += (boneY - bone.worldY) * mixY;
      const x = positions[p]!;
      const y = positions[p + 1]!;
      const dx = x - boneX;
      const dy = y - boneY;
      if (scale) {
        const length = lengths[i]!;
        if (length !== 0) {
          const s = (Math.sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
          bone.a *= s;
          bone.c *= s;
        }
      }
      boneX = x;
      boneY = y;
      if (mixRotate > 0) {
        const { a, b, c, d } = bone;
        let r: number;
        if (tangents) r = positions[p - 1]!;
        else if (spaces[i + 1] === 0) r = positions[p + 2]!;
        else r = Math.atan2(dy, dx);
        r -= Math.atan2(c, a);
        if (tip) {
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          const length = bone.data.length;
          boneX += (length * (cos * a - sin * c) - dx) * mixRotate;
          boneY += (length * (sin * a + cos * c) - dy) * mixRotate;
        } else {
          r += offsetRotation;
        }
        if (r > Math.PI) r -= PI2;
        else if (r < -Math.PI) r += PI2;
        r *= mixRotate;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
      bone.updateAppliedTransform();
    }
    return true;
  }

  private computeWorldPositions(path: PathAttachment, spacesCount: number, tangents: boolean): number[] {
    const target = this.target;
    let position = this.position;
    const spaces = this.spaces;
    const out = this.positions;
    const outLength = spacesCount * 3 + 2;
    if (out.length !== outLength) out.length = outLength;
    const closed = path.closed;
    let verticesLength = path.worldVerticesLength;
    let curveCount = verticesLength / 6;
    let prevCurve = NONE;
    const world = this.world;

    if (!path.constantSpeed) {
      const lengths = path.lengths;
      curveCount -= closed ? 1 : 2;
      const pathLength = lengths[curveCount]!;
      if (this.data.positionMode === PositionMode.Percent) position *= pathLength;
      const multiplier = this.spacingMultiplier(pathLength, spacesCount);
      if (world.length !== 8) world.length = 8;
      for (let i = 0, o = 0, curve = 0; i < spacesCount; i++, o += 3) {
        const space = spaces[i]! * multiplier;
        position += space;
        let p = position;
        if (closed) {
          p %= pathLength;
          if (p < 0) p += pathLength;
          curve = 0;
        } else if (p < 0) {
          if (prevCurve !== BEFORE) {
            prevCurve = BEFORE;
            computeWorldVertices(path, target, 2, 4, world, 0, 2);
          }
          addBeforePosition(p, world, 0, out, o);
          continue;
        } else if (p > pathLength) {
          if (prevCurve !== AFTER) {
            prevCurve = AFTER;
            computeWorldVertices(path, target, verticesLength - 6, 4, world, 0, 2);
          }
          addAfterPosition(p - pathLength, world, 0, out, o);
          continue;
        }
        for (; ; curve++) {
          const length = lengths[curve]!;
          if (p > length) continue;
          if (curve === 0) p /= length;
          else {
            const prev = lengths[curve - 1]!;
            p = (p - prev) / (length - prev);
          }
          break;
        }
        if (curve !== prevCurve) {
          prevCurve = curve;
          if (closed && curve === curveCount) {
            computeWorldVertices(path, target, verticesLength - 4, 4, world, 0, 2);
            computeWorldVertices(path, target, 0, 4, world, 4, 2);
          } else computeWorldVertices(path, target, curve * 6 + 2, 8, world, 0, 2);
        }
        addCurvePosition(p, world[0]!, world[1]!, world[2]!, world[3]!, world[4]!, world[5]!, world[6]!, world[7]!, out, o, tangents || (i > 0 && space === 0));
      }
      return out;
    }

    // Constant speed: measure the curves in world space.
    if (closed) {
      verticesLength += 2;
      if (world.length !== verticesLength) world.length = verticesLength;
      computeWorldVertices(path, target, 2, verticesLength - 4, world, 0, 2);
      computeWorldVertices(path, target, 0, 2, world, verticesLength - 4, 2);
      world[verticesLength - 2] = world[0]!;
      world[verticesLength - 1] = world[1]!;
    } else {
      curveCount--;
      verticesLength -= 4;
      if (world.length !== verticesLength) world.length = verticesLength;
      computeWorldVertices(path, target, 2, verticesLength, world, 0, 2);
    }

    const curves = this.curves;
    if (curves.length !== curveCount) curves.length = curveCount;
    let pathLength = 0;
    let x1 = world[0]!;
    let y1 = world[1]!;
    let cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0, x2 = 0, y2 = 0;
    let tmpx = 0, tmpy = 0, dddfx = 0, dddfy = 0, ddfx = 0, ddfy = 0, dfx = 0, dfy = 0;
    for (let i = 0, w = 2; i < curveCount; i++, w += 6) {
      cx1 = world[w]!;
      cy1 = world[w + 1]!;
      cx2 = world[w + 2]!;
      cy2 = world[w + 3]!;
      x2 = world[w + 4]!;
      y2 = world[w + 5]!;
      tmpx = (x1 - cx1 * 2 + cx2) * 0.1875;
      tmpy = (y1 - cy1 * 2 + cy2) * 0.1875;
      dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375;
      dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375;
      ddfx = tmpx * 2 + dddfx;
      ddfy = tmpy * 2 + dddfy;
      dfx = (cx1 - x1) * 0.75 + tmpx + dddfx * 0.16666667;
      dfy = (cy1 - y1) * 0.75 + tmpy + dddfy * 0.16666667;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      dfx += ddfx;
      dfy += ddfy;
      ddfx += dddfx;
      ddfy += dddfy;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      dfx += ddfx;
      dfy += ddfy;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      dfx += ddfx + dddfx;
      dfy += ddfy + dddfy;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      curves[i] = pathLength;
      x1 = x2;
      y1 = y2;
    }

    if (this.data.positionMode === PositionMode.Percent) position *= pathLength;
    const multiplier = this.spacingMultiplier(pathLength, spacesCount);
    const segments = this.segments;
    let curveLength = 0;
    for (let i = 0, o = 0, curve = 0, segment = 0; i < spacesCount; i++, o += 3) {
      const space = spaces[i]! * multiplier;
      position += space;
      let p = position;
      if (closed) {
        p %= pathLength;
        if (p < 0) p += pathLength;
        curve = 0;
      } else if (p < 0) {
        addBeforePosition(p, world, 0, out, o);
        continue;
      } else if (p > pathLength) {
        addAfterPosition(p - pathLength, world, verticesLength - 4, out, o);
        continue;
      }
      for (; ; curve++) {
        const length = curves[curve]!;
        if (p > length) continue;
        if (curve === 0) p /= length;
        else {
          const prev = curves[curve - 1]!;
          p = (p - prev) / (length - prev);
        }
        break;
      }
      if (curve !== prevCurve) {
        prevCurve = curve;
        let ii = curve * 6;
        x1 = world[ii]!;
        y1 = world[ii + 1]!;
        cx1 = world[ii + 2]!;
        cy1 = world[ii + 3]!;
        cx2 = world[ii + 4]!;
        cy2 = world[ii + 5]!;
        x2 = world[ii + 6]!;
        y2 = world[ii + 7]!;
        tmpx = (x1 - cx1 * 2 + cx2) * 0.03;
        tmpy = (y1 - cy1 * 2 + cy2) * 0.03;
        dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006;
        dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006;
        ddfx = tmpx * 2 + dddfx;
        ddfy = tmpy * 2 + dddfy;
        dfx = (cx1 - x1) * 0.3 + tmpx + dddfx * 0.16666667;
        dfy = (cy1 - y1) * 0.3 + tmpy + dddfy * 0.16666667;
        curveLength = Math.sqrt(dfx * dfx + dfy * dfy);
        segments[0] = curveLength;
        for (ii = 1; ii < 8; ii++) {
          dfx += ddfx;
          dfy += ddfy;
          ddfx += dddfx;
          ddfy += dddfy;
          curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
          segments[ii] = curveLength;
        }
        dfx += ddfx;
        dfy += ddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[8] = curveLength;
        dfx += ddfx + dddfx;
        dfy += ddfy + dddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[9] = curveLength;
        segment = 0;
      }
      p *= curveLength;
      for (; ; segment++) {
        const length = segments[segment]!;
        if (p > length) continue;
        if (segment === 0) p /= length;
        else {
          const prev = segments[segment - 1]!;
          p = segment + (p - prev) / (length - prev);
        }
        break;
      }
      addCurvePosition(p * 0.1, x1, y1, cx1, cy1, cx2, cy2, x2, y2, out, o, tangents || (i > 0 && space === 0));
    }
    return out;
  }

  private spacingMultiplier(pathLength: number, spacesCount: number): number {
    switch (this.data.spacingMode) {
      case SpacingMode.Percent:
        return pathLength;
      case SpacingMode.Proportional:
        return pathLength / spacesCount;
      default:
        return 1;
    }
  }
}

function addBeforePosition(p: number, temp: number[], i: number, out: number[], o: number): void {
  const x1 = temp[i]!;
  const y1 = temp[i + 1]!;
  const r = Math.atan2(temp[i + 3]! - y1, temp[i + 2]! - x1);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function addAfterPosition(p: number, temp: number[], i: number, out: number[], o: number): void {
  const x1 = temp[i + 2]!;
  const y1 = temp[i + 3]!;
  const r = Math.atan2(y1 - temp[i + 1]!, x1 - temp[i]!);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function addCurvePosition(
  p: number, x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number, x2: number, y2: number,
  out: number[], o: number, tangents: boolean,
): void {
  if (p === 0 || Number.isNaN(p)) {
    out[o] = x1;
    out[o + 1] = y1;
    out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    return;
  }
  const tt = p * p;
  const ttt = tt * p;
  const u = 1 - p;
  const uu = u * u;
  const uuu = uu * u;
  const ut = u * p;
  const ut3 = ut * 3;
  const uut3 = u * ut3;
  const utt3 = ut3 * p;
  const x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt;
  const y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
  out[o] = x;
  out[o + 1] = y;
  if (tangents) {
    if (p < TANGENT_EPSILON) out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    else out[o + 2] = Math.atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt), x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
  }
}
