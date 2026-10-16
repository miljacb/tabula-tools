/**
 * Multi-track animation state: a port of spine-core's `AnimationState`
 * (4.2, with the 4.1 differences selected by the skeleton's Spine version).
 * Tracks layer animations (higher tracks over lower ones, `alpha`,
 * `mixBlend: add`), queue them (`addAnimation` with delays), crossfade
 * between them (`AnimationStateData` mix durations) and fire start /
 * interrupt / end / dispose / complete / event callbacks.
 *
 * Poses match spine-core exactly (tests/animation-state.test.ts compares
 * against both official runtimes). It evaluates timelines live: baked
 * samples are not used (see {@link Clip.state}).
 */

import { applyTimeline, curveValue, MixBlend, MixDirection, setAttachmentByName, timelinePropertyIds } from './timeline-apply.js';
import type { Skeleton } from './skeleton.js';
import type { AnimationData, CurveTimeline, EventKey, SkeletonData, Timeline } from './types.js';
import type { ClipEvent } from './clip.js';

export { MixBlend, MixDirection } from './timeline-apply.js';

const SUBSEQUENT = 0;
const FIRST = 1;
const HOLD_SUBSEQUENT = 2;
const HOLD_FIRST = 3;
const HOLD_MIX = 4;
const SETUP = 1;
const CURRENT = 2;

const EMPTY_ANIMATION: AnimationData = { name: '<empty>', duration: 0, timelines: [] };

/** Default and per-pair crossfade durations (spine-core `AnimationStateData`). */
export class AnimationStateData {
  /** Mix duration for pairs without {@link setMix} (seconds, default 0). */
  defaultMix = 0;
  private readonly mixes = new Map<string, number>();

  constructor(readonly skeletonData: SkeletonData) {}

  /**
   * Crossfade duration from animation `from` to `to` (names).
   * @throws if either animation does not exist.
   */
  setMix(from: string, to: string, duration: number): this {
    for (const name of [from, to]) if (!this.skeletonData.animations.some((a) => a.name === name)) throw new Error(`Animation "${name}" not found in skeleton "${this.skeletonData.name}"`);
    this.mixes.set(`${from}\u0000${to}`, duration);
    return this;
  }

  /** Mix duration between two animations: the {@link setMix} value, else {@link defaultMix}. */
  getMix(from: AnimationData, to: AnimationData): number {
    return this.mixes.get(`${from.name}\u0000${to.name}`) ?? this.defaultMix;
  }
}

/** Callbacks of an {@link AnimationState} or a single {@link TrackEntry}. All optional. */
export interface AnimationStateListener {
  /** The entry became current on its track (after its delay). */
  start?(entry: TrackEntry): void;
  /** Another entry replaced this one (it may still be mixing out). */
  interrupt?(entry: TrackEntry): void;
  /** The entry is no longer current or mixing out; it will not be applied again. */
  end?(entry: TrackEntry): void;
  /** The entry is released (after end, or when queued entries are cleared). Do not keep references. */
  dispose?(entry: TrackEntry): void;
  /** The animation reached its end (every loop for looping entries). */
  complete?(entry: TrackEntry): void;
  /** An event key was passed. */
  event?(entry: TrackEntry, event: ClipEvent): void;
}

/**
 * One animation on a track (spine-core `TrackEntry`). Returned by
 * {@link AnimationState.setAnimation} / {@link AnimationState.addAnimation};
 * set its fields right after to change how it plays.
 */
