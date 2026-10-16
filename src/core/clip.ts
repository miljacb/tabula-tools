/**
 * Clip: the playback API of the Tabula runtime (design §10.1). A clip owns a
 * {@link Skeleton} and poses it each update, either live (evaluating the IR
 * timelines) or from baked samples. Both modes feed the same renderer.
 */

import { Skeleton } from './skeleton.js';
import { applyAnimation, applyPhysicsResets } from './animation.js';
import { Physics } from './constraints.js';
import { applyBakedPose, applyDiscreteTimelines, bakedDeformSlots } from './bake.js';
import type { BakedAnimation, BakedSkeletonData } from './bake.js';
import type { AnimationData, Color, EventTimeline, SkeletonData, SkinData } from './types.js';
import { resolveSkin, type SkinSelector } from './skins.js';
import { DEG_TO_RAD, hypot2 } from './math.js';
import { SkeletonBounds } from './bounds.js';
import { AnimationState, AnimationStateData } from './animation-state.js';
import type { BoundingBoxPolygon } from './bounds.js';

/** An event fired by a clip's animation. */
export interface ClipEvent {
  name: string;
  /** Authored time in seconds. */
  time: number;
  int: number;
  float: number;
  string: string;
  /** Present when the event data has an audio path. */
  audio?: { path: string; volume: number; balance: number };
}

/** How the current animation is evaluated. */
export type ClipKind = 'baked' | 'live';

/** Events a {@link Clip} emits: authored events, loop wrap-arounds and completion. */
export type ClipEventType = 'event' | 'complete' | 'loop';

/** Listener signature for {@link Clip.on}. */
export type ClipEventListener<T extends ClipEventType> = T extends 'event'
  ? (event: ClipEvent, clip: Clip) => void
  : (clip: Clip) => void;

/** 2D affine matrix in Pixi's convention: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/** Options for {@link Clip}. */
export interface ClipOptions {
  /** Pose for a y-down renderer (Pixi). Default true. */
  yDown?: boolean;
  /**
   * Simulate physics constraints (Spine 4.2) during {@link Clip.update}.
   * Default true; false poses physics bones without the simulation.
   */
  physics?: boolean;
  /** Baked samples; animations found here play baked, others play live. */
  baked?: BakedSkeletonData | null;
  /** Initial skin, or skins to combine (`['10', 'explode']`). Default: the skeleton's default skin (or its first skin). */
  skin?: SkinSelector;
}

/** Options for {@link Clip.play}. */
export interface PlayOptions {
  /** true = loop forever, a number = repeat that many extra times, false = play once. */
  loop?: boolean | number;
  speed?: number;
  /** Start time in seconds. */
  from?: number;
  /**
   * Crossfade from the current pose over this many seconds (default 0 = cut).
   * Bone world transforms (rotation and scale by angle, translation linearly),
   * slot colors and matching deforms are blended; attachments and draw order
   * switch to the new animation at once, and only the new animation fires
   * events. Works for baked and live animations alike.
   */
  mix?: number;
}

/** A crossfade in progress (see {@link PlayOptions.mix}). */
interface MixState {
  from: AnimationData;
  fromBaked: BakedAnimation | null;
  fromTime: number;
  fromLoop: boolean;
  elapsed: number;
  duration: number;
}

/**
 * Plays one animation at a time on a skeleton ({@link play}), or several
 * layered tracks through {@link state} (multi-track mode).
 *
 * @example
 * ```ts
 * const clip = new Clip(data, { baked });
 * clip.play('symbolWin', { loop: false });
 * clip.update(1 / 60); // each frame
 * await clip.finished();
 * ```
 */
export class Clip {
  /** The posed skeleton (read it for bone/slot state; the renderer draws it). */
  readonly skeleton: Skeleton;
  /** Whole-clip light multiplier (straight RGBA, 0–1), applied at render time. */
  readonly tint: Color = { r: 1, g: 1, b: 1, a: 1 };
  /** Whole-clip multiplier for slot dark colors (two-color tint). */
  readonly darkTint: Color = { r: 1, g: 1, b: 1, a: 1 };

