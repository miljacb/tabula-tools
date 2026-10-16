/**
 * Timelines applied with an alpha and a blend mode (port of spine-core 4.1 /
 * 4.2 `Timeline.apply(skeleton, lastTime, time, events, alpha, blend,
 * direction)`), used by {@link AnimationState} for track layering and mixing.
 * The single-animation path (`applyAnimation`) stays the fast special case
 * (alpha 1, setup pose reset first).
 */

import { curvePercent, interpolate, searchFrame } from './curves.js';
import { IK_FLAG_BEND_POSITIVE, IK_FLAG_COMPRESS, IK_FLAG_STRETCH, SequenceMode } from './types.js';
import type {
  AttachmentTimeline, Color, CurveTimeline, DeformTimeline, DrawOrderTimeline, EventKey, EventTimeline, InheritTimeline,
  PhysicsConstraintData, PhysicsResetTimeline, SequenceTimeline, Timeline,
} from './types.js';
import type { Skeleton } from './skeleton.js';
import type { PhysicsConstraint } from './constraints.js';

/** How a timeline's value combines with the current pose (spine-core `MixBlend`). */
export enum MixBlend {
  /** Setup value blended toward the timeline value. */
  setup = 0,
  /** Like replace, but before the first key the setup value is blended in (track 0). */
  first = 1,
  /** Current value blended toward the timeline value. */
  replace = 2,
  /** Timeline value (relative to setup) added to the current value. */
  add = 3,
}

/** Mixing in (the entry being mixed to) or out (spine-core `MixDirection`). */
export enum MixDirection {
  mixIn = 0,
  mixOut = 1,
}

const signum = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Value of channel `channel` at `time` (time >= first key). */
export function curveValue(tl: CurveTimeline, time: number, channel = 0): number {
  const frame = searchFrame(tl.times, time);
  return channelAt(tl, frame, channel, time);
}

function channelAt(tl: CurveTimeline, frame: number, channel: number, time: number): number {
  const { times, values, channels } = tl;
  const v1 = values[frame * channels + channel]!;
  if (frame === times.length - 1) return v1;
  return interpolate(tl.curves[frame]!, channel, times[frame]!, v1, times[frame + 1]!, values[(frame + 1) * channels + channel]!, time);
}

// spine-core Color.set / Color.add clamp; setFromColor does not.
function colorSet(c: Color, r: number, g: number, b: number, a: number): void {
  c.r = clamp01(r);
  c.g = clamp01(g);
  c.b = clamp01(b);
  c.a = clamp01(a);
}
function colorAdd(c: Color, r: number, g: number, b: number, a: number): void {
  colorSet(c, c.r + r, c.g + g, c.b + b, c.a + a);
}
function colorFrom(c: Color, s: Color): void {
  c.r = s.r;
  c.g = s.g;
  c.b = s.b;
  c.a = s.a;
}

function relative(tl: CurveTimeline, time: number, alpha: number, blend: MixBlend, current: number, setup: number, channel = 0): number {
  if (time < tl.times[0]!) {
    if (blend === MixBlend.setup) return setup;
    if (blend === MixBlend.first) return current + (setup - current) * alpha;
    return current;
  }
  let value = curveValue(tl, time, channel);
  if (blend === MixBlend.setup) return setup + value * alpha;
  if (blend === MixBlend.first || blend === MixBlend.replace) value += setup - current;
  return current + value * alpha;
}

function absolute(tl: CurveTimeline, time: number, alpha: number, blend: MixBlend, current: number, setup: number, value?: number): number {
  if (time < tl.times[0]!) {
    if (blend === MixBlend.setup) return setup;
    if (blend === MixBlend.first) return current + (setup - current) * alpha;
    return current;
  }
  const v = value ?? curveValue(tl, time);
  if (blend === MixBlend.setup) return setup + (v - setup) * alpha;
  return current + (v - current) * alpha;
}