export class TrackEntry {
  /** The animation played. */
  animation: AnimationData = EMPTY_ANIMATION;
  /** Entry queued before this one on the track (null once current). */
  previous: TrackEntry | null = null;
  /** Entry queued after this one. */
  next: TrackEntry | null = null;
  /** Entry this one crossfades from. */
  mixingFrom: TrackEntry | null = null;
  /** Entry this one is crossfading to. */
  mixingTo: TrackEntry | null = null;
  /** Callbacks for this entry only (run before the state's listeners). */
  listener: AnimationStateListener | null = null;
  /** Track index. */
  trackIndex = 0;
  /** Loop the animation. */
  loop = false;
  /** Keep the previous entry's pose for properties this one does not key while mixing (no dip to setup). */
  holdPrevious = false;
  /** Play backwards (events are not fired). */
  reverse = false;
  /** Mix rotations the short way every frame instead of keeping the first direction. */
  shortestRotation = false;
  /** While mixing out, events fire until mix progress reaches this (0–1). */
  eventThreshold = 0;
  /** While mixing out, attachment keys apply until mix progress reaches this (0–1). */
  mixAttachmentThreshold = 0;
  /** Attachment keys apply when the entry's alpha is at least this (4.2). */
  alphaAttachmentThreshold = 0;
  /** While mixing out, draw order keys apply until mix progress reaches this (0–1). */
  mixDrawOrderThreshold = 0;
  /** Animation time where playback starts (seconds). */
  animationStart = 0;
  /** Animation time where playback ends / loops (default: the duration). */
  animationEnd = 0;
  /** Animation time of the last apply. */
  animationLast = 0;
  /** Bookkeeping: animation time the next update copies into {@link animationLast}. */
  nextAnimationLast = 0;
  /** Seconds to wait before this entry becomes current (queued entries) or starts. */
  delay = 0;
  /** Seconds since the entry started (scaled by {@link timeScale}). */
  trackTime = 0;
  /** Track time of the last update. */
  trackLast = 0;
  /** Bookkeeping: track time the next update copies into {@link trackLast} (-1 until first applied). */
  nextTrackLast = 0;
  /** Track time at which the track is cleared (default: never). */
  trackEnd = 0;
  /** Speed multiplier for this entry. */
  timeScale = 1;
  /** How much of this entry is applied (0–1). Lower tracks show through. */
  alpha = 1;
  /** Seconds into the crossfade from {@link mixingFrom}. */
  mixTime = 0;
  /** Crossfade duration from the previous entry (from {@link AnimationStateData}, editable). */
  mixDuration = 0;
  /** Bookkeeping: alpha this entry had when a newer entry interrupted its mix. */
  interruptAlpha = 1;
  /** Bookkeeping: summed alpha applied during the last mix-out (used to finish mixes). */
  totalAlpha = 0;
  /** How this entry combines with lower tracks: replace (default) or add (additive layering). Ignored on track 0. */
  mixBlend: MixBlend = MixBlend.replace;
  /** Bookkeeping: per-timeline mix mode (subsequent, first, hold variants), recomputed when tracks change. */
  readonly timelineMode: number[] = [];
  /** Bookkeeping: per-timeline entry whose mix limits a held timeline. */
  readonly timelineHoldMix: (TrackEntry | undefined)[] = [];
  /** Bookkeeping: per rotate timeline, accumulated mix angle and last difference (shortest-path tracking). */
  readonly timelinesRotation: number[] = [];

  /** Current animation time (looped / clamped between animationStart and animationEnd). */
  getAnimationTime(): number {
    if (this.loop) {
      const duration = this.animationEnd - this.animationStart;
      if (duration === 0) return this.animationStart;
      return (this.trackTime % duration) + this.animationStart;
    }
    return Math.min(this.trackTime + this.animationStart, this.animationEnd);
  }

  /** Set {@link animationLast} (events before it will not fire). */
  setAnimationLast(animationLast: number): void {
    this.animationLast = animationLast;
    this.nextAnimationLast = animationLast;
  }

  /** True when the track time has reached the end of the animation at least once. */
  isComplete(): boolean {
    return this.trackTime >= this.animationEnd - this.animationStart;
  }

  /** Forget the rotation directions chosen for mixing (they are re-picked next frame). */
  resetRotationDirections(): void {
    this.timelinesRotation.length = 0;
  }

  /** Track time at which the animation completes (next loop end for looping entries). */
  getTrackComplete(): number {
    const duration = this.animationEnd - this.animationStart;
    if (duration !== 0) {
      if (this.loop) return duration * (1 + ((this.trackTime / duration) | 0));
      if (this.trackTime < duration) return duration;
    }
    return this.trackTime;
  }

  /** True once the entry has been applied at least once. */
  wasApplied(): boolean {
    return this.nextTrackLast !== -1;
  }

  /** Set {@link mixDuration} and recompute the delay of a queued entry like addAnimation does. */
  setMixDurationWithDelay(mixDuration: number, delay: number): void {
    this.mixDuration = mixDuration;
    if (delay <= 0) delay = this.previous ? Math.max(delay + this.previous.getTrackComplete() - mixDuration, 0) : 0;
    this.delay = delay;
  }
}

type QueuedType = 0 | 1 | 2 | 3 | 4 | 5;
const START = 0, INTERRUPT = 1, END = 2, DISPOSE = 3, COMPLETE = 4, EVENT = 5;

/**
 * Plays animations on tracks with mixing and layering (spine-core
 * `AnimationState`). Call {@link update} then {@link apply} each frame,
 * then update the skeleton's world transforms ({@link Clip} does all of
 * this when you use {@link Clip.state}).
 *
 * @example
 * ```ts
 * const data = new AnimationStateData(skeletonData);
 * data.defaultMix = 0.2;
 * const state = new AnimationState(data);
 * state.setAnimation(0, 'idle', true);
 * state.setAnimation(1, 'blink', true).alpha = 0.5;
 * state.addAnimation(0, 'win', false, 0);
 * // each frame:
 * state.update(dt);
 * state.apply(skeleton);
 * skeleton.updateWorldTransform();
 * ```
 */