  private readonly yDown: boolean;
  private readonly physics: boolean;
  private physicsDelta = 0;
  private readonly baked: Map<string, BakedAnimation>;
  /** True when baked matrices use the opposite Y convention and must be flipped. */
  private readonly bakedFlipY: boolean;
  private animation: AnimationData | null = null;
  private mixState: MixState | null = null;
  /** World matrices (6 floats per bone) and slot colors (7 floats per slot) of the outgoing pose while mixing. */
  private mixBones = new Float64Array(0);
  private mixSlots = new Float64Array(0);
  private mixDeforms: (number[] | null)[] = [];
  /** Slot index -> attachment name (null = hidden) set with {@link setAttachment}; applied after every pose. */
  private readonly attachmentOverrides = new Map<number, string | null>();
  private bakedAnimation: BakedAnimation | null = null;
  private _time = 0;
  /** Time up to which events have been fired; -1 = nothing fired yet (events at 0 still pending). */
  private eventTime = -1;
  private _speed = 1;
  private _loop: boolean | number = false;
  private loopCount = 0;
  private paused = true;
  private completed = false;

  private readonly bounds = new SkeletonBounds();
  private readonly eventListeners: ((event: ClipEvent, clip: Clip) => void)[] = [];
  private readonly completeListeners: ((clip: Clip) => void)[] = [];
  private readonly loopListeners: ((clip: Clip) => void)[] = [];
  /**
   * Outcome of the last {@link play} for {@link finished}. The promise is
   * created only when someone asks for it: a cascade restarts animations
   * constantly, and an unobserved promise plus an `Error` (stack capture)
   * per restart is wasted work.
   */
  private finishedStatus = FinishedStatus.None;
  private finishedReason = '';
  private finishedPromise: Promise<void> | null = null;
  private finishedResolve: (() => void) | null = null;
  private finishedReject: ((reason: Error) => void) | null = null;
  private _state: AnimationState | null = null;
  private stateActive = false;
  private readonly initialSkin: SkinData | null;
  private _poseVersion = 0;

  constructor(data: SkeletonData, options: ClipOptions = {}) {
    this.skeleton = new Skeleton(data);
    this.yDown = options.yDown ?? true;
    this.skeleton.scaleY = this.yDown ? -1 : 1;
    this.skeleton.yDown = this.yDown;
    this.physics = options.physics ?? true;
    if (options.skin !== undefined) this.setSkinOrThrow(options.skin);
    this.initialSkin = this.skeleton.skin;
    this.baked = new Map();
    const baked = options.baked;
    this.bakedFlipY = baked ? baked.yDown !== this.yDown : false;
    if (baked) {
      if (baked.hash !== data.hash) throw new Error(`Baked data for "${baked.name}" does not match skeleton "${data.name}" (hash mismatch)`);
      for (const anim of baked.animations) this.baked.set(anim.name, anim);
    }
    this.pose();
  }

  /** Duration of the current animation in seconds (0 if none). */
  get duration(): number {
    return this.animation?.duration ?? 0;
  }

  /** Whether the current animation plays from baked samples or live (always live in multi-track mode). */
  get kind(): ClipKind {
    return this.bakedAnimation && !this.stateActive ? 'baked' : 'live';
  }

  /**
   * Multi-track playback (spine-core `AnimationState` semantics: tracks,
   * queueing, mix durations, additive blending, track alpha, listeners).
   * The first access switches the clip to multi-track mode: the single-track
   * animation stops (its {@link finished} rejects) and {@link update}
   * advances and applies the state instead. {@link play} or {@link stop}
   * switch back. Multi-track mode always evaluates timelines live; baked
   * samples are only used by {@link play}. Authored events are also
   * forwarded to {@link on}('event') listeners; completion is reported per
   * track entry through state listeners. {@link speed} and {@link pause}
   * still apply.
   *
   * @example
   * ```ts
   * clip.state.data.defaultMix = 0.2;
   * clip.state.setAnimation(0, 'idle', true);
   * clip.state.setAnimation(1, 'blink', true).alpha = 0.8;
   * clip.state.addAnimation(0, 'win', false, 0);
   * ```
   */
  get state(): AnimationState {
    let state = this._state;
    if (!state) {
      state = this._state = new AnimationState(new AnimationStateData(this.skeleton.data));
      state.addListener({ event: (_entry, event) => {
        if (this.stateActive) for (const fn of this.eventListeners.slice()) fn(event, this);
      } });
    }
    if (!this.stateActive) {
      this.stateActive = true;
      this.mixState = null;
      this.animation = null;
      this.bakedAnimation = null;
      this._time = 0;
      this.paused = false;
      this.completed = false;
      this.rejectFinished('Switched to multi-track mode');
    }
    return state;
  }