function scaleValue(tl: CurveTimeline, time: number, alpha: number, blend: MixBlend, direction: MixDirection, current: number, setup: number, channel = 0): number {
  if (time < tl.times[0]!) {
    if (blend === MixBlend.setup) return setup;
    if (blend === MixBlend.first) return current + (setup - current) * alpha;
    return current;
  }
  const value = curveValue(tl, time, channel) * setup;
  if (alpha === 1) return blend === MixBlend.add ? current + value - setup : value;
  if (direction === MixDirection.mixOut) {
    if (blend === MixBlend.setup) return setup + (Math.abs(value) * signum(setup) - setup) * alpha;
    if (blend === MixBlend.first || blend === MixBlend.replace) return current + (Math.abs(value) * signum(current) - current) * alpha;
  } else {
    if (blend === MixBlend.setup) {
      const s = Math.abs(setup) * signum(value);
      return s + (value - s) * alpha;
    }
    if (blend === MixBlend.first || blend === MixBlend.replace) {
      const s = Math.abs(current) * signum(value);
      return s + (value - s) * alpha;
    }
  }
  return current + (value - setup) * alpha;
}

/**
 * Apply one timeline at `time` with `alpha` and `blend` (spine-core
 * semantics). Event keys in (lastTime, time] are pushed to `events` (when
 * given); physics reset keys crossed reset physics.
 */
export function applyTimeline(
  tl: Timeline, skeleton: Skeleton, lastTime: number, time: number, events: EventKey[] | null,
  alpha: number, blend: MixBlend, direction: MixDirection,
): void {
  switch (tl.kind) {
    case 'attachment':
      return applyAttachmentTimeline(tl, skeleton, time, blend, direction);
    case 'deform':
      return applyDeform(tl, skeleton, time, alpha, blend);
    case 'sequence':
      return applySequence(tl, skeleton, time, blend, direction);
    case 'drawOrder':
      return applyDrawOrder(tl, skeleton, time, blend, direction);
    case 'inherit':
      return applyInherit(tl, skeleton, time, blend, direction);
    case 'event':
      if (events) collectEvents(tl, lastTime, time, events);
      return;
    case 'physicsReset':
      return applyPhysicsReset(tl, skeleton, lastTime, time);
    default:
      return applyCurve(tl, skeleton, time, alpha, blend, direction);
  }
}

function applyAttachmentTimeline(tl: AttachmentTimeline, skeleton: Skeleton, time: number, blend: MixBlend, direction: MixDirection): void {
  const slot = skeleton.slots[tl.target]!;
  if (!slot.bone.active) return;
  if (direction === MixDirection.mixOut) {
    if (blend === MixBlend.setup) setAttachmentByName(skeleton, tl.target, slot.data.attachmentName);
    return;
  }
  if (time < tl.times[0]!) {
    if (blend === MixBlend.setup || blend === MixBlend.first) setAttachmentByName(skeleton, tl.target, slot.data.attachmentName);
    return;
  }
  setAttachmentByName(skeleton, tl.target, tl.names[searchFrame(tl.times, time)]!);
}

/** Set a slot's attachment by name (null / '' = none), resolving it through the skins. */
export function setAttachmentByName(skeleton: Skeleton, slotIndex: number, name: string | null): void {
  skeleton.slots[slotIndex]!.setAttachment(name ? skeleton.getAttachment(slotIndex, name) : null);
}