export class AnimationState {
  /** Speed multiplier for every track. */
  timeScale = 1;
  /** Tracks (null = empty). */
  readonly tracks: (TrackEntry | null)[] = [];
  private readonly listeners: AnimationStateListener[] = [];
  private readonly events: EventKey[] = [];
  private readonly queue: QueuedType[] = [];
  private readonly queueEntries: TrackEntry[] = [];
  private readonly queueEvents: (EventKey | null)[] = [];
  private drainDisabled = false;
  private unkeyedState = 0;
  private readonly propertyIds = new Set<string>();
  private animationsChanged = false;
  /** Spine 4.1 runtime semantics (mix completion, rotation direction, loop completion, delays). */
  private readonly v41: boolean;
  private readonly clipEvents = new WeakMap<EventKey, ClipEvent>();

  constructor(readonly data: AnimationStateData) {
    this.v41 = data.skeletonData.spineVersion.startsWith('4.1');
  }

  /** Advance every track by `delta` seconds, starting queued entries and finishing mixes. */
  update(delta: number): void {
    delta *= this.timeScale;
    const tracks = this.tracks;
    for (let i = 0, n = tracks.length; i < n; i++) {
      const current = tracks[i];
      if (!current) continue;
      current.animationLast = current.nextAnimationLast;
      current.trackLast = current.nextTrackLast;
      let currentDelta = delta * current.timeScale;
      if (current.delay > 0) {
        current.delay -= currentDelta;
        if (current.delay > 0) continue;
        currentDelta = -current.delay;
        current.delay = 0;
      }
      let next = current.next;
      if (next) {
        const nextTime = current.trackLast - next.delay;
        if (nextTime >= 0) {
          next.delay = 0;
          next.trackTime += current.timeScale === 0 ? 0 : (nextTime / current.timeScale + delta) * next.timeScale;
          current.trackTime += currentDelta;
          this.setCurrent(i, next, true);
          while (next.mixingFrom) {
            next.mixTime += delta;
            next = next.mixingFrom;
          }
          continue;
        }
      } else if (current.trackLast >= current.trackEnd && !current.mixingFrom) {
        tracks[i] = null;
        this.enqueue(END, current);
        this.clearNext(current);
        continue;
      }
      if (current.mixingFrom && this.updateMixingFrom(current, delta)) {
        let from: TrackEntry | null = current.mixingFrom;
        current.mixingFrom = null;
        if (from) from.mixingTo = null;
        while (from) {
          this.enqueue(END, from);
          from = from.mixingFrom;
        }
      }
      current.trackTime += currentDelta;
    }
    this.drain();
  }

  private updateMixingFrom(to: TrackEntry, delta: number): boolean {
    const from = to.mixingFrom;
    if (!from) return true;
    const finished = this.updateMixingFrom(from, delta);
    from.animationLast = from.nextAnimationLast;
    from.trackLast = from.nextTrackLast;
    const applied = this.v41 ? to.mixTime > 0 : to.nextTrackLast !== -1;
    if (applied && to.mixTime >= to.mixDuration) {
      if (from.totalAlpha === 0 || to.mixDuration === 0) {
        to.mixingFrom = from.mixingFrom;
        if (from.mixingFrom) from.mixingFrom.mixingTo = to;
        to.interruptAlpha = from.interruptAlpha;
        this.enqueue(END, from);
      }
      return finished;
    }
    from.trackTime += delta * from.timeScale;
    to.mixTime += delta;
    return false;
  }

