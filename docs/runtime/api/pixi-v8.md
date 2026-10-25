# Pixi v8 bridge (`tabula-pixi/pixi-v8`)

```ts
import { registerTabulaRenderer, createTabulaRuntime, loadTabulaAsset } from 'tabula-pixi/pixi-v8';
```

Tabula for PixiJS v8, on **WebGL2 and WebGPU**. Same core, same compiled
files (`.tbin`, `.baked`, KTX2 pages, manifests, fonts), same API as the
Pixi v7 bridge wherever Pixi allows. Full signatures:
[reference/pixi-v8.md](reference/pixi-v8.md).

## Which bridge?

| | `tabula-pixi` (Pixi v7) | `tabula-pixi/pixi-v8` (Pixi v8) |
|---|---|---|
| Pixi version | 7.x | **8.21.x** (pinned, see [Upgrading Pixi 8](#upgrading-pixi-8)) |
| GPU APIs | WebGL1, WebGL2 | WebGL2, WebGPU (Pixi 8 has no WebGL1) |
| Rendering | `TabulaRenderer` (an `ObjectRenderer` plugin) | `TabulaPipe` (a render pipe) |
| Views | `ClipView`, `SdfText` extend `Container` | `ClipView`, `SdfText` extend `ViewContainer` |
| Games | all current games | none planned; kept ready and tested |

A game uses exactly one of them: the one matching its Pixi version. Both
are in the same package and share everything that does not touch Pixi
([design.md §16](../design.md#16-pixi-v8-bridge-implemented-2026-10-15)), so a fix or a
feature in the core, the CLI or the shared layer reaches both.

## Install

The package's peer dependency accepts either Pixi:
`"pixi.js": "^7.0.0 || ~8.21.0"`. A Pixi 8 game installs `pixi.js@8.21.x`
and imports from `tabula-pixi/pixi-v8` (and `tabula-pixi/pixi-v8/json` for
Spine JSON at runtime). Nothing from the v7 entry is loaded.

## Setup

| Function | What it does | Notes |
|---|---|---|
| `registerTabulaRenderer(options?)` | Register the `tabula` render pipe (idempotent). `maxTextures` caps texture units per batch; `reorder: false` draws runs in plain order. | Call **before** `app.init()`; otherwise `createTabulaRuntime` throws "call registerTabulaRenderer() before app.init()". |
| `createTabulaRuntime(app)` | Runtime for an **initialised** app (after `await app.init()`): advances views and texts from `app.ticker`. | Builds the shader up front. |
| `runtime.createView`, `runtime.pool`, `runtime.createText`, `runtime.update`, `runtime.timeScale`, `runtime.viewCounts`, `runtime.stats`, `runtime.destroy` | Same as v7 ([pixi-v7.md](pixi-v7.md#setup)). | |
| `runtime.pipe` | The `TabulaPipe` of the app's renderer. | New in v8 (v7: `renderer.plugins.tabula`). |

```ts
registerTabulaRenderer();
const app = new Application();
await app.init({ width: 1280, height: 720, preference: 'webgpu' }); // or 'webgl'
const runtime = createTabulaRuntime(app);
const asset = await loadTabulaAsset('/assets/symbol1.tbin', { baked: '/assets/symbol1.baked' });
app.stage.addChild(runtime.createView(asset).play('symbolIdle', { loop: true }));
```

Typechecked example: [examples/v8/getting-started.ts](../examples/v8/getting-started.ts).

`preference: 'webgpu'` falls back to WebGL2 where WebGPU is not available
(Pixi decides; `app.renderer.name` tells which one runs).

## Same as v7

Everything below behaves as documented for v7, with the same names and options:

- `ClipView`: `play`, `sleep` / `wake` / `sleepOnComplete`, `update`,
  `autoUpdate`, `clip`, `asset`, `hitTest(globalPoint)`, `getPoseBounds`,
  `frozenByteSize` ([pixi-v7.md](pixi-v7.md#clipview), [sleeping views](pixi-v7.md#sleeping-views)).
- `ClipViewPool` and `runtime.pool` ([view pool](pixi-v7.md#view-pool)).
- `SdfText`, `loadSdfFont`, `unloadSdfFont`, `enableRuntimeGlyphs`,
  `textsUsingFont`, `whenFontUnused` ([text.md](text.md)).
- `loadTabulaAsset`, `unloadTabulaAsset`, `createTabulaAsset`,
  `loadAtlasTextures`, `loadPageTexture`, `deviceTextureHints`
  ([loading](pixi-v7.md#loading)), with `TextureSource` where v7 has `BaseTexture`.
- `TabulaAssetManager` with load groups, preload, font languages ([manifest.md](manifest.md)).
- `tabulaAssetsExtension` (Pixi `Assets` parser for `.tbin`) and, from
  `tabula-pixi/pixi-v8/json`, `tabulaJsonAssetsExtension` / `loadTabulaJson`
  ([Pixi Assets](pixi-v7.md#pixi-assets-existing-asset-lists-cdn-and-cloud-urls)).
- KTX2 pages with Web Worker transcoding, tiers and fallbacks ([textures-ktx2.md](textures-ktx2.md)).
- Batching: consecutive Tabula views and texts form one run, uploaded once
  and drawn as few batches as blend states and texture units allow, with
  overlap-aware reordering (same pixels as drawing in order).
- The core API, re-exported from the entry ([core.md](core.md)).

## Differences from v7

These follow Pixi 8 itself; each is covered by `tests/v8/`.

| Topic | Pixi v7 bridge | Pixi v8 bridge |
|---|---|---|
| Init | `registerTabulaRenderer()` before `new Application()` | before `await app.init()`; `createTabulaRuntime(app)` after it |
| Tint | `view.clip.setTint(...)` (Container tint does not exist) | `clip.setTint` **and** Container `tint`, inherited from parents (Pixi 8 semantics): the clip tint is multiplied by the view's group color |
| Alpha | `worldAlpha` | the view's group alpha (render group alpha is applied by Pixi's global uniforms) |
| Children | a `ClipView` / `SdfText` can have children | they cannot (Pixi 8 `ViewContainer`s do not): put the view and its followers in a `Container` |
| `containsPoint(p)` | `p` is a global point | `p` is a **local** point (Pixi 8's hit-test contract). `hitTest(globalPoint)` takes a global point in both |
| `SdfText.tint` | own field, multiplied into the text layers | the Container tint (inherited); same visual result for a text without tinted parents |
| Texture type | `BaseTexture` | `TextureSource` (`asset.textures`, fonts, `createTabulaAsset`) |
| Renderer access | `renderer.plugins.tabula` (`TabulaRenderer`) | `renderer.renderPipes.tabula` / `runtime.pipe` (`TabulaPipe`) |
| Pool reset | v7 properties | also resets `tint`, `blendMode` (`'inherit'`), `label`, `eventMode` (`'passive'`) |
| Spine JSON entry | `tabula-pixi/json` | `tabula-pixi/pixi-v8/json` |
| PVRTC pages | used on devices that only have PVRTC | never (Pixi 8 has no PVRTC format): such devices get RGBA8 |

## TabulaPipe

The render pipe. You rarely touch it directly.

| Member | What it does |
|---|---|
| `lastFrameStats` / `stats` | Last completed frame / frame in progress: `drawCalls`, `vertices`, `triangles`, `batchBreaks`. |
| `maxTextures` | Units per batch in use: min(renderer limit, 8, `maxTexturesOverride`). |
| `reorder` | Overlap-aware batch ordering (default true). |
| `uploadSlots` | Vertex/index buffer pairs created (one per run of the busiest frame). |
| `TabulaPipe.maxTexturesOverride`, `TabulaPipe.reorderDefault` | Statics set by `registerTabulaRenderer`. |

How it works: Pixi 8 builds an instruction list per render group. The pipe
turns consecutive Tabula renderables into one *run* instruction (Pixi's own
batch is closed before it; anything Pixi draws in between starts a new run).
At execute time the run's views draw into the shared run builder (the same
code as the v7 renderer), which plans batches, uploads once and issues one
draw call per batch. Positions are written in render-group space; the render
group's transform and color come from Pixi's global uniforms, as for Pixi's
own sprites. Views never trigger an instruction rebuild by animating.

## WebGPU notes

- **Same pixels as WebGL2**, except rows along triangle edges that fall
  exactly on pixel centers: WebGPU's y axis points the other way, so the
  rasterizer's tie rule takes the row on the other side of such an edge.
  Pixi's own sprites do the same. `npm run test:parity` allows 0.2 % of
  pixels for it (measured: 0.011 % at most).
- **Each run gets its own buffers in a frame.** WebGPU applies every buffer
  write of a frame before any of its draws, so a buffer reused by two runs of
  one frame would draw the second run's data twice. Slots are reused only
  from the next frame on and never within one (tested).
- **Compressed pages need a 4×4-aligned size on WebGPU**; others are
  transcoded to RGBA8 (`compressedTextureSupportFor(renderer, w, h)`).
  Formats come from the device's features (`texture-compression-astc`,
  `-bc`, `-etc2`), which Pixi requests when available.
- **Texture units**: up to 8 per batch, as on WebGL (the WebGPU limit is 16).

## Context and device loss

Nothing to set up. Pixi 8 restores both a lost WebGL context (and, unlike
Pixi 7, re-enables its extensions itself) and a lost WebGPU device (it
requests a new device), then re-uploads textures, buffers and programs. The
pipe rebuilds its shader only if the new context has a different
texture-unit limit. `npm run test:parity` loses and restores the context or
device in three scenes on each path (PNG, SDF text, KTX2 ASTC pages) and
requires identical pixels afterwards.

## Verification

| Command | What it checks |
|---|---|
| `npm test` | `tests/v8/` (project `v8`, `pixi.js` = Pixi 8): runs and upload slots, WebGL vs WebGPU batches, call order for Pixi's WebGPU caches, inherited tint/alpha, bounds, hit tests, pool reset, runtime loop, text, KTX2 support and loading, asset loading and reference counting |
| `npm run test:parity` | Chromium: 7 scenes (grid, blend, text, sleep, runs, units2, skins) rendered by v7, v8 WebGL2 and v8 WebGPU, compared pixel by pixel; v8 with reordering off on both backends; context / device loss |
| `npm run bench:bridges` | The same 98-symbol cascade on all three paths: update and render CPU time, frame interval, draw calls |
| `npm run demo:v8` | Dev server for the parity pages: `/parity/parity.html?bridge=v8&renderer=webgpu&scene=grid&animate=1` shows any scene live (`scene=skins`: combined skins, live, baked and asleep) |

Measured 2026-10-15 (Mac M4, Chromium, Metal; results in
[`bench-results/reference/2026-10-15-bridges/`](../../bench-results/reference/2026-10-15-bridges/README.md)):

| Path | Update ms | Render ms | Draw calls |
|---|---|---|---|
| Pixi v7, WebGL | 0.48–0.51 | 0.62–0.95 | 3 |
| Pixi v8, WebGL2 | 0.45–0.66 | 0.76–1.23 | 3 |
| Pixi v8, WebGPU | 0.42–0.59 | 0.91–1.26 | 3 |

Ranges are two runs. Update is the same code on all paths, so its spread is
machine noise (Apple Silicon moves the page between efficiency and
performance cores). Render on Pixi 8 is 10–30 % above v7: the Tabula work
inside it is the same, the rest is Pixi 8's own per-frame work. WebGPU does
not lower CPU time at this draw-call count (3); its gains are GPU-side and
need a phone measurement.

## Upgrading Pixi 8

The bridge uses Pixi 8 internals that change between minor versions (render
pipe contract, encoder and pipeline caches, bind groups). It is pinned to
8.21.x (`peerDependencies` and the `pixi.js-8` dev dependency). To move to a
newer 8.x:

1. `npm install --save-dev --save-exact "pixi.js-8@npm:pixi.js@<version>"`
   and update the peer range in `package.json`.
2. `npm run typecheck && npm test && npm run test:parity && npm run bench:bridges`.
3. If something fails, compare the Pixi sources the pipe relies on:
   `BatcherPipe`, `GlBatchAdaptor` / `GpuBatchAdaptor` (draw sequence),
   `GpuEncoderSystem` (binding caches), `PipelineSystem.getBufferNamesToBind`
   (layout keys), `RenderGroupSystem` (instruction build / execute).
4. Update this page and the pinned version.

The Pixi v7 bridge is frozen with Pixi 7: it needs no upgrade work, only
fixes for browser or driver changes.