function applyCurve(tl: CurveTimeline, skeleton: Skeleton, time: number, alpha: number, blend: MixBlend, direction: MixDirection): void {
  switch (tl.kind) {
    case 'rotate': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.rotation = relative(tl, time, alpha, blend, bone.rotation, bone.data.rotation);
      return;
    }
    case 'translatex': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.x = relative(tl, time, alpha, blend, bone.x, bone.data.x);
      return;
    }
    case 'translatey': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.y = relative(tl, time, alpha, blend, bone.y, bone.data.y);
      return;
    }
    case 'shearx': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.shearX = relative(tl, time, alpha, blend, bone.shearX, bone.data.shearX);
      return;
    }
    case 'sheary': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.shearY = relative(tl, time, alpha, blend, bone.shearY, bone.data.shearY);
      return;
    }
    case 'scalex': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.scaleX = scaleValue(tl, time, alpha, blend, direction, bone.scaleX, bone.data.scaleX);
      return;
    }
    case 'scaley': {
      const bone = skeleton.bones[tl.target]!;
      if (bone.active) bone.scaleY = scaleValue(tl, time, alpha, blend, direction, bone.scaleY, bone.data.scaleY);
      return;
    }
    case 'translate':
    case 'shear': {
      const bone = skeleton.bones[tl.target]!;
      if (!bone.active) return;
      const tx = tl.kind === 'translate';
      const sx = tx ? bone.data.x : bone.data.shearX;
      const sy = tx ? bone.data.y : bone.data.shearY;
      let cx = tx ? bone.x : bone.shearX;
      let cy = tx ? bone.y : bone.shearY;
      if (time < tl.times[0]!) {
        if (blend === MixBlend.setup) {
          cx = sx;
          cy = sy;
        } else if (blend === MixBlend.first) {
          cx += (sx - cx) * alpha;
          cy += (sy - cy) * alpha;
        }
      } else {
        const frame = searchFrame(tl.times, time);
        const x = channelAt(tl, frame, 0, time);
        const y = channelAt(tl, frame, 1, time);
        switch (blend) {
          case MixBlend.setup:
            cx = sx + x * alpha;
            cy = sy + y * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            cx += (sx + x - cx) * alpha;
            cy += (sy + y - cy) * alpha;
            break;
          case MixBlend.add:
            cx += x * alpha;
            cy += y * alpha;
        }
      }
      if (tx) {
        bone.x = cx;
        bone.y = cy;
      } else {
        bone.shearX = cx;
        bone.shearY = cy;
      }
      return;
    }
    case 'scale': {
      const bone = skeleton.bones[tl.target]!;
      if (!bone.active) return;
      bone.scaleX = scaleValue(tl, time, alpha, blend, direction, bone.scaleX, bone.data.scaleX, 0);
      bone.scaleY = scaleValue(tl, time, alpha, blend, direction, bone.scaleY, bone.data.scaleY, 1);
      return;
    }
    case 'rgba':
    case 'rgba2': {
      const slot = skeleton.slots[tl.target]!;
      if (!slot.bone.active) return;
      const light = slot.color;
      const dark = tl.kind === 'rgba2' ? slot.darkColor : null;
      const setupDark = slot.data.darkColor;
      if (time < tl.times[0]!) {
        const setup = slot.data.color;
        if (blend === MixBlend.setup) {
          colorFrom(light, setup);
          if (dark && setupDark) {
            dark.r = setupDark.r;
            dark.g = setupDark.g;
            dark.b = setupDark.b;
          }
        } else if (blend === MixBlend.first) {
          colorAdd(light, (setup.r - light.r) * alpha, (setup.g - light.g) * alpha, (setup.b - light.b) * alpha, (setup.a - light.a) * alpha);
          if (dark && setupDark) {
            dark.r += (setupDark.r - dark.r) * alpha;
            dark.g += (setupDark.g - dark.g) * alpha;
            dark.b += (setupDark.b - dark.b) * alpha;
          }
        }
        return;
      }
      const frame = searchFrame(tl.times, time);
      const r = channelAt(tl, frame, 0, time), g = channelAt(tl, frame, 1, time), b = channelAt(tl, frame, 2, time), a = channelAt(tl, frame, 3, time);
      if (alpha === 1) {
        colorSet(light, r, g, b, a);
        if (dark) {
          dark.r = channelAt(tl, frame, 4, time);
          dark.g = channelAt(tl, frame, 5, time);
          dark.b = channelAt(tl, frame, 6, time);
        }
      } else {
        if (blend === MixBlend.setup) {
          colorFrom(light, slot.data.color);
          if (dark && setupDark) {
            dark.r = setupDark.r;
            dark.g = setupDark.g;
            dark.b = setupDark.b;
          }
        }
        colorAdd(light, (r - light.r) * alpha, (g - light.g) * alpha, (b - light.b) * alpha, (a - light.a) * alpha);
        if (dark) {
          dark.r += (channelAt(tl, frame, 4, time) - dark.r) * alpha;
          dark.g += (channelAt(tl, frame, 5, time) - dark.g) * alpha;
          dark.b += (channelAt(tl, frame, 6, time) - dark.b) * alpha;
        }
      }
      return;
    }
    case 'rgb':
    case 'rgb2': {
      const slot = skeleton.slots[tl.target]!;
      if (!slot.bone.active) return;
      const light = slot.color;
      const dark = tl.kind === 'rgb2' ? slot.darkColor : null;
      const setup = slot.data.color;
      const setupDark = slot.data.darkColor;
      if (time < tl.times[0]!) {
        if (blend === MixBlend.setup) {
          light.r = setup.r;
          light.g = setup.g;
          light.b = setup.b;
          if (dark && setupDark) {
            dark.r = setupDark.r;
            dark.g = setupDark.g;
            dark.b = setupDark.b;
          }
        } else if (blend === MixBlend.first) {
          light.r += (setup.r - light.r) * alpha;
          light.g += (setup.g - light.g) * alpha;
          light.b += (setup.b - light.b) * alpha;
          if (dark && setupDark) {
            dark.r += (setupDark.r - dark.r) * alpha;
            dark.g += (setupDark.g - dark.g) * alpha;
            dark.b += (setupDark.b - dark.b) * alpha;
          }
        }
        return;
      }
      const frame = searchFrame(tl.times, time);
      const r = channelAt(tl, frame, 0, time), g = channelAt(tl, frame, 1, time), b = channelAt(tl, frame, 2, time);
      if (alpha === 1) {
        light.r = r;
        light.g = g;
        light.b = b;
        if (dark) {
          dark.r = channelAt(tl, frame, 3, time);
          dark.g = channelAt(tl, frame, 4, time);
          dark.b = channelAt(tl, frame, 5, time);
        }
      } else {
        if (blend === MixBlend.setup) {
          light.r = setup.r;
          light.g = setup.g;
          light.b = setup.b;
          if (dark && setupDark) {
            dark.r = setupDark.r;
            dark.g = setupDark.g;
            dark.b = setupDark.b;
          }
        }
        light.r += (r - light.r) * alpha;
        light.g += (g - light.g) * alpha;
        light.b += (b - light.b) * alpha;
        if (dark) {
          dark.r += (channelAt(tl, frame, 3, time) - dark.r) * alpha;
          dark.g += (channelAt(tl, frame, 4, time) - dark.g) * alpha;
          dark.b += (channelAt(tl, frame, 5, time) - dark.b) * alpha;
        }
      }
      return;
    }
    case 'alpha': {
      const slot = skeleton.slots[tl.target]!;
      if (!slot.bone.active) return;
      const color = slot.color;
      if (time < tl.times[0]!) {
        const setup = slot.data.color;
        if (blend === MixBlend.setup) color.a = setup.a;
        else if (blend === MixBlend.first) color.a += (setup.a - color.a) * alpha;
        return;
      }
      const a = curveValue(tl, time);
      if (alpha === 1) color.a = a;
      else {
        if (blend === MixBlend.setup) color.a = slot.data.color.a;
        color.a += (a - color.a) * alpha;
      }
      return;
    }
    case 'pathPosition': {
      const c = skeleton.pathConstraints[tl.target]!;
      if (c.active) c.position = absolute(tl, time, alpha, blend, c.position, c.data.position);
      return;
    }
    case 'pathSpacing': {
      const c = skeleton.pathConstraints[tl.target]!;
      if (c.active) c.spacing = absolute(tl, time, alpha, blend, c.spacing, c.data.spacing);
      return;
    }
    case 'pathMix': {
      const c = skeleton.pathConstraints[tl.target]!;
      if (!c.active) return;
      const d = c.data;
      if (time < tl.times[0]!) {
        if (blend === MixBlend.setup) {
          c.mixRotate = d.mixRotate;
          c.mixX = d.mixX;
          c.mixY = d.mixY;
        } else if (blend === MixBlend.first) {
          c.mixRotate += (d.mixRotate - c.mixRotate) * alpha;
          c.mixX += (d.mixX - c.mixX) * alpha;
          c.mixY += (d.mixY - c.mixY) * alpha;
        }
        return;
      }
      const frame = searchFrame(tl.times, time);
      const rotate = channelAt(tl, frame, 0, time), x = channelAt(tl, frame, 1, time), y = channelAt(tl, frame, 2, time);
      if (blend === MixBlend.setup) {
        c.mixRotate = d.mixRotate + (rotate - d.mixRotate) * alpha;
        c.mixX = d.mixX + (x - d.mixX) * alpha;
        c.mixY = d.mixY + (y - d.mixY) * alpha;
      } else {
        c.mixRotate += (rotate - c.mixRotate) * alpha;
        c.mixX += (x - c.mixX) * alpha;
        c.mixY += (y - c.mixY) * alpha;
      }
      return;
    }
    case 'ik': {
      const c = skeleton.ikConstraints[tl.target]!;
      if (!c.active) return;
      const d = c.data;
      if (time < tl.times[0]!) {
        if (blend === MixBlend.setup) {
          c.mix = d.mix;
          c.softness = d.softness;
        } else if (blend === MixBlend.first) {
          c.mix += (d.mix - c.mix) * alpha;
          c.softness += (d.softness - c.softness) * alpha;
        } else return;
        c.bendDirection = d.bendDirection;
        c.compress = d.compress;
        c.stretch = d.stretch;
        return;
      }
      const frame = searchFrame(tl.times, time);
      const mix = channelAt(tl, frame, 0, time), softness = channelAt(tl, frame, 1, time);
      const flags = tl.flags?.[frame] ?? IK_FLAG_BEND_POSITIVE;
      const keyed = (): void => {
        c.bendDirection = flags & IK_FLAG_BEND_POSITIVE ? 1 : -1;
        c.compress = (flags & IK_FLAG_COMPRESS) !== 0;
        c.stretch = (flags & IK_FLAG_STRETCH) !== 0;
      };
      if (blend === MixBlend.setup) {
        c.mix = d.mix + (mix - d.mix) * alpha;
        c.softness = d.softness + (softness - d.softness) * alpha;
        if (direction === MixDirection.mixOut) {
          c.bendDirection = d.bendDirection;
          c.compress = d.compress;
          c.stretch = d.stretch;
        } else keyed();
      } else {
        c.mix += (mix - c.mix) * alpha;
        c.softness += (softness - c.softness) * alpha;
        if (direction === MixDirection.mixIn) keyed();
      }
      return;
    }
    case 'transformMix': {
      const c = skeleton.transformConstraints[tl.target]!;
      if (!c.active) return;
      const d = c.data;
      if (time < tl.times[0]!) {
        if (blend === MixBlend.setup) {
          c.mixRotate = d.mixRotate;
          c.mixX = d.mixX;
          c.mixY = d.mixY;
          c.mixScaleX = d.mixScaleX;
          c.mixScaleY = d.mixScaleY;
          c.mixShearY = d.mixShearY;
        } else if (blend === MixBlend.first) {
          c.mixRotate += (d.mixRotate - c.mixRotate) * alpha;
          c.mixX += (d.mixX - c.mixX) * alpha;
          c.mixY += (d.mixY - c.mixY) * alpha;
          c.mixScaleX += (d.mixScaleX - c.mixScaleX) * alpha;
          c.mixScaleY += (d.mixScaleY - c.mixScaleY) * alpha;
          c.mixShearY += (d.mixShearY - c.mixShearY) * alpha;
        }
        return;
      }
      const frame = searchFrame(tl.times, time);
      const v = [0, 1, 2, 3, 4, 5].map((ch) => channelAt(tl, frame, ch, time)) as [number, number, number, number, number, number];
      if (blend === MixBlend.setup) {
        c.mixRotate = d.mixRotate + (v[0] - d.mixRotate) * alpha;
        c.mixX = d.mixX + (v[1] - d.mixX) * alpha;
        c.mixY = d.mixY + (v[2] - d.mixY) * alpha;
        c.mixScaleX = d.mixScaleX + (v[3] - d.mixScaleX) * alpha;
        c.mixScaleY = d.mixScaleY + (v[4] - d.mixScaleY) * alpha;
        c.mixShearY = d.mixShearY + (v[5] - d.mixShearY) * alpha;
      } else {
        c.mixRotate += (v[0] - c.mixRotate) * alpha;
        c.mixX += (v[1] - c.mixX) * alpha;
        c.mixY += (v[2] - c.mixY) * alpha;
        c.mixScaleX += (v[3] - c.mixScaleX) * alpha;
        c.mixScaleY += (v[4] - c.mixScaleY) * alpha;
        c.mixShearY += (v[5] - c.mixShearY) * alpha;
      }
      return;
    }
    default: {
      const p = PHYSICS[tl.kind];
      if (!p) return;
      if (tl.target === -1) {
        const value = time >= tl.times[0]! ? curveValue(tl, time) : 0;
        for (const c of skeleton.physicsConstraints) {
          if (c.active && c.data[p.global]) p.set(c, absolute(tl, time, alpha, blend, p.get(c), p.setup(c), value));
        }
      } else {
        const c = skeleton.physicsConstraints[tl.target]!;
        if (c.active) p.set(c, absolute(tl, time, alpha, blend, p.get(c), p.setup(c)));
      }
    }
  }
}