  /**
   * Pose `skeleton` with every track (no world transforms). Has no side
   * effects besides listeners, so one state can pose several skeletons.
   * @returns true if any animation was applied.
   */
  apply(skeleton: Skeleton): boolean {
    if (this.animationsChanged) this.computeTimelineModes();
    const events = this.events;
    const tracks = this.tracks;
    let applied = false;
    for (let i = 0, n = tracks.length; i < n; i++) {
      const current = tracks[i];
      if (!current || current.delay > 0) continue;
      applied = true;
      const blend = i === 0 ? MixBlend.first : current.mixBlend;
      let alpha = current.alpha;
      if (current.mixingFrom) alpha *= this.applyMixingFrom(current, skeleton, blend);
      else if (current.trackTime >= current.trackEnd && !current.next) alpha = 0;
      let attachments = this.v41 ? true : alpha >= current.alphaAttachmentThreshold;
      const animationLast = current.animationLast, animationTime = current.getAnimationTime();
      let applyTime = animationTime;
      let applyEvents: EventKey[] | null = events;
      if (current.reverse) {
        applyTime = current.animation.duration - applyTime;
        applyEvents = null;
      }
      const timelines = current.animation.timelines;
      const timelineCount = timelines.length;
      if ((i === 0 && alpha === 1) || blend === MixBlend.add) {
        if (i === 0) attachments = true;
        for (let ii = 0; ii < timelineCount; ii++) {
          const timeline = timelines[ii]!;
          if (timeline.kind === 'attachment') this.applyAttachmentTimeline(timeline, skeleton, applyTime, blend, attachments);
          else applyTimeline(timeline, skeleton, animationLast, applyTime, applyEvents, alpha, blend, MixDirection.mixIn);
        }
      } else {
        const timelineMode = current.timelineMode;
        const shortestRotation = current.shortestRotation;
        const firstFrame = !shortestRotation && current.timelinesRotation.length !== timelineCount << 1;
        if (firstFrame) current.timelinesRotation.length = timelineCount << 1;
        for (let ii = 0; ii < timelineCount; ii++) {
          const timeline = timelines[ii]!;
          const timelineBlend = timelineMode[ii] === SUBSEQUENT ? blend : MixBlend.setup;
          if (!shortestRotation && timeline.kind === 'rotate') {
            this.applyRotateTimeline(timeline, skeleton, applyTime, alpha, timelineBlend, current.timelinesRotation, ii << 1, firstFrame);
          } else if (timeline.kind === 'attachment') {
            this.applyAttachmentTimeline(timeline, skeleton, applyTime, blend, attachments);
          } else {
            applyTimeline(timeline, skeleton, animationLast, applyTime, applyEvents, alpha, timelineBlend, MixDirection.mixIn);
          }
        }
      }
      this.queueTrackEvents(current, animationTime);
      events.length = 0;
      current.nextAnimationLast = animationTime;
      current.nextTrackLast = current.trackTime;
    }
    // Slots no track keyed this frame go back to their setup attachment.
    const setupState = this.unkeyedState + SETUP;
    const slots = skeleton.slots;
    for (let i = 0, n = slots.length; i < n; i++) {
      const slot = slots[i]!;
      if (slot.attachmentState === setupState) setAttachmentByName(skeleton, i, slot.data.attachmentName);
    }
    this.unkeyedState += 2;
    this.drain();
    return applied;
  }

  private applyMixingFrom(to: TrackEntry, skeleton: Skeleton, blend: MixBlend): number {
    const from = to.mixingFrom!;
    if (from.mixingFrom) this.applyMixingFrom(from, skeleton, blend);
    let mix: number;
    if (to.mixDuration === 0) {
      mix = 1;
      if (blend === MixBlend.first) blend = MixBlend.setup;
    } else {
      mix = to.mixTime / to.mixDuration;
      if (mix > 1) mix = 1;
      if (blend !== MixBlend.first) blend = from.mixBlend;
    }
    const attachments = mix < from.mixAttachmentThreshold, drawOrder = mix < from.mixDrawOrderThreshold;
    const timelines = from.animation.timelines;
    const timelineCount = timelines.length;
    const alphaHold = from.alpha * to.interruptAlpha, alphaMix = alphaHold * (1 - mix);
    const animationLast = from.animationLast, animationTime = from.getAnimationTime();
    let applyTime = animationTime;
    let events: EventKey[] | null = null;
    if (from.reverse) applyTime = from.animation.duration - applyTime;
    else if (mix < from.eventThreshold) events = this.events;

    if (blend === MixBlend.add) {
      for (let i = 0; i < timelineCount; i++) {
        const timeline = timelines[i]!;
        applyTimeline(timeline, skeleton, animationLast, applyTime, events, alphaMix, blend, this.v41 && timeline.kind === 'sequence' ? MixDirection.mixIn : MixDirection.mixOut);
      }
    } else {
      const timelineMode = from.timelineMode;
      const timelineHoldMix = from.timelineHoldMix;
      const shortestRotation = from.shortestRotation;
      const firstFrame = !shortestRotation && from.timelinesRotation.length !== timelineCount << 1;
      if (firstFrame) from.timelinesRotation.length = timelineCount << 1;
      from.totalAlpha = 0;
      for (let i = 0; i < timelineCount; i++) {
        const timeline = timelines[i]!;
        let direction = MixDirection.mixOut;
        let timelineBlend: MixBlend;
        let alpha: number;
        switch (timelineMode[i]) {
          case SUBSEQUENT:
            if (!drawOrder && timeline.kind === 'drawOrder') continue;
            timelineBlend = blend;
            alpha = alphaMix;
            break;
          case FIRST:
            timelineBlend = MixBlend.setup;
            alpha = alphaMix;
            break;
          case HOLD_SUBSEQUENT:
            timelineBlend = blend;
            alpha = alphaHold;
            break;
          case HOLD_FIRST:
            timelineBlend = MixBlend.setup;
            alpha = alphaHold;
            break;
          default: {
            timelineBlend = MixBlend.setup;
            const holdMix = timelineHoldMix[i]!;
            alpha = alphaHold * Math.max(0, 1 - holdMix.mixTime / holdMix.mixDuration);
          }
        }
        from.totalAlpha += alpha;
        if (!shortestRotation && timeline.kind === 'rotate') {
          this.applyRotateTimeline(timeline, skeleton, applyTime, alpha, timelineBlend, from.timelinesRotation, i << 1, firstFrame);
        } else if (timeline.kind === 'attachment') {
          this.applyAttachmentTimeline(timeline, skeleton, applyTime, timelineBlend, this.v41 ? attachments : attachments && alpha >= from.alphaAttachmentThreshold);
        } else {
          if (drawOrder && timeline.kind === 'drawOrder' && timelineBlend === MixBlend.setup) direction = MixDirection.mixIn;
          // 4.1's sequence timeline has no mix-out branch (4.2 resets the index to setup).
          applyTimeline(timeline, skeleton, animationLast, applyTime, events, alpha, timelineBlend, this.v41 && timeline.kind === 'sequence' ? MixDirection.mixIn : direction);
        }
      }
    }
    if (to.mixDuration > 0) this.queueTrackEvents(from, animationTime);
    this.events.length = 0;
    from.nextAnimationLast = animationTime;
    from.nextTrackLast = from.trackTime;
    return mix;
  }