  /** True while the clip plays through {@link state} (multi-track mode). */
  get multiTrack(): boolean {
    return this.stateActive;
  }

  /** Leave multi-track mode: clear the tracks (firing their end / dispose callbacks). */
  private leaveState(): void {
    if (!this.stateActive) return;
    this.stateActive = false;
    this._state!.clearTracks();
  }

  /** Name of the current animation, or null. */
  get animationName(): string | null {
    return this.animation?.name ?? null;
  }

  /** Current time within the animation, seconds. Setting it does not fire events. */
  get time(): number {
    return this._time;
  }

  set time(value: number) {
    this.seek(value);
  }

  /** Playback rate multiplier (1 = authored speed). */
  get speed(): number {
    return this._speed;
  }

  set speed(value: number) {
    this._speed = value;
  }

  /** true = loop forever, a number = extra repeats, false = play once. */
  get loop(): boolean | number {
    return this._loop;
  }

  set loop(value: boolean | number) {
    this._loop = value;
  }

  /** True while an animation is playing (not paused, not completed; in multi-track mode: any track has an entry). */
  get playing(): boolean {
    if (this.stateActive) return !this.paused && this._state!.tracks.some((t) => t);
    return !this.paused && !this.completed && this.animation !== null;
  }

  /**
   * Start (or restart) an animation. Without a name, restarts the current one.
   * `loop` and `speed` keep their previous values when omitted; `mix`
   * crossfades from the current pose. Rejects the previous {@link finished}.
   * @throws if the skeleton has no animation `animation`.
   *
   * @example
   * ```ts
   * clip.play('symbolIdle', { loop: true });
   * clip.play('symbolWin', { mix: 0.2, loop: false, speed: 1.5 });
   * clip.play(); // restart the current animation
   * ```
   */
  play(animation?: string, opts: PlayOptions = {}): this {
    this.leaveState();
    const mix = opts.mix ?? 0;
    this.mixState = mix > 0 && this.animation
      ? { from: this.animation, fromBaked: this.bakedAnimation, fromTime: this._time, fromLoop: this._loop !== false && !this.completed, elapsed: 0, duration: mix }
      : null;
    if (animation !== undefined) {
      const anim = this.skeleton.data.animations.find((a) => a.name === animation);
      if (!anim) throw new Error(`Animation "${animation}" not found in skeleton "${this.skeleton.data.name}"`);
      this.animation = anim;
      // Physics poses depend on history: skeletons with physics always play live.
      this.bakedAnimation = this.skeleton.hasPhysics ? null : this.baked.get(anim.name) ?? null;
    }
    if (opts.loop !== undefined) this._loop = opts.loop;
    if (opts.speed !== undefined) this._speed = opts.speed;
    this._time = Math.max(0, opts.from ?? 0);
    this.eventTime = this._time > 0 ? this._time : -1;
    this.loopCount = 0;
    this.paused = false;
    this.completed = false;
    this.rejectFinished('Animation restarted');
    this.finishedStatus = FinishedStatus.Pending;
    this.finishedPromise = null;
    this.pose();
    return this;
  }

  /** True while a crossfade started with {@link PlayOptions.mix} is in progress. */
  get mixing(): boolean {
    return this.mixState !== null;
  }

  /**
   * Show attachment `attachment` (looked up in the active skin, then the
   * default skin) in slot `slot`, or hide the slot with null. The override
   * wins over setup pose and attachment keys until cleared with
   * {@link clearAttachment}.
   * @throws if the slot or the attachment does not exist.
   *
   * @example
   * ```ts
   * clip.setAttachment('weapon', 'sword');
   * clip.setAttachment('weapon', null); // hide
   * clip.clearAttachment('weapon');
   * ```
   */
  setAttachment(slot: string, attachment: string | null): this {
    const target = this.skeleton.findSlot(slot);
    if (!target) throw new Error(`Slot "${slot}" not found in skeleton "${this.skeleton.data.name}"`);
    if (attachment !== null && !this.skeleton.getAttachment(target.data.index, attachment)) {
      throw new Error(`Attachment "${attachment}" not found for slot "${slot}" in the active or default skin`);
    }
    this.attachmentOverrides.set(target.data.index, attachment);
    this.pose();
    return this;
  }