interface PhysicsProperty {
  get(c: PhysicsConstraint): number;
  set(c: PhysicsConstraint, v: number): void;
  setup(c: PhysicsConstraint): number;
  global: keyof PhysicsConstraintData;
}

const PHYSICS: Partial<Record<string, PhysicsProperty>> = {
  physicsInertia: { get: (c) => c.inertia, set: (c, v) => (c.inertia = v), setup: (c) => c.data.inertia, global: 'inertiaGlobal' },
  physicsStrength: { get: (c) => c.strength, set: (c, v) => (c.strength = v), setup: (c) => c.data.strength, global: 'strengthGlobal' },
  physicsDamping: { get: (c) => c.damping, set: (c, v) => (c.damping = v), setup: (c) => c.data.damping, global: 'dampingGlobal' },
  physicsMass: { get: (c) => 1 / c.massInverse, set: (c, v) => (c.massInverse = 1 / v), setup: (c) => 1 / c.data.massInverse, global: 'massGlobal' },
  physicsWind: { get: (c) => c.wind, set: (c, v) => (c.wind = v), setup: (c) => c.data.wind, global: 'windGlobal' },
  physicsGravity: { get: (c) => c.gravity, set: (c, v) => (c.gravity = v), setup: (c) => c.data.gravity, global: 'gravityGlobal' },
  physicsMix: { get: (c) => c.mix, set: (c, v) => (c.mix = v), setup: (c) => c.data.mix, global: 'mixGlobal' },
};