  private applyAttachmentTimeline(timeline: Extract<Timeline, { kind: 'attachment' }>, skeleton: Skeleton, time: number, blend: MixBlend, attachments: boolean): void {
    const slot = skeleton.slots[timeline.target]!;
    if (!slot.bone.active) return;
    if (time < timeline.times[0]!) {
      if (blend === MixBlend.setup || blend === MixBlend.first) this.setAttachment(skeleton, timeline.target, slot.data.attachmentName, attachments);
    } else {
      let frame = 0;
      const times = timeline.times;
      for (let i = 1; i < times.length; i++) {
        if (times[i]! > time) break;
        frame = i;
      }
      this.setAttachment(skeleton, timeline.target, timeline.names[frame]!, attachments);
    }
    if (slot.attachmentState <= this.unkeyedState) slot.attachmentState = this.unkeyedState + SETUP;
  }

  private setAttachment(skeleton: Skeleton, slotIndex: number, name: string | null, attachments: boolean): void {
    setAttachmentByName(skeleton, slotIndex, name);
    if (attachments) skeleton.slots[slotIndex]!.attachmentState = this.unkeyedState + CURRENT;
  }

  private applyRotateTimeline(timeline: CurveTimeline, skeleton: Skeleton, time: number, alpha: number, blend: MixBlend, timelinesRotation: number[], i: number, firstFrame: boolean): void {
    if (firstFrame) timelinesRotation[i] = 0;
    if (alpha === 1) {
      applyTimeline(timeline, skeleton, 0, time, null, 1, blend, MixDirection.mixIn);
      return;
    }
    const bone = skeleton.bones[timeline.target]!;
    if (!bone.active) return;
    let r1: number, r2: number;
    if (time < timeline.times[0]!) {
      if (blend === MixBlend.setup) {
        bone.rotation = bone.data.rotation;
        return;
      }
      if (blend !== MixBlend.first) return;
      r1 = bone.rotation;
      r2 = bone.data.rotation;
    } else {
      r1 = blend === MixBlend.setup ? bone.data.rotation : bone.rotation;
      r2 = bone.data.rotation + curveValue(timeline, time);
    }
    let total: number;
    let diff = r2 - r1;
    if (this.v41) diff -= (16384 - ((16384.499999999996 - diff / 360) | 0)) * 360;
    else diff -= Math.ceil(diff / 360 - 0.5) * 360;
    if (diff === 0) total = timelinesRotation[i]!;
    else {
      let lastTotal: number, lastDiff: number;
      if (firstFrame) {
        lastTotal = 0;
        lastDiff = diff;
      } else {
        lastTotal = timelinesRotation[i]!;
        lastDiff = timelinesRotation[i + 1]!;
      }
      const signum = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
      if (this.v41) {
        const current = diff > 0;
        let dir = lastTotal >= 0;
        if (signum(lastDiff) !== signum(diff) && Math.abs(lastDiff) <= 90) {
          if (Math.abs(lastTotal) > 180) lastTotal += 360 * signum(lastTotal);
          dir = current;
        }
        total = diff + lastTotal - (lastTotal % 360);
        if (dir !== current) total += 360 * signum(lastTotal);
      } else {
        const loops = lastTotal - (lastTotal % 360);
        total = diff + loops;
        const current = diff >= 0;
        let dir = lastTotal >= 0;
        if (Math.abs(lastDiff) <= 90 && signum(lastDiff) !== signum(diff)) {
          if (Math.abs(lastTotal - loops) > 180) {
            total += 360 * signum(lastTotal);
            dir = current;
          } else if (loops !== 0) total -= 360 * signum(lastTotal);
          else dir = current;
        }
        if (dir !== current) total += 360 * signum(lastTotal);
      }
      timelinesRotation[i] = total;
    }
    timelinesRotation[i + 1] = diff;
    bone.rotation = r1 + total * alpha;
  }

