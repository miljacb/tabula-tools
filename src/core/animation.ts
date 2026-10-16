/**
 * Applies an animation to a skeleton at a given time with Spine 4.1 semantics.
 *
 * The caller resets the skeleton to its setup pose first; timelines then write
 * absolute values (equivalent to spine-core `AnimationState` on track 0 with
 * alpha 1, i.e. `MixBlend.first`). Events are not handled here; see clip.ts.
 */

import { interpolate, curvePercent, searchFrame } from './curves.js';
import { IK_FLAG_BEND_POSITIVE, IK_FLAG_COMPRESS, IK_FLAG_STRETCH, SequenceMode } from './types.js';
import { clamp } from './math.js';
import type {
  AnimationData, AttachmentTimeline, Color, CurveTimeline, DeformTimeline, DrawOrderTimeline, InheritTimeline, PhysicsConstraintData,
  PhysicsResetTimeline, SequenceTimeline,
} from './types.js';
import type { Skeleton } from './skeleton.js';
import type { PhysicsConstraint } from './constraints.js';

/** Fudge factor spine-core adds before flooring sequence frame indices. */
const SEQUENCE_EPSILON = 0.00001;

/**
 * Pose `skeleton` with `animation` at `time` seconds (already wrapped/clamped by the caller).
 * Does not update world transforms.
 */
export function applyAnimation(animation: AnimationData, skeleton: Skeleton, time: number): void {
  for (const timeline of animation.timelines) {
    switch (timeline.kind) {
      case 'attachment':
        applyAttachment(timeline, skeleton, time);
        break;
      case 'deform':
        applyDeform(timeline, skeleton, time);
        break;
      case 'sequence':
        applySequence(timeline, skeleton, time);
        break;
      case 'drawOrder':
        applyDrawOrder(timeline, skeleton, time);
        break;
      case 'inherit':
        applyInherit(timeline, skeleton, time);
        break;
      case 'event':
      case 'physicsReset':
        break;
      default:
        applyCurve(timeline, skeleton, time);
    }
  }
}

/** Value of `channel` at `time` for key `frame` (time >= times[frame]). No allocation. */
function channelValue(tl: CurveTimeline, frame: number, channel: number, time: number): number {
  const { times, values, channels } = tl;
  const v1 = values[frame * channels + channel]!;
  if (frame === times.length - 1) return v1;
  const v2 = values[(frame + 1) * channels + channel]!;
  return interpolate(tl.curves[frame]!, channel, times[frame]!, v1, times[frame + 1]!, v2, time);
}