function applyInherit(tl: InheritTimeline, skeleton: Skeleton, time: number, blend: MixBlend, direction: MixDirection): void {
  const bone = skeleton.bones[tl.target]!;
  if (!bone.active) return;
  if (direction === MixDirection.mixOut) {
    if (blend === MixBlend.setup) bone.inherit = bone.data.inherit;
    return;
  }
  if (time < tl.times[0]!) {
    if (blend === MixBlend.setup || blend === MixBlend.first) bone.inherit = bone.data.inherit;
    return;
  }
  bone.inherit = tl.inherits[searchFrame(tl.times, time)]!;
}

function applyDeform(tl: DeformTimeline, skeleton: Skeleton, time: number, alpha: number, blend: MixBlend): void {
  const slot = skeleton.slots[tl.target]!;
  if (!slot.bone.active) return;
  const attachment = slot.attachment;
  if (!attachment || attachment.type !== 'mesh' || attachment.timelineAttachment !== tl.attachment) return;
  const deform = slot.deform;
  if (deform.length === 0) blend = MixBlend.setup;
  const { times, frames } = tl;
  const vertexCount = frames[0]!.length;
  const weighted = !!attachment.bones;
  const setupVertices = attachment.vertices;
  if (time < times[0]!) {
    if (blend === MixBlend.setup) {
      if (deform.length !== 0) deform.length = 0;
    } else if (blend === MixBlend.first) {
      if (alpha === 1) {
        if (deform.length !== 0) deform.length = 0;
        return;
      }
      fill(deform, vertexCount);
      if (!weighted) for (let i = 0; i < vertexCount; i++) deform[i]! += (setupVertices[i]! - deform[i]!) * alpha;
      else for (let i = 0; i < vertexCount; i++) deform[i]! *= 1 - alpha;
    }
    return;
  }
  fill(deform, vertexCount);
  const last = times.length - 1;
  let prev: Float32Array, next: Float32Array | null = null, percent = 0;
  if (time >= times[last]!) prev = frames[last]!;
  else {
    const frame = searchFrame(times, time);
    percent = curvePercent(tl.curves[frame]!, times[frame]!, times[frame + 1]!, time);
    prev = frames[frame]!;
    next = frames[frame + 1]!;
  }
  const value = (i: number): number => (next ? prev[i]! + (next[i]! - prev[i]!) * percent : prev[i]!);
  if (alpha === 1) {
    if (blend === MixBlend.add) {
      if (!weighted) for (let i = 0; i < vertexCount; i++) deform[i]! += value(i) - setupVertices[i]!;
      else for (let i = 0; i < vertexCount; i++) deform[i]! += value(i);
    } else for (let i = 0; i < vertexCount; i++) deform[i] = value(i);
    return;
  }
  switch (blend) {
    case MixBlend.setup:
      if (!weighted) for (let i = 0; i < vertexCount; i++) deform[i] = setupVertices[i]! + (value(i) - setupVertices[i]!) * alpha;
      else for (let i = 0; i < vertexCount; i++) deform[i] = value(i) * alpha;
      break;
    case MixBlend.first:
    case MixBlend.replace:
      for (let i = 0; i < vertexCount; i++) deform[i]! += (value(i) - deform[i]!) * alpha;
      break;
    case MixBlend.add:
      if (!weighted) for (let i = 0; i < vertexCount; i++) deform[i]! += (value(i) - setupVertices[i]!) * alpha;
      else for (let i = 0; i < vertexCount; i++) deform[i]! += value(i) * alpha;
  }
}

