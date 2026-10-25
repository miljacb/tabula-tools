# AnimationState: multi-track playback

`clip.play()` plays one animation at a time (with an optional crossfade) and is
the fast path for baked playback. When a skeleton needs **layers** (a base
animation with overlays such as blinking, aiming or breathing), **queues**
(play A, then B, then loop C), **per-pair mix durations**, **additive
blending** or **per-entry callbacks**, use the clip's `AnimationState`:
`clip.state`. It is a port of spine-core's `AnimationState` and produces the
same poses and callbacks (see [Accuracy](#accuracy)).

Example: [`docs/examples/animation-state.ts`](../examples/animation-state.ts).
Generated reference: [`AnimationState`](reference/core.md#animationstate),
[`TrackEntry`](reference/core.md#trackentry),
[`AnimationStateData`](reference/core.md#animationstatedata).

```ts
const clip = view.clip;
clip.state.data.defaultMix = 0.2;                  // crossfade every change by 0.2 s
clip.state.data.setMix('idle', 'run', 0.3);        // except this pair
clip.state.setAnimation(0, 'idle', true);          // track 0: base layer
clip.state.setAnimation(1, 'blink', true).alpha = 0.7; // track 1: overlay at 70 %
clip.state.addAnimation(0, 'run', true, 0);        // queued after idle's current loop
```

## Single-track and multi-track mode

| | `clip.play(name, opts)` | `clip.state` |
|---|---|---|
| Animations at once | 1 (+ the one it crossfades from) | any number of tracks, each with its own queue |
| Crossfade | world-space blend of two poses (`opts.mix`) | spine-core mixing: per-timeline, per-pair durations, interrupt handling |
| Baked samples | used when loaded | **never**: timelines are always evaluated live |
| Events | `clip.on('event' / 'loop' / 'complete')`, `finished()` | state and entry listeners; authored events are also sent to `clip.on('event')` |
| Pose each frame | starts from the setup pose | spine semantics: properties no track keys keep their last value |

The **first access** to `clip.state` switches the clip to multi-track mode:
the single-track animation stops and its `finished()` promise rejects with
`"Switched to multi-track mode"`. From then on `clip.update(dt)` runs
`state.update(dt * clip.speed)`, `state.apply(skeleton)`, steps physics and
updates world transforms. `clip.play()` or `clip.stop()` switch back to
single-track mode and clear the tracks, which fires their `end` and `dispose`
callbacks. `clip.multiTrack` tells which mode is active.

These keep working in multi-track mode: `clip.speed` (scales the whole
state), `pause()` / `resume()`, `setAttachment()` / `clearAttachment()`
(an override wins over attachment keys; clearing it restores the setup
attachment), `setSkin()`, tint, bounds, hit tests, `getPointTransform()` and
physics. `clip.playing` is true while any track has an entry and the clip
is not paused. `seek()`, `skipToEnd()`, `time`, `duration`, `loop` and
`finished()` apply to single-track playback only. In multi-track mode, use
`entry.trackTime` and listeners instead.

### Baked clips

Multi-track mode always evaluates timelines live, even when the clip was
created with `{ baked }`. Mixing, track alpha and additive layers combine
several animations per timeline and can't be read from per-animation
samples. A baked skeleton uses its samples again as soon as you return to
`clip.play()`. Costs measured on the build box, per `clip.update()`:

| Skeleton (bones, timelines of the animation) | `play()` baked | `state`, 1 track | `state`, 2 tracks |
|---|---|---|---|
| symbol15 (13 bones) | 9.4 µs | 9.4 µs | 13.7 µs |
| reelLandscape (7 bones) | 6.2 µs | 4.4 µs | 6.9 µs |
| megaWinGradingLandscape (52 bones, 172 timelines) | 15.7 µs | 13.7 µs | 27.7 µs |

Physics skeletons never play baked in either mode.

## Tracks and layering

Tracks are applied in index order every frame. Track 0 is the base: it
replaces the pose. A higher track is applied over the result of the
lower ones, for the properties its animation keys:

- **`entry.alpha`** (0–1): how much of the entry is applied. `0.5` shows half
  of the overlay over the lower tracks.
- **`entry.mixBlend = MixBlend.add`**: additive layer. Keyed values are
  *added* to the lower tracks (times `alpha`) instead of replacing them, e.g.
  breathing on top of whatever the base plays. It is ignored on track 0.
- Properties an entry does not key are left to the lower tracks.

```ts
import { MixBlend } from 'tabula-pixi';

clip.state.setAnimation(0, 'run', true);
const aim = clip.state.setAnimation(1, 'aim', true);    // keys only the arm bones
aim.alpha = 0.8;
const breathe = clip.state.setAnimation(2, 'breathe', true);
breathe.mixBlend = MixBlend.add;
breathe.alpha = 0.5;
```

To fade a layer out, mix to the empty animation instead of clearing the
track. `clearTrack()` cuts at once and leaves the last pose of the keyed
properties in place:

```ts
clip.state.setEmptyAnimation(1, 0.25);     // fade track 1 out over 0.25 s
clip.state.addEmptyAnimation(2, 0.5, 1);   // queue a fade-out 1 s after the current entry starts
clip.state.setEmptyAnimations(0.2);        // fade every track out
```

## Mixing

Changing a track's animation with `setAnimation` crossfades from the current
entry over the mix duration:

1. `entry.mixDuration` if you set it right after `setAnimation` / `addAnimation`,
2. otherwise `state.data.setMix(from, to, seconds)` for that pair (names are checked),
3. otherwise `state.data.defaultMix` (default 0: a cut).

Interrupting a mix in progress is handled like spine-core: the partially
mixed pose is kept (`interrupt` fires for the replaced entry), and timelines
the next animation also keys are held so nothing snaps back to the setup
pose. `entry.holdPrevious = true` keeps the previous animation fully applied
under the mix instead of fading it out. Use it on a higher track when a lower
track keys the same property, so the value doesn't dip toward the lower
track halfway through the mix. `entry.shortestRotation = true` mixes rotations the short way every
frame instead of tracking the direction chosen on the first frame.

## Queueing

`addAnimation(track, name, loop, delay)` queues an entry after the track's
last one:

- `delay > 0`: seconds after the previous entry **starts**.
- `delay <= 0`: when the previous entry **completes** (end of its current
  loop for a looping one), minus the mix duration, plus `delay`. `0` means the
  mix finishes exactly as the previous animation ends.
- On an empty track, the entry starts after `delay` seconds.

`setAnimation` replaces the current entry and drops anything queued on that
track (`dispose` fires for the dropped entries).

## TrackEntry fields

Set them right after `setAnimation` / `addAnimation`:

| Field | Default | Effect |
|---|---|---|
| `loop` | from the call | Loop between `animationStart` and `animationEnd`. |
| `timeScale` | 1 | Speed of this entry (0 freezes it). `state.timeScale` and `clip.speed` scale everything. |
| `alpha` | 1 | Strength of this entry over lower tracks. |
| `mixBlend` | `MixBlend.replace` | `MixBlend.add` for additive layers (ignored on track 0). |
| `mixDuration` | from `AnimationStateData` | Crossfade duration from the previous entry. |
| `delay` | from `addAnimation` | Seconds before a queued entry starts. |
| `trackEnd` | ∞ | Track time at which the entry stops being applied (the next queued entry or nothing takes over). |
| `animationStart`, `animationEnd` | 0, duration | Play a sub-range; loops wrap inside it. |
| `reverse` | false | Play backwards (events are not fired while reversed). |
| `holdPrevious` | false | Keep the previous entry fully applied during the mix. |
| `shortestRotation` | false | Mix rotations the short way every frame. |
| `eventThreshold` | 0 | While mixing out, events of this entry still fire until the mix reaches this fraction. |
| `mixAttachmentThreshold`, `alphaAttachmentThreshold`, `mixDrawOrderThreshold` | 0 | When attachment and draw-order keys of a mixing-out or low-alpha entry still apply (spine-core semantics; 4.1 data uses 4.1's `attachmentThreshold` / `drawOrderThreshold` rules). |
| `listener` | null | Callbacks for this entry only (see below). |

Read-only state: `trackTime`, `animationLast`, `mixTime`, `mixingFrom`,
`mixingTo`, `next`, `previous`, `trackIndex`, `getAnimationTime()`,
`isComplete()`, `getTrackComplete()`.

## Listeners

```ts
clip.state.addListener({
  start: (entry) => {},     // entry became current (after its delay)
  interrupt: (entry) => {}, // another entry replaced it (may still be mixing out)
  complete: (entry) => {},  // reached its end (every loop for looping entries)
  end: (entry) => {},       // will not be applied again
  dispose: (entry) => {},   // released (after end, or dropped from a queue)
  event: (entry, event) => {}, // an authored event key, as a ClipEvent (name, time, int, float, string, audio)
});
const win = clip.state.setAnimation(0, 'win', false);
win.listener = { complete: () => clip.state.setAnimation(0, 'idle', true) };
```

Callbacks run synchronously inside `clip.update()` (and inside
`setAnimation` / `clearTrack` calls for interrupt, end and dispose), in
spine-core's order: an entry's own listener first, then the state listeners.
Calling `setAnimation` or `addAnimation` from a callback is allowed.
Authored events also go to `clip.on('event')` listeners in multi-track
mode. `complete` is reported through state or entry listeners, not through
`clip.on('complete')`.

## Without a Clip

`AnimationState` works on any Tabula `Skeleton`, for example for headless
checks or a custom renderer:

```ts
import { AnimationState, AnimationStateData, Skeleton } from 'tabula-pixi';

const skeleton = new Skeleton(data);
const state = new AnimationState(new AnimationStateData(data));
state.setAnimation(0, 'idle', true);
// each frame:
state.update(dt);
state.apply(skeleton);
skeleton.updateWorldTransform();
```

## Spine 4.1 and 4.2

spine-core changed parts of `AnimationState` between 4.1 and 4.2: when a mix
counts as applied, attachment and draw-order thresholds, the rotation-mix
direction formula, loop completion detection, delay clamping, and whether
sequence keys reset when mixing out. Tabula follows the version the
skeleton was exported as, like the [constraints](constraints.md).

## Accuracy

`tests/animation-state.test.ts` runs the same scripted calls on Tabula and
on the official spine-core `AnimationState` (4.1.56 for 4.1 data, 4.2.120 for
4.2 data) and compares, **every frame**, all bone world transforms, slot
colors, attachments, draw order and vertices, plus the exact sequence of
listener callbacks. The scenarios cover crossfades and queues, interrupting
a mix during a mix, layered tracks with alpha and additive blending,
mixing out to empty animations, delays, `reverse`, `holdPrevious`,
`animationStart`, `trackEnd`, `shortestRotation`, `eventThreshold`, entry
listeners and clearing tracks. They run on every test skeleton with two or
more animations (41 skeletons) plus a synthetic rig with IK, transform
constraint and physics timelines, dense events and dark colors. That is
81,560 compared frames and 9,592 callbacks in total across 4.1 and 4.2,
including entries started from inside callbacks. All of
them match, with one documented exception. On one frame of one layered
scenario, bezier evaluation rounds about 10⁻⁷° differently, so spine-core
computes a rotation difference of 3.6·10⁻¹⁵ where Tabula gets exactly 0.
Tabula then takes the `diff == 0` branch of the mixed-rotation code, and
one bone chain is off by up to 0.26° for 7 frames before converging again.
The test pins that case exactly.
`tests/clip-state.test.ts` checks the `clip.state` integration (baked to
live and back, events, speed, pause, attachment overrides, and physics
against spine-core 4.2).

## Differences from spine-core

- `TrackEntry` objects are not pooled or reused, so keeping a reference after
  `dispose` is safe (but the entry is dead).
- Event callbacks receive a `ClipEvent` (`name`, `time`, `int`, `float`,
  `string`, `audio`) instead of spine's `Event`.
- Constraint orders: spine-core silently skips a constraint whose `order`
  duplicates another's. Spine never exports that, and Tabula updates both.