  private queueTrackEvents(entry: TrackEntry, animationTime: number): void {
    const animationStart = entry.animationStart, animationEnd = entry.animationEnd;
    const duration = animationEnd - animationStart;
    const trackLastWrapped = entry.trackLast % duration;
    const events = this.events;
    let i = 0;
    const n = events.length;
    for (; i < n; i++) {
      const event = events[i]!;
      // Compare as float32 like the key times (spine-core's Event.time comes from a Float32Array).
      const time = Math.fround(event.time);
      if (time < trackLastWrapped) break;
      if (time > animationEnd) continue;
      this.enqueue(EVENT, entry, event);
    }
    let complete: boolean;
    if (entry.loop) {
      if (this.v41) complete = duration === 0 || trackLastWrapped > entry.trackTime % duration;
      else if (duration === 0) complete = true;
      else {
        const cycles = Math.floor(entry.trackTime / duration);
        complete = cycles > 0 && cycles > Math.floor(entry.trackLast / duration);
      }
    } else complete = animationTime >= animationEnd && entry.animationLast < animationEnd;
    if (complete) this.enqueue(COMPLETE, entry);
    for (; i < n; i++) {
      const event = events[i]!;
      if (Math.fround(event.time) < animationStart) continue;
      this.enqueue(EVENT, entry, event);
    }
  }

  /** Remove every track's entries at once (no mixing out). */
  clearTracks(): void {
    const old = this.drainDisabled;
    this.drainDisabled = true;
    for (let i = 0, n = this.tracks.length; i < n; i++) this.clearTrack(i);
    this.tracks.length = 0;
    this.drainDisabled = old;
    this.drain();
  }

  /** Remove the track's entries at once (no mixing out; the pose keeps the last applied values). */
  clearTrack(trackIndex: number): void {
    if (trackIndex >= this.tracks.length) return;
    const current = this.tracks[trackIndex];
    if (!current) return;
    this.enqueue(END, current);
    this.clearNext(current);
    let entry = current;
    for (;;) {
      const from = entry.mixingFrom;
      if (!from) break;
      this.enqueue(END, from);
      entry.mixingFrom = null;
      entry.mixingTo = null;
      entry = from;
    }
    this.tracks[current.trackIndex] = null;
    this.drain();
  }

  private setCurrent(index: number, current: TrackEntry, interrupt: boolean): void {
    const from = this.expandToIndex(index);
    this.tracks[index] = current;
    current.previous = null;
    if (from) {
      if (interrupt) this.enqueue(INTERRUPT, from);
      current.mixingFrom = from;
      from.mixingTo = current;
      current.mixTime = 0;
      if (from.mixingFrom && from.mixDuration > 0) current.interruptAlpha *= Math.min(1, from.mixTime / from.mixDuration);
      from.timelinesRotation.length = 0;
    }
    this.enqueue(START, current);
  }

  /**
   * Play `animation` on `trackIndex` now, replacing the current entry
   * (crossfading by the mix duration) and clearing queued ones.
   * @throws if the animation does not exist.
   */
  setAnimation(trackIndex: number, animation: string | AnimationData, loop = false): TrackEntry {
    const anim = this.findAnimation(animation);
    let interrupt = true;
    let current = this.expandToIndex(trackIndex);
    if (current) {
      if (current.nextTrackLast === -1) {
        // Never applied: replace it instead of mixing from it.
        this.tracks[trackIndex] = current.mixingFrom;
        this.enqueue(INTERRUPT, current);
        this.enqueue(END, current);
        this.clearNext(current);
        current = current.mixingFrom;
        interrupt = false;
      } else this.clearNext(current);
    }
    const entry = this.trackEntry(trackIndex, anim, loop, current);
    this.setCurrent(trackIndex, entry, interrupt);
    this.drain();
    return entry;
  }