/** spine-core sets `deform.length` (new entries undefined, then written); keep existing values, zero new ones. */
function fill(deform: number[], n: number): void {
  const old = deform.length;
  if (old !== n) deform.length = n;
  for (let i = old; i < n; i++) deform[i] = 0;
}

function applySequence(tl: SequenceTimeline, skeleton: Skeleton, time: number, blend: MixBlend, direction: MixDirection): void {
  const slot = skeleton.slots[tl.target]!;
  if (!slot.bone.active) return;
  const slotAttachment = slot.attachment;
  const attachment = tl.attachment;
  if (slotAttachment !== attachment) {
    if (!slotAttachment || slotAttachment.type !== 'mesh' || slotAttachment.timelineAttachment !== attachment) return;
  }
  if (direction === MixDirection.mixOut) {
    if (blend === MixBlend.setup) slot.sequenceIndex = -1;
    return;
  }
  const { times } = tl;
  if (time < times[0]!) {
    if (blend === MixBlend.setup || blend === MixBlend.first) slot.sequenceIndex = -1;
    return;
  }
  const sequence = attachment.sequence;
  if (!sequence) return;
  const frame = searchFrame(times, time);
  const before = times[frame]!;
  const mode = tl.modes[frame]!;
  const delay = tl.delays[frame]!;
  const count = sequence.count;
  let index = tl.indices[frame]!;
  if (mode !== SequenceMode.Hold) {
    index += ((time - before) / delay + 0.00001) | 0;
    switch (mode) {
      case SequenceMode.Once:
        index = Math.min(count - 1, index);
        break;
      case SequenceMode.Loop:
        index %= count;
        break;
      case SequenceMode.Pingpong: {
        const n = (count << 1) - 2;
        index = n === 0 ? 0 : index % n;
        if (index >= count) index = n - index;
        break;
      }
      case SequenceMode.OnceReverse:
        index = Math.max(count - 1 - index, 0);
        break;
      case SequenceMode.LoopReverse:
        index = count - 1 - (index % count);
        break;
      case SequenceMode.PingpongReverse: {
        const n = (count << 1) - 2;
        index = n === 0 ? 0 : (index + count - 1) % n;
        if (index >= count) index = n - index;
        break;
      }
    }
  }
  slot.sequenceIndex = index;
}

