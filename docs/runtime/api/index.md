# Tabula documentation

Tabula is a lean Spine runtime for slot/casino games on PixiJS: a
Pixi-agnostic **core** (playback, constraints, baking, rendering into a
sink), two thin bridges on one Pixi-free **shared layer** (the **Pixi v7
bridge** the games use, and a **Pixi v8 bridge** for WebGL2 and WebGPU),
and build tools (**tabula-tools**, a separate package: CLI, app, export
engine) that turn Spine 4.1/4.2 exports into compact binary files, baked
animations, repacked atlases, KTX2 textures and an asset manifest. Both bridges load the same files and draw the same pixels.

## What needs tabula-tools

The runtime (`tabula-pixi`) never depends on the build tools. On its own it
loads and plays raw Spine JSON + atlas, compiled `.tbin`, baked `.baked`,
`.tbla` bundles and every texture format below, and its core can write
`.tbin`, `.baked` and `.tbla` (pure code, no Node).

These need **tabula-tools** (`../tabula-tools`: the `tabula` CLI, the Tabula
app, the export engine), because they need image encoding (sharp) or the
native `ktx` encoder:

| Output | Command |
|---|---|
| repacked atlases (co-draw groups) | `tabula repack`, app export |
| resolution tiers (0.5×, 0.75×, 2× pages) | `tabula repack --tiers`, app export |
| KTX2 / Basis pages | `tabula repack --ktx2`, app export |
| SDF font atlases | `tabula font` |
| asset manifest from a folder | `tabula manifest`, app export |

The runtime plays all of them; the demo (`npm run demo`) does not build them.

## Start here

- [Tabula app and export](../../../tabula-tools/docs/app.md): the asset workflow from Spine exports to what the game loads.
- [Getting started](getting-started.md): install, build assets, load, play, mix, events, skins, tint / tint black, attachments, bounds and hit tests, unload.
- [Migrating from pixi-spine](migration-pixi-spine.md): every common pixi-spine call and its replacement.
- [Troubleshooting](troubleshooting.md): errors you may see and what to do.

## Recipes

- [Cascade / tumble symbols](recipes/cascade.md): sleeping views and a view pool for falling symbol stacks, with the benchmark against always-live views and pixi-spine.

## Guides (one per module)

| Page | Module | What it covers |
|---|---|---|
| [Core: Clip, Skeleton, animation](core.md) | `tabula-pixi` | `Clip` playback API, `Skeleton`/`Bone`/`Slot`, timelines, rendering into a `DrawSink`, headless use |
| [Pixi v7 bridge](pixi-v7.md) | `tabula-pixi` | `registerTabulaRenderer`, `createTabulaRuntime`, `ClipView` (sleeping views), `ClipViewPool`, `TabulaRenderer`, `loadTabulaAsset`, `unloadTabulaAsset`, batching stats, context loss |
| [Pixi v8 bridge](pixi-v8.md) | `tabula-pixi/pixi-v8` | Pixi 8 on WebGL2 and WebGPU: which bridge to use, setup, differences from v7, `TabulaPipe`, WebGPU notes, device loss, parity tests and benchmark, upgrading Pixi 8 |
| [Textures and KTX2](textures-ktx2.md) | both | resolution tiers, KTX2/Basis pages, worker transcoding, format choice, the KTX encoder |
| [Asset manifest and load groups](manifest.md) | both + CLI | `tabula manifest`, `TabulaAssetManager`, groups, progress, preload, unload, font languages (`setLanguage`) |
| [SDF text](text.md) | both + CLI | `tabula font` (incl. `--google`, `--lang`, `--charset-from`, fallback chains, per-language atlases), `SdfText`, styles and effects, rich text, number counters, runtime glyphs, multiple languages, benchmarks vs Pixi Text / BitmapText, migration |
| [AnimationState: multi-track playback](animation-state.md) | core | `clip.state`: tracks, layering, track alpha, additive blending, mix durations, queueing, empty animations, listeners, baked-clip behaviour, accuracy vs spine-core |
| [Constraints](constraints.md) | core | IK, transform, path and physics constraints, Spine 4.1 vs 4.2 semantics |
| [Baking](baking.md) | core + CLI | baked playback, error budgets, what is and is not baked |
| [The .tbin format](slb-format.md) | core + CLI | binary skeleton layout, versions, compatibility |
| [Hit testing and bounds](hit-testing.md) | core + bridge | bounding boxes, `hitTest`, Pixi pointer events, pose bounds, point transforms |
| [CLI reference](../../../tabula-tools/docs/cli.md) (tabula-tools) | `tabula` | every command and flag, with examples |
| [Tabula app and export](../../../tabula-tools/docs/app.md) (tabula-tools) | `tabula app`, `tabula-tools` | read, preview and export a project folder; raw and compressed assets together; export settings, deploy checklist, version policy |

## API reference (generated)

Every export with its signature, description, parameters, return value,
errors and examples, generated from the TSDoc in `src/` by
`npx tsx scripts/gen-api-docs.ts` (`--check` fails on undocumented exports):

- [reference/pixi-v7.md](reference/pixi-v7.md): `tabula-pixi` (47 bridge exports; the entry also re-exports core)
- [reference/pixi-v8.md](reference/pixi-v8.md): `tabula-pixi/pixi-v8` (49 bridge exports; also re-exports core)
- [reference/core.md](reference/core.md): `tabula-pixi` and `tabula-pixi/pixi-v8` (259 exports)
- [reference/adapters.md](reference/adapters.md): `tabula-pixi/json` (3 exports)

## Examples

[`docs/examples/`](../examples/README.md) holds the snippets the guides use.
They are typechecked and linted with the rest of the repo
(`npm run typecheck`, `npm run lint`), so they cannot drift from the API;
`docs/examples/v8/` against Pixi 8.

## Background

- [design.md](../design.md): architecture and decisions.
- [STATUS.md](../STATUS.md): what is done, measurements, open items.
- [feature-audit.md](../feature-audit.md): which Spine features the corpus uses and what is supported.
- [textures.md](../textures.md): texture build results (sizes, VRAM).
