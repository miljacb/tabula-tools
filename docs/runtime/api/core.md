# Core: Clip, Skeleton, animation

```ts
import { Clip, Skeleton, loadSkeletonBinary } from 'tabula-pixi';
```

The core has no Pixi or DOM dependency. It loads skeleton data, poses it
(live from timelines or from baked samples), runs constraints, and emits
triangles into any `DrawSink`. The Pixi bridges ([pixi-v7.md](pixi-v7.md),
[pixi-v8.md](pixi-v8.md)) are thin layers over it, sharing a Pixi-free
middle layer (`src/shared`). Both entries re-export this API. Example: [`docs/examples/core-headless.ts`](../examples/core-headless.ts).
Full signatures: [reference/core.md](reference/core.md).

## Loading data

| Function | What it does | Returns / throws |
|---|---|---|
| `loadSkeletonBinary(bytes)` | Parse a `.tbin` (from `tabula compile`). Typed arrays are views into `bytes` (copied once if unaligned). | `{ header, data: SkeletonData, atlas: AtlasData \| null }`. Throws on a bad magic or an unsupported format/IR version. |
| `readSlbHeader(bytes)` | Read only the header (name, hash, source Spine version, format/IR version, flags). | `SlbHeader`; same errors. |
| `deserializeBakedData(bytes)` | Decode a `.baked` file to dense samples. | `BakedSkeletonData`; throws on bad magic/version. |
| `SpineJsonParser#parse(json, name)` / `AtlasParser#parse(text)` (from `tabula-pixi/json`) | Parse Spine 4.1/4.2 JSON and atlas text at runtime. | `SkeletonData` / `AtlasData`; throws on other Spine versions. |

```ts
const { data, atlas } = loadSkeletonBinary(await (await fetch('/assets/symbol1.tbin')).arrayBuffer());
```

### Loading Spine JSON directly