function setupDrawOrder(skeleton: Skeleton): void {
  const { slots, drawOrder } = skeleton;
  for (let i = 0; i < slots.length; i++) drawOrder[i] = slots[i]!;
}

function applyDrawOrder(tl: DrawOrderTimeline, skeleton: Skeleton, time: number, blend: MixBlend, direction: MixDirection): void {
  if (direction === MixDirection.mixOut) {
    if (blend === MixBlend.setup) setupDrawOrder(skeleton);
    return;
  }
  if (time < tl.times[0]!) {
    if (blend === MixBlend.setup || blend === MixBlend.first) setupDrawOrder(skeleton);
    return;
  }
  const order = tl.orders[searchFrame(tl.times, time)]!;
  if (!order) setupDrawOrder(skeleton);
  else for (let i = 0; i < order.length; i++) skeleton.drawOrder[i] = skeleton.slots[order[i]!]!;
}

/** spine-core EventTimeline.apply: keys in (lastTime, time]; lastTime > time means the animation looped. */
function collectEvents(tl: EventTimeline, lastTime: number, time: number, out: EventKey[]): void {
  const frames = tl.times;
  const frameCount = frames.length;
  if (lastTime > time) {
    collectEvents(tl, lastTime, Number.MAX_VALUE, out);
    lastTime = -1;
  } else if (lastTime >= frames[frameCount - 1]!) return;
  if (time < frames[0]!) return;
  let i = 0;
  if (lastTime >= frames[0]!) {
    i = searchFrame(frames, lastTime) + 1;
    const frameTime = frames[i];
    while (i > 0 && frames[i - 1] === frameTime) i--;
  }
  for (; i < frameCount && time >= frames[i]!; i++) out.push(tl.events[i]!);
}