// Each case evaluates its channels directly (no per-timeline closure: allocation-free per frame).
function applyCurve(tl: CurveTimeline, skeleton: Skeleton, time: number): void {
  if (time < tl.times[0]!) return; // setup pose stays
  const frame = searchFrame(tl.times, time);

  switch (tl.kind) {
    case 'rotate': {
      const bone = skeleton.bones[tl.target]!;
      bone.rotation = bone.data.rotation + channelValue(tl, frame, 0, time);
      return;
    }
    case 'translate': {
      const bone = skeleton.bones[tl.target]!;
      bone.x = bone.data.x + channelValue(tl, frame, 0, time);
      bone.y = bone.data.y + channelValue(tl, frame, 1, time);
      return;
    }
    case 'translatex': {
      const bone = skeleton.bones[tl.target]!;
      bone.x = bone.data.x + channelValue(tl, frame, 0, time);
      return;
    }
    case 'translatey': {
      const bone = skeleton.bones[tl.target]!;
      bone.y = bone.data.y + channelValue(tl, frame, 0, time);
      return;
    }
    case 'scale': {
      const bone = skeleton.bones[tl.target]!;
      bone.scaleX = bone.data.scaleX * channelValue(tl, frame, 0, time);
      bone.scaleY = bone.data.scaleY * channelValue(tl, frame, 1, time);
      return;
    }
    case 'scalex': {
      const bone = skeleton.bones[tl.target]!;
      bone.scaleX = bone.data.scaleX * channelValue(tl, frame, 0, time);
      return;
    }
    case 'scaley': {
      const bone = skeleton.bones[tl.target]!;
      bone.scaleY = bone.data.scaleY * channelValue(tl, frame, 0, time);
      return;
    }
    case 'shear': {
      const bone = skeleton.bones[tl.target]!;
      bone.shearX = bone.data.shearX + channelValue(tl, frame, 0, time);
      bone.shearY = bone.data.shearY + channelValue(tl, frame, 1, time);
      return;
    }
    case 'shearx': {
      const bone = skeleton.bones[tl.target]!;
      bone.shearX = bone.data.shearX + channelValue(tl, frame, 0, time);
      return;
    }
    case 'sheary': {
      const bone = skeleton.bones[tl.target]!;
      bone.shearY = bone.data.shearY + channelValue(tl, frame, 0, time);
      return;
    }
    case 'rgba':
      // spine-core sets RGBA via Color.set, which clamps; RGB and alpha timelines do not clamp.
      setClamped(skeleton.slots[tl.target]!.color, channelValue(tl, frame, 0, time), channelValue(tl, frame, 1, time),
        channelValue(tl, frame, 2, time), channelValue(tl, frame, 3, time));
      return;
    case 'rgb': {
      const c = skeleton.slots[tl.target]!.color;
      c.r = channelValue(tl, frame, 0, time);
      c.g = channelValue(tl, frame, 1, time);
      c.b = channelValue(tl, frame, 2, time);
      return;
    }
    case 'alpha': {
      skeleton.slots[tl.target]!.color.a = channelValue(tl, frame, 0, time);
      return;
    }
    case 'rgba2': {
      const slot = skeleton.slots[tl.target]!;
      setClamped(slot.color, channelValue(tl, frame, 0, time), channelValue(tl, frame, 1, time),
        channelValue(tl, frame, 2, time), channelValue(tl, frame, 3, time));
      if (slot.darkColor) {
        slot.darkColor.r = channelValue(tl, frame, 4, time);
        slot.darkColor.g = channelValue(tl, frame, 5, time);
        slot.darkColor.b = channelValue(tl, frame, 6, time);
      }
      return;
    }
    case 'rgb2': {
      const slot = skeleton.slots[tl.target]!;
      const c = slot.color;
      c.r = channelValue(tl, frame, 0, time);
      c.g = channelValue(tl, frame, 1, time);
      c.b = channelValue(tl, frame, 2, time);
      if (slot.darkColor) {
        slot.darkColor.r = channelValue(tl, frame, 3, time);
        slot.darkColor.g = channelValue(tl, frame, 4, time);
        slot.darkColor.b = channelValue(tl, frame, 5, time);
      }
      return;
    }
    case 'pathPosition':
      skeleton.pathConstraints[tl.target]!.position = channelValue(tl, frame, 0, time);
      return;
    case 'pathSpacing':
      skeleton.pathConstraints[tl.target]!.spacing = channelValue(tl, frame, 0, time);
      return;
    case 'pathMix': {
      const constraint = skeleton.pathConstraints[tl.target]!;
      constraint.mixRotate = channelValue(tl, frame, 0, time);
      constraint.mixX = channelValue(tl, frame, 1, time);
      constraint.mixY = channelValue(tl, frame, 2, time);
      return;
    }
    case 'ik': {
      const constraint = skeleton.ikConstraints[tl.target]!;
      constraint.mix = channelValue(tl, frame, 0, time);
      constraint.softness = channelValue(tl, frame, 1, time);
      const flags = tl.flags?.[frame] ?? IK_FLAG_BEND_POSITIVE;
      constraint.bendDirection = flags & IK_FLAG_BEND_POSITIVE ? 1 : -1;
      constraint.compress = (flags & IK_FLAG_COMPRESS) !== 0;
      constraint.stretch = (flags & IK_FLAG_STRETCH) !== 0;
      return;
    }
    case 'transformMix': {
      const constraint = skeleton.transformConstraints[tl.target]!;
      constraint.mixRotate = channelValue(tl, frame, 0, time);
      constraint.mixX = channelValue(tl, frame, 1, time);
      constraint.mixY = channelValue(tl, frame, 2, time);
      constraint.mixScaleX = channelValue(tl, frame, 3, time);
      constraint.mixScaleY = channelValue(tl, frame, 4, time);
      constraint.mixShearY = channelValue(tl, frame, 5, time);
      return;
    }
    default: {
      const physics = PHYSICS_PROPERTIES[tl.kind];
      if (!physics) return;
      const value = channelValue(tl, frame, 0, time);
      if (tl.target >= 0) physics.set(skeleton.physicsConstraints[tl.target]!, value);
      else for (const constraint of skeleton.physicsConstraints) if (constraint.data[physics.global]) physics.set(constraint, value);
    }
  }
}

/** Physics value timelines: setter and the data flag that opts a constraint into global (target -1) keys. */
const PHYSICS_PROPERTIES: Partial<Record<string, { set: (c: PhysicsConstraint, v: number) => void; global: keyof PhysicsConstraintData }>> = {
  physicsInertia: { set: (c, v) => (c.inertia = v), global: 'inertiaGlobal' },
  physicsStrength: { set: (c, v) => (c.strength = v), global: 'strengthGlobal' },
  physicsDamping: { set: (c, v) => (c.damping = v), global: 'dampingGlobal' },
  physicsMass: { set: (c, v) => (c.massInverse = 1 / v), global: 'massGlobal' },
  physicsWind: { set: (c, v) => (c.wind = v), global: 'windGlobal' },
  physicsGravity: { set: (c, v) => (c.gravity = v), global: 'gravityGlobal' },
  physicsMix: { set: (c, v) => (c.mix = v), global: 'mixGlobal' },
};