  /**
   * Queue `animation` after the last entry of the track. `delay` > 0: seconds
   * after the previous entry starts; <= 0: relative to the previous entry's
   * completion minus the mix duration (0 = mix out exactly as it ends).
   * @throws if the animation does not exist.
   */
  addAnimation(trackIndex: number, animation: string | AnimationData, loop = false, delay = 0): TrackEntry {
    const anim = this.findAnimation(animation);
    let last = this.expandToIndex(trackIndex);
    if (last) while (last.next) last = last.next;
    const entry = this.trackEntry(trackIndex, anim, loop, last);
    if (!last) {
      this.setCurrent(trackIndex, entry, true);
      this.drain();
      if (delay < 0 && !this.v41) delay = 0;
    } else {
      last.next = entry;
      entry.previous = last;
      if (delay <= 0) delay = this.v41 ? delay + last.getTrackComplete() - entry.mixDuration : Math.max(delay + last.getTrackComplete() - entry.mixDuration, 0);
    }
    entry.delay = delay;
    return entry;
  }

  /** Mix the track out to the setup pose over `mixDuration` seconds, then clear it. */
  setEmptyAnimation(trackIndex: number, mixDuration = 0): TrackEntry {
    const entry = this.setAnimation(trackIndex, EMPTY_ANIMATION, false);
    entry.mixDuration = mixDuration;
    entry.trackEnd = mixDuration;
    return entry;
  }

  /** Queue a mix to the setup pose (see {@link addAnimation} for `delay`). */
  addEmptyAnimation(trackIndex: number, mixDuration = 0, delay = 0): TrackEntry {
    const entry = this.addAnimation(trackIndex, EMPTY_ANIMATION, false, delay);
    if (delay <= 0) entry.delay = this.v41 ? entry.delay + entry.mixDuration - mixDuration : Math.max(entry.delay + entry.mixDuration - mixDuration, 0);
    entry.mixDuration = mixDuration;
    entry.trackEnd = mixDuration;
    return entry;
  }

  /** {@link setEmptyAnimation} on every track. */
  setEmptyAnimations(mixDuration = 0): void {
    const old = this.drainDisabled;
    this.drainDisabled = true;
    for (let i = 0, n = this.tracks.length; i < n; i++) {
      const current = this.tracks[i];
      if (current) this.setEmptyAnimation(current.trackIndex, mixDuration);
    }
    this.drainDisabled = old;
    this.drain();
  }

  /** Current entry of a track, or null. */
  getCurrent(trackIndex: number): TrackEntry | null {
    return this.tracks[trackIndex] ?? null;
  }

  /** Add callbacks for every entry. */
  addListener(listener: AnimationStateListener): void {
    this.listeners.push(listener);
  }