function applyPhysicsReset(tl: PhysicsResetTimeline, skeleton: Skeleton, lastTime: number, time: number): void {
  if (!skeleton.physicsConstraints.length) return;
  const frames = tl.times;
  if (lastTime > time) {
    applyPhysicsReset(tl, skeleton, lastTime, Number.MAX_VALUE);
    lastTime = -1;
  } else if (lastTime >= frames[frames.length - 1]!) return;
  if (time < frames[0]!) return;
  if (lastTime < frames[0]! || time >= frames[searchFrame(frames, lastTime) + 1]!) {
    if (tl.target >= 0) {
      const c = skeleton.physicsConstraints[tl.target]!;
      if (c.active) c.reset();
    } else for (const c of skeleton.physicsConstraints) if (c.active) c.reset();
  }
}

// --- property ids (which timelines touch the same property) -------------------

const attachmentIds = new WeakMap<object, number>();
let nextAttachmentId = 1;
const idOf = (o: object): number => {
  let id = attachmentIds.get(o);
  if (id === undefined) attachmentIds.set(o, (id = nextAttachmentId++));
  return id;
};
const propertyIdCache = new WeakMap<Timeline, readonly string[]>();

/** Property ids a timeline writes (spine-core `Timeline.getPropertyIds`). */
export function timelinePropertyIds(tl: Timeline): readonly string[] {
  let ids = propertyIdCache.get(tl);
  if (ids) return ids;
  const t = 'target' in tl ? tl.target : 0;
  switch (tl.kind) {
    case 'rotate': ids = [`rotate|${t}`]; break;
    case 'translate': ids = [`x|${t}`, `y|${t}`]; break;
    case 'translatex': ids = [`x|${t}`]; break;
    case 'translatey': ids = [`y|${t}`]; break;
    case 'scale': ids = [`scaleX|${t}`, `scaleY|${t}`]; break;
    case 'scalex': ids = [`scaleX|${t}`]; break;
    case 'scaley': ids = [`scaleY|${t}`]; break;
    case 'shear': ids = [`shearX|${t}`, `shearY|${t}`]; break;
    case 'shearx': ids = [`shearX|${t}`]; break;
    case 'sheary': ids = [`shearY|${t}`]; break;
    case 'inherit': ids = [`inherit|${t}`]; break;
    case 'rgba': ids = [`rgb|${t}`, `alpha|${t}`]; break;
    case 'rgb': ids = [`rgb|${t}`]; break;
    case 'alpha': ids = [`alpha|${t}`]; break;
    case 'rgba2': ids = [`rgb|${t}`, `alpha|${t}`, `rgb2|${t}`]; break;
    case 'rgb2': ids = [`rgb|${t}`, `rgb2|${t}`]; break;
    case 'attachment': ids = [`attachment|${t}`]; break;
    case 'deform': ids = [`deform|${t}|${idOf(tl.attachment)}`]; break;
    case 'sequence': ids = [`sequence|${t}|${idOf(tl.attachment)}`]; break;
    case 'event': ids = ['event']; break;
    case 'drawOrder': ids = ['drawOrder']; break;
    case 'ik': ids = [`ik|${t}`]; break;
    case 'transformMix': ids = [`transform|${t}`]; break;
    case 'pathPosition': ids = [`pathPosition|${t}`]; break;
    case 'pathSpacing': ids = [`pathSpacing|${t}`]; break;
    case 'pathMix': ids = [`pathMix|${t}`]; break;
    case 'physicsReset': ids = [`physicsReset|${t}`]; break;
    default: ids = [`${tl.kind}|${t}`];
  }
  propertyIdCache.set(tl, ids);
  return ids;
}