  /** Remove a {@link setAttachment} override (all overrides when `slot` is omitted). */
  clearAttachment(slot?: string): this {
    const skeleton = this.skeleton;
    // Multi-track mode does not reset to the setup pose each frame: restore the setup attachment.
    const restore = (index: number): void => {
      if (this.stateActive) skeleton.slots[index]!.setAttachment(skeleton.getAttachment(index, skeleton.slots[index]!.data.attachmentName ?? '') ?? null);
    };
    if (slot === undefined) {
      for (const index of this.attachmentOverrides.keys()) restore(index);
      this.attachmentOverrides.clear();
    } else {
      const target = skeleton.findSlot(slot);
      if (target && this.attachmentOverrides.delete(target.data.index)) restore(target.data.index);
    }
    this.pose();
    return this;
  }

  /** Stop playback and return to the setup pose. Rejects {@link finished}. */
  stop(): this {
    this.leaveState();
    this.mixState = null;
    this.paused = true;
    this.animation = null;
    this.bakedAnimation = null;
    this._time = 0;
    this.rejectFinished('Animation stopped');
    this.pose();
    return this;
  }

  /** Freeze time; {@link resume} continues. */
  pause(): this {
    this.paused = true;
    return this;
  }

  /** Continue after {@link pause}. */
  resume(): this {
    this.paused = false;
    return this;
  }

  /**
   * Jump to `time`. With `fireEvents`, events between the current and target time fire (forward seeks only).
   *
   * @example
   * ```ts
   * clip.seek(clip.duration / 2);       // silent jump
   * clip.seek(1.2, true);               // fire events passed on the way
   * ```
   */
  seek(time: number, fireEvents = false): this {
    const duration = this.duration;
    const target = Math.min(Math.max(0, time), duration);
    if (fireEvents && target > this._time) this.fireEvents(this.eventTime, target);
    this._time = target;
    this.eventTime = target;
    this.pose();
    return this;
  }

  /** Jump to the end of the animation and complete it (quick-stop / turbo). */
  skipToEnd(fireEvents = false): this {
    if (!this.animation) return this;
    this.seek(this.animation.duration, fireEvents);
    this.complete();
    return this;
  }

  /**
   * Change skin; the current pose is kept. Pass several names to show those
   * skins together (later names win where two fill the same attachment):
   * the combination is built once per skeleton and shared by all its clips.
   *
   * @example
   * ```ts
   * clip.setSkin('10');
   * clip.setSkin(['10', 'explode']); // value and explosion together
   * ```
   */
  setSkin(skin: SkinSelector): this {
    this.setSkinOrThrow(skin);
    this.pose();
    return this;
  }

  private setSkinOrThrow(skin: SkinSelector): void {
    if (typeof skin !== 'string' && skin.length === 0) throw new Error('setSkin: no skin names given');
    if (this.skeleton.setSkin(skin)) return;
    const names = typeof skin === 'string' ? [skin] : skin;
    const missing = names.filter((n) => !resolveSkin(this.skeleton.data, n));
    throw new Error(`Skin "${missing.join('", "') || names.join('+')}" not found in skeleton "${this.skeleton.data.name}"`);
  }

  /**
   * Whole-clip tint multipliers (0xRRGGBB). `dark` multiplies slot dark colors.
   * No rebake needed.
   *
   * @example
   * ```ts
   * clip.setTint(0xff8080);            // reddish
   * clip.setTint(0xffffff, 0x404040);  // darker dark color on two-color slots
   * ```
   */
  setTint(light: number, dark = 0xffffff): this {
    hexToColor(light, this.tint);
    hexToColor(dark, this.darkTint);
    return this;
  }

  /** True if the skeleton has an animation called `name`. */
  hasAnimation(name: string): boolean {
    return this.skeleton.data.animations.some((a) => a.name === name);
  }

  /** Names of all animations. */
  get animationNames(): string[] {
    return this.skeleton.data.animations.map((a) => a.name);
  }