`loadTabulaJson(url)` and the Pixi `Assets` parser in `tabula-pixi/json`
([pixi-v7.md](pixi-v7.md#pixi-assets-existing-asset-lists-cdn-and-cloud-urls));
building the asset by hand: [`docs/examples/json-runtime.ts`](../examples/json-runtime.ts).
It ships the ~14 KB adapter and parses JSON; a compiled `.tbin` is ~24% of the
JSON + atlas size and loads ~18× faster.

## Clip

`new Clip(data, options?)` owns a `Skeleton` and plays one animation at a time
(with an optional crossfade from the previous one), or several tracks through
`clip.state`, spine-core's `AnimationState` ([animation-state.md](animation-state.md)).

| `ClipOptions` | Default | Meaning |
|---|---|---|
| `yDown` | `true` | Pose for a y-down renderer (Pixi). Views always use `true`. |
| `baked` | none | `BakedSkeletonData`; animations found in it play baked, the rest live. Throws if its hash does not match `data`. |
| `skin` | default skin | Initial skin: a name, or names to combine (`['10', 'explode']`). |
| `physics` | `true` | Simulate physics constraints in `update()`; `false` poses physics bones without simulation. |

### Playback

| Member | What it does |
|---|---|
| `play(name?, { loop, speed, from, mix })` | Start `name` (or restart the current animation). `loop`: `true` / number of extra repeats / `false`; `speed`; `from` seconds; `mix` crossfade seconds. `loop` and `speed` carry over when omitted. Throws if the animation does not exist. Returns `this`. |
| `stop()` | Back to the setup pose, no animation. Rejects `finished()`. |
| `pause()` / `resume()` | Freeze / continue time (physics keeps settling while paused). |
| `seek(time, fireEvents = false)` | Jump (clamped to `[0, duration]`). With `fireEvents`, events between the current and target time fire (forward only). |
| `skipToEnd(fireEvents = false)` | Jump to the end and complete (turbo / quick stop). |
| `update(dt)` | Advance by `dt` seconds × `speed`, fire events, pose. Views call it from the ticker. |
| `pose(physics?)` | Re-pose at the current time without advancing (rarely needed). |
| `finished()` | Promise: resolves on completion of a non-looping animation; rejects ("Animation restarted"/"stopped") if replaced or stopped. |
| `time` (get/set), `speed`, `loop` | Current time (setting it seeks without events), rate, loop mode. |
| `duration`, `animationName`, `playing`, `kind`, `mixing` | Current animation's length, name, whether it is advancing, `'baked'`/`'live'`, crossfade in progress. |
| `animationNames`, `hasAnimation(name)` | Animations of the skeleton. |
| `state` | Multi-track `AnimationState` (first access switches to multi-track mode; `play()` / `stop()` switch back). Always live. See [animation-state.md](animation-state.md). |
| `multiTrack` | True while the clip plays through `state`. |

```ts
const clip = new Clip(data, { baked });
clip.play('symbolWin', { loop: false, speed: 1.25 });
clip.update(1 / 60);
await clip.finished();
clip.play('symbolIdle', { loop: true, mix: 0.25 });
```

### Events

| Member | What it does |
|---|---|
| `on('event', (e: ClipEvent, clip) => …)` | Authored event keys: `e.name`, `e.time`, `e.int`, `e.float`, `e.string`, `e.audio?` (`path`, `volume`, `balance`). |
| `on('loop', (clip) => …)` | Each loop wrap-around. |
| `on('complete', (clip) => …)` | End of a non-looping animation (also `skipToEnd`). |
| `off(type, fn)` | Remove a listener. |

Events fire when `lastTime < t <= time`, synchronously inside `update`/`seek`.
Keys at the loop boundary fire on every loop. During a crossfade only the new
animation fires events.

### Appearance

| Member | What it does |
|---|---|
| `setSkin(name \| names)` | Change skin, keep the pose. Several names show those skins together (later names win on the same attachment; built once per skeleton, shared). Throws naming the unknown skin. |
| `setAttachment(slot, name \| null)` | Override what a slot shows (active skin, then default skin; `null` hides) until cleared. Throws for an unknown slot or attachment. |
| `clearAttachment(slot?)` | Remove one override, or all. |
| `setTint(light, dark = 0xffffff)` | Whole-clip light multiplier and dark multiplier (two-color slots). 0xRRGGBB. |
| `tint`, `darkTint` | The multipliers as `Color` objects (straight RGBA 0–1); write `tint.a` for alpha. |

### Queries

| Member | What it does |
|---|---|
| `getPointTransform(name, out)` | Skeleton-space transform of a point attachment named `name`, else of the bone `name` (identity if neither). Writes into `out: Matrix2D`. |
| `hitTest(x, y)` | Topmost visible bounding box containing the skeleton-space point, or null ([hit-testing.md](hit-testing.md)). |
| `getBoundingBoxes()` | World polygons of the visible bounding boxes. |
| `resetPhysics()` | Restart physics from the current pose ([constraints.md](constraints.md)). |
| `skeleton` | The posed `Skeleton`. |

## Combined skins

| Function | What it does |
|---|---|
| `defineSkin(assetOrData, name, parts)` | Name a combination of skins on a skeleton (or its asset), usable wherever a skin name goes; define as many as you like. A part may be an earlier `defineSkin` name (not a later one: it must exist when this is called). Same name and parts again: no-op; other parts, or an exported skin's name: throws. |
| `resolveSkin(assetOrData, nameOrNames)` | The `SkinData` a selector means (exported, defined, or combined and cached), or null. |
| `definedSkins(assetOrData)` | Names given with `defineSkin`. |

The combined `SkinData` holds the parts' attachment objects (no copies) and
the union of their skin-required bones and constraints. It lives as long as
the skeleton data; reloading an asset needs the definitions again (the
loaders' `skins` option does that).

## Skeleton, Bone, Slot

`clip.skeleton` exposes the posed state. Usually you only read it.

| Member | What it does |
|---|---|
| `findBone(name)`, `findSlot(name)` | Look up by name (null if missing). |
| `findIkConstraint` / `findTransformConstraint` / `findPhysicsConstraint(name)` | Constraint instances. |
| `bones`, `slots`, `drawOrder`, `skin`, `data` | Arrays in setup order, current draw order, active skin, the `SkeletonData`. |
| `ikConstraints`, `transformConstraints`, `pathConstraints`, `physicsConstraints` | Constraint instances. |
| `setSkin(name \| names)`, `getAttachment(slotIndex, name)` | Skin switch, combined for several names (returns false if a name is unknown), and attachment lookup (skin, then default skin). |
| `setToSetupPose()`, `setBonesToSetupPose()`, `setSlotsToSetupPose()` | Reset local state. |
| `updateWorldTransform(physics = Physics.Pose)` | Recompute world transforms (and constraints) from local values. |
| `update(delta)`, `physicsTranslate(x, y)`, `physicsRotate(x, y, degrees)` | Advance physics time; tell physics the skeleton moved. |
| `x`, `y`, `scaleX`, `scaleY`, `yDown`, `time`, `hasPhysics`, `semantics41` | Root placement, conventions, physics clock, whether the data is Spine 4.1 (4.1 constraint semantics). |

`Bone`: local `x, y, rotation, scaleX, scaleY, shearX, shearY`; world matrix
`a, b, c, d, worldX, worldY`; `worldRotationX`, `worldScaleX`. `Slot`:
`color`, `darkColor` (null unless two-color tint), `attachment`, `bone`,
`deform`, `blendMode`.

Every pose starts from the setup pose, so manual bone edits are replaced by
the next `update()`. To drive a bone yourself, change it after the clip
updated and recompute:

```ts
app.ticker.add(() => {
  const bone = view.clip.skeleton.findBone('aim')!;
  bone.rotation = angle;
  view.clip.skeleton.updateWorldTransform();
}, undefined, UPDATE_PRIORITY.LOW); // after the runtime's update (NORMAL priority)
```

For animation-driven aiming, prefer an IK constraint and move its target bone this way.

## Animation functions

Low-level building blocks `Clip` uses (for custom players):

| Function | What it does |
|---|---|
| `applyAnimation(anim, skeleton, time)` | Apply every timeline of `anim` at `time` over the current pose (setup-pose based). |
| `applyPhysicsResets(anim, skeleton, from, to)` | Reset physics constraints keyed in `(from, to]`. |
| `applyBakedPose(baked, skeleton, time, flipY)` | Write baked world matrices, colors, deforms. |
| `applyDiscreteTimelines(anim, skeleton, time)` | Attachments, draw order, sequences (the part of an animation baking does not store). |
| `new AnimationState(new AnimationStateData(data))` | Multi-track player for any `Skeleton`: `update(dt)`, `apply(skeleton)`, then `skeleton.updateWorldTransform()`. |

## Rendering into a sink

```ts
const renderer = new SkeletonRenderer<MyTexture>();
renderer.draw(clip.skeleton, resolve, sink, clip.tint, clip.darkTint);
```

- `resolve: RegionResolver<T>` maps a region path to `{ region, texture }` (null = missing; reported once in `renderer.missingRegions`).
- `sink.drawTriangles(texture, blendMode, positions, uvs, vertexCount, indices, indexCount, colors)` receives skeleton-space triangles; `colors: TintColors` are premultiplied light and dark colors. Clipping attachments are applied before the sink.
- `RunPlanner` plans the batches of a run (overlap-aware ordering); `BatchCounter` predicts draw calls for a sequence of draws with the same rules; `VertexWriter` / `IndexWriter` write the lean vertex format (`LEAN_VERTEX_STRIDE`); `generateTabulaFragmentShader(n)` and `LEAN_VERTEX_SHADER` are the shaders. These are what `TabulaRenderer` is built from.

## Model types

`SkeletonData`, `BoneData`, `SlotData`, `SkinData`, attachment types
(`RegionAttachment`, `MeshAttachment`, `ClippingAttachment`,
`BoundingBoxAttachment`, `PathAttachment`, `PointAttachment`), timelines and
constraint data are the version-independent model every adapter produces
(`IR_VERSION`). They are documented field by field in
[reference/core.md](reference/core.md#srccoretypests).