  /** Remove callbacks added with {@link addListener}. */
  removeListener(listener: AnimationStateListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** Remove every listener. */
  clearListeners(): void {
    this.listeners.length = 0;
  }

  private findAnimation(animation: string | AnimationData): AnimationData {
    if (typeof animation !== 'string') return animation;
    const anim = this.data.skeletonData.animations.find((a) => a.name === animation);
    if (!anim) throw new Error(`Animation "${animation}" not found in skeleton "${this.data.skeletonData.name}"`);
    return anim;
  }

  private expandToIndex(index: number): TrackEntry | null {
    if (index < this.tracks.length) return this.tracks[index] ?? null;
    while (this.tracks.length <= index) this.tracks.push(null);
    return null;
  }

  private trackEntry(trackIndex: number, animation: AnimationData, loop: boolean, last: TrackEntry | null): TrackEntry {
    const entry = new TrackEntry();
    entry.trackIndex = trackIndex;
    entry.animation = animation;
    entry.loop = loop;
    entry.animationEnd = animation.duration;
    entry.animationLast = -1;
    entry.nextAnimationLast = -1;
    entry.trackLast = -1;
    entry.nextTrackLast = -1;
    entry.trackEnd = Number.MAX_VALUE;
    entry.mixDuration = last ? this.data.getMix(last.animation, animation) : 0;
    return entry;
  }

  private clearNext(entry: TrackEntry): void {
    let next = entry.next;
    while (next) {
      this.enqueue(DISPOSE, next);
      next = next.next;
    }
    entry.next = null;
  }

  private computeTimelineModes(): void {
    this.animationsChanged = false;
    this.propertyIds.clear();
    for (const track of this.tracks) {
      let entry = track;
      if (!entry) continue;
      while (entry.mixingFrom) entry = entry.mixingFrom;
      do {
        if (!entry.mixingTo || entry.mixBlend !== MixBlend.add) this.computeHold(entry);
        entry = entry.mixingTo;
      } while (entry);
    }
  }

  private computeHold(entry: TrackEntry): void {
    const to = entry.mixingTo;
    const timelines = entry.animation.timelines;
    const count = timelines.length;
    const timelineMode = entry.timelineMode;
    timelineMode.length = count;
    const holdMix = entry.timelineHoldMix;
    holdMix.length = 0;
    const ids = this.propertyIds;
    const addAll = (list: readonly string[]): boolean => {
      let added = false;
      for (const id of list) if (!ids.has(id)) {
        ids.add(id);
        added = true;
      }
      return added;
    };
    if (to && to.holdPrevious) {
      for (let i = 0; i < count; i++) timelineMode[i] = addAll(timelinePropertyIds(timelines[i]!)) ? HOLD_FIRST : HOLD_SUBSEQUENT;
      return;
    }
    outer: for (let i = 0; i < count; i++) {
      const timeline = timelines[i]!;
      const list = timelinePropertyIds(timeline);
      if (!addAll(list)) timelineMode[i] = SUBSEQUENT;
      else if (!to || timeline.kind === 'attachment' || timeline.kind === 'drawOrder' || timeline.kind === 'event' || !hasTimeline(to.animation, list)) {
        timelineMode[i] = FIRST;
      } else {
        for (let next = to.mixingTo; next; next = next.mixingTo) {
          if (hasTimeline(next.animation, list)) continue;
          if (entry.mixDuration > 0) {
            timelineMode[i] = HOLD_MIX;
            holdMix[i] = next;
            continue outer;
          }
          break;
        }
        timelineMode[i] = HOLD_FIRST;
      }
    }
  }

  // --- event queue -------------------------------------------------------------

  private enqueue(type: QueuedType, entry: TrackEntry, event: EventKey | null = null): void {
    this.queue.push(type);
    this.queueEntries.push(entry);
    this.queueEvents.push(event);
    if (type === START || type === END) this.animationsChanged = true;
  }

  private drain(): void {
    if (this.drainDisabled) return;
    this.drainDisabled = true;
    const { queue, queueEntries, queueEvents } = this;
    for (let i = 0; i < queue.length; i++) {
      const type = queue[i]!;
      const entry = queueEntries[i]!;
      const listeners = this.listeners.slice();
      const call = (name: Exclude<keyof AnimationStateListener, 'event'>): void => {
        entry.listener?.[name]?.(entry);
        for (const l of listeners) l[name]?.(entry);
      };
      switch (type) {
        case START: call('start'); break;
        case INTERRUPT: call('interrupt'); break;
        case END: call('end'); call('dispose'); break;
        case DISPOSE: call('dispose'); break;
        case COMPLETE: call('complete'); break;
        case EVENT: {
          const event = this.toClipEvent(queueEvents[i]!);
          entry.listener?.event?.(entry, event);
          for (const l of listeners) l.event?.(entry, event);
        }
      }
    }
    queue.length = 0;
    queueEntries.length = 0;
    queueEvents.length = 0;
    this.drainDisabled = false;
  }

  private toClipEvent(e: EventKey): ClipEvent {
    let event = this.clipEvents.get(e);
    if (!event) {
      const audioPath = this.data.skeletonData.events.find((d) => d.name === e.name)?.audioPath ?? null;
      event = {
        name: e.name, time: e.time, int: e.intValue, float: e.floatValue, string: e.stringValue,
        ...(audioPath ? { audio: { path: audioPath, volume: e.volume, balance: e.balance } } : {}),
      };
      this.clipEvents.set(e, event);
    }
    return event;
  }
}

const hasTimelineCache = new WeakMap<AnimationData, Set<string>>();

/** True if `animation` has a timeline writing any of `ids` (spine-core `Animation.hasTimeline`). */
function hasTimeline(animation: AnimationData, ids: readonly string[]): boolean {
  let set = hasTimelineCache.get(animation);
  if (!set) {
    set = new Set(animation.timelines.flatMap((t) => [...timelinePropertyIds(t)]));
    hasTimelineCache.set(animation, set);
  }
  for (const id of ids) if (set.has(id)) return true;
  return false;
}