  /**
   * Skeleton-space transform of a point attachment (or, if none has that name,
   * of the bone with that name). Writes into `out` without allocating.
   *
   * @example
   * ```ts
   * const m = clip.getPointTransform('coinSpawn', { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
   * coin.position.set(m.tx, m.ty); // in the view's local space
   * ```
   */
  getPointTransform(point: string, out: Matrix2D): Matrix2D {
    const skeleton = this.skeleton;
    for (const slot of skeleton.slots) {
      const att = slot.attachment;
      if (att?.type !== 'point' || att.name !== point || !slot.bone.active) continue;
      const bone = slot.bone;
      const cos = Math.cos(att.rotation * DEG_TO_RAD);
      const sin = Math.sin(att.rotation * DEG_TO_RAD);
      const r = Math.atan2(cos * bone.c + sin * bone.d, cos * bone.a + sin * bone.b);
      return setRotationTranslation(out, r, att.x * bone.a + att.y * bone.b + bone.worldX, att.x * bone.c + att.y * bone.d + bone.worldY);
    }
    const bone = skeleton.findBone(point);
    if (!bone) return setRotationTranslation(out, 0, 0, 0);
    return setRotationTranslation(out, bone.worldRotationX * DEG_TO_RAD, bone.worldX, bone.worldY);
  }

  /**
   * Topmost visible bounding box attachment containing the skeleton-space
   * point (x, y) in the current pose, or null. The returned object is reused
   * by the next call.
   *
   * @example
   * ```ts
   * const box = clip.hitTest(local.x, local.y);
   * if (box) console.log(box.attachment.name);
   * ```
   */
  hitTest(x: number, y: number): BoundingBoxPolygon | null {
    return this.bounds.update(this.skeleton).containsPoint(x, y);
  }

  /** World polygons of the visible bounding boxes in the current pose (reused by the next call). */
  getBoundingBoxes(): readonly BoundingBoxPolygon[] {
    return this.bounds.update(this.skeleton).polygons;
  }

  /**
   * Add a listener. Listeners run synchronously inside {@link update} / {@link seek}.
   *
   * @example
   * ```ts
   * clip.on('event', (e) => { if (e.audio) sound.play(e.audio.path); });
   * clip.on('complete', () => console.log('done'));
   * ```
   */
  on<T extends ClipEventType>(event: T, fn: ClipEventListener<T>): this {
    this.listenersFor(event).push(fn as never);
    return this;
  }

  /** Remove a listener added with {@link on}. */
  off<T extends ClipEventType>(event: T, fn: ClipEventListener<T>): this {
    const list = this.listenersFor(event) as unknown[];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
    return this;
  }

  /** Remove every listener added with {@link on} (all types, or one type). */
  removeAllListeners(event?: ClipEventType): this {
    if (event) this.listenersFor(event).length = 0;
    else this.eventListeners.length = this.completeListeners.length = this.loopListeners.length = 0;
    return this;
  }

  /**
   * Incremented every time the skeleton is posed ({@link update}, {@link play},
   * {@link seek}, {@link setSkin}, ...). A cached frame is stale when it differs.
   */
  get poseVersion(): number {
    return this._poseVersion;
  }

  /**
   * Return to the state of a freshly constructed clip, without allocating a
   * new skeleton: playback stopped at the setup pose, multi-track state and
   * its listeners dropped (no end/dispose callbacks), {@link on} listeners
   * removed, tint, dark tint, attachment overrides, speed, loop, skin (the
   * constructor's) and skeleton root transform reset, physics restarted.
   * A pending {@link finished} promise rejects. Used by view pools.
   */
  reset(): this {
    const state = this._state;
    if (state) {
      state.clearListeners();
      state.clearTracks();
      this._state = null;
    }
    this.stateActive = false;
    this.eventListeners.length = this.completeListeners.length = this.loopListeners.length = 0;
    this.mixState = null;
    this.animation = null;
    this.bakedAnimation = null;
    this._time = 0;
    this.eventTime = -1;
    this._speed = 1;
    this._loop = false;
    this.loopCount = 0;
    this.paused = true;
    this.completed = false;
    this.physicsDelta = 0;
    this.rejectFinished('Clip reset');
    this.finishedStatus = FinishedStatus.None;
    this.finishedPromise = null;
    this.tint.r = this.tint.g = this.tint.b = this.tint.a = 1;
    this.darkTint.r = this.darkTint.g = this.darkTint.b = this.darkTint.a = 1;
    this.attachmentOverrides.clear();
    const skeleton = this.skeleton;
    if (skeleton.skin !== this.initialSkin) {
      skeleton.skin = this.initialSkin;
      skeleton.updateCache();
    }
    skeleton.x = skeleton.y = 0;
    skeleton.scaleX = 1;
    skeleton.scaleY = this.yDown ? -1 : 1;
    skeleton.time = 0;
    this.resetPhysics();
    this.pose();
    return this;
  }