/**
 * Reset physics for every {@link PhysicsResetTimeline} key in (lastTime, time]
 * (spine-core `PhysicsConstraintResetTimeline.apply`; `lastTime > time` means
 * the animation looped).
 */
export function applyPhysicsResets(animation: AnimationData, skeleton: Skeleton, lastTime: number, time: number): void {
  if (!skeleton.physicsConstraints.length) return;
  for (const tl of animation.timelines) if (tl.kind === 'physicsReset') applyPhysicsReset(tl, skeleton, lastTime, time);
}

function applyPhysicsReset(tl: PhysicsResetTimeline, skeleton: Skeleton, lastTime: number, time: number): void {
  const frames = tl.times;
  if (lastTime > time) {
    applyPhysicsReset(tl, skeleton, lastTime, Number.MAX_VALUE);
    lastTime = -1;
  } else if (lastTime >= frames[frames.length - 1]!) return;
  if (time < frames[0]!) return;
  if (lastTime < frames[0]! || time >= frames[searchFrame(frames, lastTime) + 1]!) {
    if (tl.target >= 0) skeleton.physicsConstraints[tl.target]!.reset();
    else for (const constraint of skeleton.physicsConstraints) constraint.reset();
  }
}

function setClamped(c: Color, r: number, g: number, b: number, a: number): void {
  c.r = clamp(r, 0, 1);
  c.g = clamp(g, 0, 1);
  c.b = clamp(b, 0, 1);
  c.a = clamp(a, 0, 1);
}

function applyInherit(tl: InheritTimeline, skeleton: Skeleton, time: number): void {
  if (time < tl.times[0]!) return;
  skeleton.bones[tl.target]!.inherit = tl.inherits[searchFrame(tl.times, time)]!;
}

function applyAttachment(tl: AttachmentTimeline, skeleton: Skeleton, time: number): void {
  if (time < tl.times[0]!) return;
  const name = tl.names[searchFrame(tl.times, time)]!;
  skeleton.slots[tl.target]!.setAttachment(name ? skeleton.getAttachment(tl.target, name) : null);
}

function applyDeform(tl: DeformTimeline, skeleton: Skeleton, time: number): void {
  const slot = skeleton.slots[tl.target]!;
  const attachment = slot.attachment;
  if (!attachment) return;
  const timelineAttachment = attachment.type === 'mesh' ? attachment.timelineAttachment : attachment;
  if (timelineAttachment !== tl.attachment) return;
  const deform = slot.deform;
  const { times, frames } = tl;
  if (time < times[0]!) {
    if (deform.length !== 0) deform.length = 0;
    return;
  }
  const vertexCount = frames[0]!.length;
  if (deform.length !== vertexCount) deform.length = vertexCount;
  const last = times.length - 1;
  if (time >= times[last]!) {
    const lastVertices = frames[last]!;
    for (let i = 0; i < vertexCount; i++) deform[i] = lastVertices[i]!;
    return;
  }
  const frame = searchFrame(times, time);
  const percent = curvePercent(tl.curves[frame]!, times[frame]!, times[frame + 1]!, time);
  const prev = frames[frame]!;
  const next = frames[frame + 1]!;
  for (let i = 0; i < vertexCount; i++) {
    const p = prev[i]!;
    deform[i] = p + (next[i]! - p) * percent;
  }
}

function applySequence(tl: SequenceTimeline, skeleton: Skeleton, time: number): void {
  const slot = skeleton.slots[tl.target]!;
  const slotAttachment = slot.attachment;
  const attachment = tl.attachment;
  if (slotAttachment !== attachment) {
    if (!slotAttachment || slotAttachment.type !== 'mesh' || slotAttachment.timelineAttachment !== attachment) return;
  }
  const { times } = tl;
  if (time < times[0]!) {
    slot.sequenceIndex = -1;
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
    // `| 0` (not Math.trunc) maps NaN/Infinity from a zero delay to 0, like spine-core.
    index += ((time - before) / delay + SEQUENCE_EPSILON) | 0;
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

function applyDrawOrder(tl: DrawOrderTimeline, skeleton: Skeleton, time: number): void {
  if (time < tl.times[0]!) return;
  const order = tl.orders[searchFrame(tl.times, time)]!;
  const drawOrder = skeleton.drawOrder;
  const slots = skeleton.slots;
  if (!order) {
    for (let i = 0; i < slots.length; i++) drawOrder[i] = slots[i]!;
  } else {
    for (let i = 0; i < order.length; i++) drawOrder[i] = slots[order[i]!]!;
  }
}
