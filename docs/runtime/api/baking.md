# Baking

Baking samples animations at build time into a compact `.baked` file. At
runtime a baked animation skips timeline evaluation and constraint solving:
the clip copies bone world matrices and slot colors from the samples.
Example: [`docs/examples/baking.ts`](../examples/baking.ts).

## Build

```sh
npx tabula compile assets/ -o public/assets --bake          # .tbin + .baked per skeleton
npx tabula bake assets/symbol1.json -o public/symbol1.baked  # one skeleton, with options
```

| Option | Default | Meaning |
|---|---|---|
| `--fps n` | smallest multiple of the authoring key rate ≥ 30 (24 fps keys → 48) | Base sample rate. |
| `--tolerance n` | 0.25 skeleton units | Extra samples are inserted where linear interpolation between samples deviates more than this from live (0 = base grid only). |
| `--max-error n` | 0.05 skeleton units | Compression error budget per vertex (0 = lossless). |
| `-a anim,anim` | all | Only these animations. |
| `--skin name` | default | Skin to bake with. Matters only when skins change bones: see [Skins](#skins). |
| `--no-report` | report on | Skip the per-animation error report. |

The report lists, per animation: encode error, color error and the vertex
error between samples vs live. Raise `--fps` or lower `--tolerance` if it warns.

## What is baked

| Baked (samples) | Evaluated from timelines at runtime |
|---|---|
| bone world matrices, slot light + dark colors | attachment switches, draw order, sequence frames, deform (mesh) keys, events |

So attachments, draw order and events switch at exactly the authored times.
Deform keys belong to a mesh of one skin, so they are evaluated live for the
mesh the current skin shows (as cheap as the baked lerp, and exact).
Between samples, rotation interpolates by angle and the rest linearly. Jumps
inside a sample interval (stepped keys, first key after setup pose) are located
at bake time and stored on both sides, so playback snaps across them.

Not baked: skeletons with **physics constraints** (always live, see
[constraints.md](constraints.md#physics)), animations not listed with `-a`.
Unbaked animations play live from the same clip; `clip.kind` tells which mode
is active.

## Runtime

```ts
const asset = await loadTabulaAsset('/assets/symbol1.tbin', { baked: '/assets/symbol1.baked' });
// or with the manifest: baked files load with their skeleton automatically
```

Baked data carries the skeleton hash; a mismatched file throws ("Baked data …
does not match skeleton … (hash mismatch)"). Skins, tint, attachment overrides
and crossfades work with baked animations. Bake with `yDown` matching the
renderer (default true); otherwise the clip flips it at load.

## Skins

Baked output looks the same as live in every skin. Bone matrices depend on the
skin only when a skin adds bones or constraints (skin-required bones, e.g.
weapons or accessories) or brings its own path attachment for a path
constraint. The `.baked` file (v5) records that state of the bake skin:

- Skins with the same state (most skins: they only swap images or meshes)
  play baked.
- Other skins play the same animation live from the same clip (`clip.kind` is
  `'live'`).
- To play every skin baked, bake once per state and pass all of them:
  `new Clip(data, { baked: [bakedA, bakedB] })`. The first bake whose state
  matches the current skin is used. The loaders load one `.baked` per
  skeleton.

`.baked` v3/v4 files still load. Their deform samples are ignored (deform plays
live), and they play baked only when no skin of the skeleton changes bones;
re-bake skeletons with skin-specific bones to play those skins baked.

## In code

| Function | What it does |
|---|---|
| `bakeSkeletonAnimations(data, { fps, yDown, skin, animations, tolerance })` | Sample animations → `BakedSkeletonData` (no animations for physics skeletons). |
| `canBakeSkeleton(data)` | False for skeletons with physics. |
| `serializeBakedData(baked, bakeEncoding(data, maxError)?)` | Encode; without encoding (or `maxError` 0) the samples round-trip exactly. Returns an `ArrayBuffer`. |
| `deserializeBakedData(bytes)` | Decode (v3–v5); throws on bad magic or version. |
| `bakedPoseOf(skeleton)`, `bakedPoseMatches(pose, skeleton)` | The skin state a bake was made in, and whether a skeleton's current skin matches it. |
| `autoBakeFps(data)`, `detectKeyFrameRate(data)` | The default sample rate logic. |
| `applyBakedPose`, `applyDiscreteTimelines`, `applyLiveDeform`, `liveDeformSlots`, `bakedFrameTime`, `bakedSampleBefore` | Playback building blocks. |

Size on the test corpus (`npm run report:bake`): 26.6 MiB dense float32 → 1.76 MiB (0.83 MiB gzipped) at the default budget.