  /** Resolves when the current (non-looping) animation completes; rejects if stopped or restarted. */
  finished(): Promise<void> {
    if (this.finishedPromise) return this.finishedPromise;
    let promise: Promise<void>;
    switch (this.finishedStatus) {
      case FinishedStatus.Pending:
        promise = new Promise<void>((resolve, reject) => {
          this.finishedResolve = resolve;
          this.finishedReject = reject;
        });
        break;
      case FinishedStatus.Rejected:
        promise = Promise.reject(new Error(this.finishedReason));
        break;
      default:
        promise = Promise.resolve();
    }
    // Rejections are part of normal control flow (restart, stop): never "unhandled".
    promise.catch(() => undefined);
    return (this.finishedPromise = promise);
  }

  /**
   * Restart physics simulation from the current pose (e.g. after teleporting
   * the clip). Same as a physics reset key in the animation.
   *
   * @example
   * ```ts
   * view.position.set(100, 100); // teleport
   * view.clip.resetPhysics();
   * ```
   */
  resetPhysics(): this {
    for (const constraint of this.skeleton.physicsConstraints) constraint.reset();
    return this;
  }

  /**
   * Advance by `dt` seconds (scaled by {@link speed}), fire events, and pose
   * the skeleton. Physics constraints are stepped even while paused or
   * completed, so they settle.
   */
  update(dt: number): void {
    const anim = this.animation;
    const skeleton = this.skeleton;
    const physics = skeleton.hasPhysics && this.physics;
    // Advanced in pose(Physics.Update), after reset keys were applied (spine-core order).
    this.physicsDelta = physics ? dt * this._speed : 0;
    if (this.stateActive) {
      if (!this.paused) {
        const state = this._state!;
        state.update(dt * this._speed);
        state.apply(skeleton);
      }
      this.pose(Physics.Update);
      return;
    }
    if (this.paused || this.completed || !anim) {
      // A crossfade longer than the new (completed) animation still finishes.
      const mixing = !this.paused && this.mixState !== null;
      if (mixing) this.advanceMix(dt * this._speed);
      if (physics || mixing) this.pose(Physics.Update);
      return;
    }
    this.advanceMix(dt * this._speed);
    const duration = anim.duration;
    let next = this._time + dt * this._speed;

    if (duration <= 0) {
      this.fireEvents(this.eventTime, 0);
      this._time = 0;
      this.eventTime = 0;
      if (this._loop === false) this.complete();
      this.pose(Physics.Update);
      return;
    }

    while (next >= duration && this.canLoop()) {
      this.fireEvents(this.eventTime, duration);
      if (physics) applyPhysicsResets(anim, skeleton, this.eventTime, duration);
      next -= duration;
      this.eventTime = -1;
      this.loopCount++;
      for (const fn of this.loopListeners.slice()) fn(this);
    }
    if (next >= duration) {
      this.fireEvents(this.eventTime, duration);
      if (physics) applyPhysicsResets(anim, skeleton, this.eventTime, duration);
      this._time = duration;
      this.eventTime = duration;
      this.pose(Physics.Update);
      this.complete();
      return;
    }
    this.fireEvents(this.eventTime, next);
    if (physics) applyPhysicsResets(anim, skeleton, this.eventTime, next);
    this._time = next;
    this.eventTime = next;
    this.pose(Physics.Update);
  }

  /**
   * Pose the skeleton at the current time (world transforms included).
   * `physics` defaults to {@link Physics.Pose}: physics bones keep their
   * current simulated offsets without stepping ({@link update} steps them).
   */
  pose(physics: Physics = Physics.Pose): void {
    this._poseVersion++;
    const mix = this.mixState;
    if (this.stateActive) {
      // The state was applied by update(); re-applying here would fire its events twice.
      const skeleton = this.skeleton;
      if (physics === Physics.Update) {
        skeleton.update(this.physicsDelta);
        this.physicsDelta = 0;
      }
      skeleton.updateWorldTransform(this.physics ? physics : Physics.None);
    } else if (mix) {
      // Outgoing pose first (physics not stepped for it), captured, then the incoming pose blended over it.
      this.poseAnimation(mix.from, mix.fromBaked, mix.fromTime, Physics.Pose);
      this.captureMixPose();
      this.poseAnimation(this.animation, this.bakedAnimation, this._time, physics);
      this.blendMixPose(mix.elapsed / mix.duration);
    } else {
      this.poseAnimation(this.animation, this.bakedAnimation, this._time, physics);
    }
    if (this.attachmentOverrides.size) {
      for (const [index, name] of this.attachmentOverrides) {
        const slot = this.skeleton.slots[index]!;
        const attachment = name === null ? null : this.skeleton.getAttachment(index, name);
        if (slot.attachment !== attachment) slot.setAttachment(attachment);
      }
    }
  }

  private poseAnimation(anim: AnimationData | null, baked: BakedAnimation | null, time: number, physics: Physics): void {
    const skeleton = this.skeleton;
    if (anim && baked) {
      // applyBakedPose writes every slot color: only attachments, deform and draw order need the reset.
      skeleton.setSlotsToSetupPose(baked.deform.length !== 0 ? bakedDeformSlots(baked, skeleton.slots.length) : null, false);
      applyDiscreteTimelines(anim, skeleton, time);
      applyBakedPose(baked, skeleton, time, this.bakedFlipY);
      return;
    }
    skeleton.setToSetupPose();
    if (anim) applyAnimation(anim, skeleton, time);
    if (physics === Physics.Update) {
      skeleton.update(this.physicsDelta);
      this.physicsDelta = 0;
    }
    skeleton.updateWorldTransform(this.physics ? physics : Physics.None);
  }

  private advanceMix(dt: number): void {
    const mix = this.mixState;
    if (!mix) return;
    mix.elapsed += dt;
    if (mix.elapsed >= mix.duration) {
      this.mixState = null;
      return;
    }
    const duration = mix.from.duration;
    mix.fromTime += dt;
    if (mix.fromTime > duration) mix.fromTime = mix.fromLoop && duration > 0 ? mix.fromTime % duration : duration;
  }

  private captureMixPose(): void {
    const { bones, slots } = this.skeleton;
    if (this.mixBones.length !== bones.length * 6) this.mixBones = new Float64Array(bones.length * 6);
    if (this.mixSlots.length !== slots.length * 7) this.mixSlots = new Float64Array(slots.length * 7);
    const b = this.mixBones;
    for (let i = 0, o = 0; i < bones.length; i++, o += 6) {
      const bone = bones[i]!;
      b[o] = bone.a;
      b[o + 1] = bone.b;
      b[o + 2] = bone.c;
      b[o + 3] = bone.d;
      b[o + 4] = bone.worldX;
      b[o + 5] = bone.worldY;
    }
    const s = this.mixSlots;
    this.mixDeforms.length = slots.length;
    for (let i = 0, o = 0; i < slots.length; i++, o += 7) {
      const slot = slots[i]!;
      s[o] = slot.color.r;
      s[o + 1] = slot.color.g;
      s[o + 2] = slot.color.b;
      s[o + 3] = slot.color.a;
      s[o + 4] = slot.darkColor?.r ?? 0;
      s[o + 5] = slot.darkColor?.g ?? 0;
      s[o + 6] = slot.darkColor?.b ?? 0;
      this.mixDeforms[i] = slot.deform.length ? slot.deform.slice() : null;
    }
  }

  /** Blend the captured outgoing pose into the current one: `alpha` 0 = outgoing, 1 = incoming. */
  private blendMixPose(alpha: number): void {
    const { bones, slots } = this.skeleton;
    const b = this.mixBones;
    for (let i = 0, o = 0; i < bones.length; i++, o += 6) {
      const bone = bones[i]!;
      const rx = lerpAngle(Math.atan2(b[o + 2]!, b[o]!), Math.atan2(bone.c, bone.a), alpha);
      const ry = lerpAngle(Math.atan2(b[o + 3]!, b[o + 1]!), Math.atan2(bone.d, bone.b), alpha);
      const fromSx = hypot2(b[o]!, b[o + 2]!);
      const fromSy = hypot2(b[o + 1]!, b[o + 3]!);
      const sx = fromSx + (hypot2(bone.a, bone.c) - fromSx) * alpha;
      const sy = fromSy + (hypot2(bone.b, bone.d) - fromSy) * alpha;
      bone.a = Math.cos(rx) * sx;
      bone.c = Math.sin(rx) * sx;
      bone.b = Math.cos(ry) * sy;
      bone.d = Math.sin(ry) * sy;
      bone.worldX = b[o + 4]! + (bone.worldX - b[o + 4]!) * alpha;
      bone.worldY = b[o + 5]! + (bone.worldY - b[o + 5]!) * alpha;
    }
    const s = this.mixSlots;
    for (let i = 0, o = 0; i < slots.length; i++, o += 7) {
      const slot = slots[i]!;
      const c = slot.color;
      c.r = s[o]! + (c.r - s[o]!) * alpha;
      c.g = s[o + 1]! + (c.g - s[o + 1]!) * alpha;
      c.b = s[o + 2]! + (c.b - s[o + 2]!) * alpha;
      c.a = s[o + 3]! + (c.a - s[o + 3]!) * alpha;
      const dark = slot.darkColor;
      if (dark) {
        dark.r = s[o + 4]! + (dark.r - s[o + 4]!) * alpha;
        dark.g = s[o + 5]! + (dark.g - s[o + 5]!) * alpha;
        dark.b = s[o + 6]! + (dark.b - s[o + 6]!) * alpha;
      }
      const from = this.mixDeforms[i];
      const deform = slot.deform;
      if (from && from.length === deform.length) for (let k = 0; k < deform.length; k++) deform[k] = from[k]! + (deform[k]! - from[k]!) * alpha;
    }
  }

  private canLoop(): boolean {
    if (this._loop === true) return true;
    if (typeof this._loop === 'number') return this.loopCount < this._loop;
    return false;
  }

  private complete(): void {
    if (this.completed) return;
    this.completed = true;
    for (const fn of this.completeListeners.slice()) fn(this);
    if (this.finishedStatus !== FinishedStatus.Pending) return;
    this.finishedStatus = FinishedStatus.Resolved;
    this.finishedResolve?.();
    this.finishedResolve = null;
    this.finishedReject = null;
  }

  /** Reject a pending {@link finished} (no-op once it resolved or rejected). */
  private rejectFinished(reason: string): void {
    if (this.finishedStatus !== FinishedStatus.Pending) return;
    this.finishedStatus = FinishedStatus.Rejected;
    this.finishedReason = reason;
    this.finishedReject?.(new Error(reason));
    this.finishedResolve = null;
    this.finishedReject = null;
  }

  /** Fire events with lastTime < time <= toTime (Spine's EventTimeline semantics). */
  private fireEvents(lastTime: number, toTime: number): void {
    const anim = this.animation;
    if (!anim || this.eventListeners.length === 0) return;
    for (const tl of anim.timelines) {
      if (tl.kind !== 'event') continue;
      collectEvents(tl, lastTime, toTime, (e) => {
        const data = this.skeleton.data.events.find((d) => d.name === e.name);
        const audioPath = data?.audioPath ?? null;
        const event: ClipEvent = {
          name: e.name,
          time: e.time,
          int: e.intValue,
          float: e.floatValue,
          string: e.stringValue,
          ...(audioPath ? { audio: { path: audioPath, volume: e.volume, balance: e.balance } } : {}),
        };
        for (const fn of this.eventListeners.slice()) fn(event, this);
      });
    }
  }

  private listenersFor(event: ClipEventType): unknown[] {
    switch (event) {
      case 'event':
        return this.eventListeners;
      case 'complete':
        return this.completeListeners;
      case 'loop':
        return this.loopListeners;
    }
  }
}

function collectEvents(tl: EventTimeline, lastTime: number, time: number, emit: (e: EventTimeline['events'][number]) => void): void {
  const times = tl.times;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (t > lastTime && t <= time) emit(tl.events[i]!);
  }
}

/** Interpolate angle `from` → `to` (radians) along the shorter arc. */
function lerpAngle(from: number, to: number, alpha: number): number {
  let d = to - from;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return from + d * alpha;
}

function setRotationTranslation(out: Matrix2D, radians: number, x: number, y: number): Matrix2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  out.a = cos;
  out.b = sin;
  out.c = -sin;
  out.d = cos;
  out.tx = x;
  out.ty = y;
  return out;
}

function hexToColor(hex: number, out: Color): void {
  out.r = ((hex >> 16) & 0xff) / 255;
  out.g = ((hex >> 8) & 0xff) / 255;
  out.b = (hex & 0xff) / 255;
}

/** State of the promise {@link Clip.finished} hands out for the last play(). */
const enum FinishedStatus {
  /** Nothing played (or reset): finished() resolves. */
  None,
  /** Playing: finished() waits for completion. */
  Pending,
  /** Completed. */
  Resolved,
  /** Restarted, stopped, switched to multi-track or reset before completing. */
  Rejected,
}
