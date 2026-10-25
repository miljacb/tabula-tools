# Pixi v7 bridge (`tabula-pixi`)

```ts
import { registerTabulaRenderer, createTabulaRuntime, ClipView, loadTabulaAsset } from 'tabula-pixi';
```

The only module that imports `pixi.js`. It adds one renderer plugin
(`renderer.plugins.tabula`), a `Container` subclass per skeleton, and loaders.
Full signatures: [reference/pixi-v7.md](reference/pixi-v7.md).

## Setup

| Function | What it does | Notes |
|---|---|---|
| `registerTabulaRenderer(options?)` | Register the `tabula` plugin (idempotent). `options.maxTextures` caps texture units per batch; `options.reorder: false` draws runs in plain order (diagnostics). | Call **before** `new Application()`; otherwise views throw "TabulaRenderer is not registered". |
| `createTabulaRuntime(app)` | Create a runtime that advances its views from `app.ticker`. | Returns `TabulaRuntime`. |
| `runtime.createView(asset, options?)` | Create a `ClipView`, auto-updated until destroyed. | `options`: `ClipViewOptions` (`baked`, `skin`, `physics`). |
| `runtime.timeScale` | Multiplier for the ticker step of every view and text counter (default 1): `2` = turbo, `0` = freeze. | `runtime.update(dt)` called directly is not scaled; per view: `view.clip.speed`. |
| `runtime.stats` | Tabula renderer statistics of the last frame: `drawCalls`, `vertices`, `triangles`, `batchBreaks` (by reason). | |
| `runtime.destroy()` | Stop updating views and detach from the ticker. | Views are not destroyed. |

```ts
registerTabulaRenderer();
const app = new Application({ width: 1280, height: 720 });
const runtime = createTabulaRuntime(app);
const view = runtime.createView(asset).play('symbolIdle', { loop: true });
app.stage.addChild(view);
console.log(runtime.stats.drawCalls);
```

## ClipView

A `Container` drawing one skeleton. Transform, alpha, visibility, masks and
filters work as for any Pixi display object.

| Member | What it does |
|---|---|
| `new ClipView(asset, options?)` | Create a view you update yourself (`view.update(dt)`), or use `runtime.createView`. |
| `clip` | The core `Clip`: playback, events, skins, tint, attachments ([core.md](core.md#clip)). |
| `asset` | The shared `TabulaAsset`. |
| `play(name?, options?)` | Shortcut for `clip.play`; returns the view (chainable). |
| `update(dt)` | Advance the clip (the runtime calls it when `autoUpdate` is true). |
| `autoUpdate` | Default `true`; `false` to drive the view yourself (pause a single view, step in tests). |
| `hitTest(globalPoint)` | Topmost bounding box under a stage point, or null. |
| `containsPoint(globalPoint)` | Pixi hit-test hook: with `eventMode = 'static'`, pointer events reach the view only inside its visible bounding boxes. |
| `getPoseBounds(out?)` | Local bounds of the drawn pose (`Rectangle.EMPTY` if nothing is visible). `getBounds()` also works. |

`view.alpha` multiplies `clip.tint.a`. Views drawn consecutively (any
skeletons, SDF texts) form one *run*: uploaded once and drawn in as few
batches as blend states and texture units allow. Multiply and screen slots
need their own blend state; a view's draws in such a state join an earlier
batch of that state whenever nothing they overlap was drawn in between, so
a grid of symbols with multiply slots draws in 3 calls, not 2 extra per
symbol. Overlapping draws always keep their order (same pixels as drawing
in order; `npm run test:batching` compares both in Chromium). A run ends
when Pixi draws something else (other objects, masks, filters) or at 65,535
vertices.

## Sleeping views

A view that does not animate can **sleep**: its pose is frozen into cached
skeleton-space triangles, and every frame it only replays them through the
view's world transform, tint and alpha. A sleeping view:

- is not visited by the runtime's update loop at all (no clip, bone,
  constraint or animation work);
- allocates nothing per frame and still batches in the same draw call as
  awake views, texts and other skeletons;
- keeps hit tests (`hitTest`, pointer events) and bounds (`getBounds`,
  `getPoseBounds`) on the frozen pose;
- works with baked, live and multi-track (`clip.state`) clips, tint and tint
  black, clipping attachments and every blend mode.

| Member | What it does |
|---|---|
| `sleep(pose?)` | Freeze and sleep. `pose`: `'current'` (default: the frame now), `'setup'` (setup pose; stops the clip), or `{ animation, time? }` (that animation at `time`, clamped to its duration). Calling it again re-freezes. Returns the view. |
| `wake()` | Resume updates from the frozen state (no pop: the first awake frame is the frozen one). |
| `play(name, { ..., sleepOnComplete })` | Wakes the view and plays. `sleepOnComplete: true` freezes the last frame when a non-looping animation completes; a pose (`{ animation: 'idle', time: 0 }`, `'setup'`) freezes that pose instead. |
| `sleeping` | True while asleep. |
| `frozenByteSize` | Bytes held by the frozen frame (about 3 KB for a typical symbol). |
| `runtime.viewCounts` | `{ total, awake }` of the runtime's views. |

```ts
view.sleep({ animation: 'symbolSpinStop', time: 0 });          // falling: first landing frame, frozen
view.play('symbolSpinStop', { sleepOnComplete: { animation: 'symbolIdle', time: 0 } }); // landed
```

The frozen frame is exact: pixel-identical to the awake frame it was taken
from (`tests/sleep.test.ts`). Tint, dark tint and alpha changes apply to a
sleeping view directly. Calls that re-pose the clip while asleep (`seek`,
`setSkin`, `setAttachment`) are picked up on the next render: the frame is
re-captured once, not every frame. `clip.skeleton` keeps the frozen pose, so
bone positions read from it match what is drawn.

Cost: a sleeping view keeps its `Clip` (so it can wake instantly) plus the
frozen frame. In the 7×7 cascade benchmark that is about 16 KB per view,
against about 11.5 KB for an awake view and 53 KB for a pixi-spine `Spine`
of the same symbol; see [recipes/cascade.md](recipes/cascade.md).

## View pool

`runtime.pool(asset, options)` returns a `ClipViewPool` (one per asset, or
per `key`). Symbol types that are skins of one skeleton share the asset and
so one pool: pass the skin to `acquire`, including combined skins
(`acquire({ skin: ['10', 'explode'] })` or a `defineSkin` name).

| Member | What it does |
|---|---|
| `runtime.pool(asset, { prewarm?, max?, budgetMs?, viewOptions?, key? })` | The pool for `asset` (created on first call; later calls with the same asset or `key` return it). `prewarm`: views created ahead, off-frame in idle-callback slices of `budgetMs` (default 4 ms). `max`: most free views kept (releases beyond it destroy the view). |
| `acquire({ skin? })` | A view indistinguishable from a new one: setup pose, awake, no listeners, identity transform, no parent. Creates one if the pool is empty. |
| `release(view)` | Reset everything (animation state, tracks, clip and Pixi listeners, tint and dark tint, skin, attachment overrides, transform, alpha, visibility, mask, filters, hit area, children, parent) and park it asleep. A second release is ignored with a warning (returns false); a view from another pool throws. |
| `prewarm(count)` | Create views until `count` are free (idle slices). Resolves when done. |
| `size` / `inUse` / `created` | Free views, views handed out, views created in total. |
| `clear()` | Destroy the free views. |

Parked views are asleep without a frame: they cost no update and no render.
`view.destroy()` on a pooled view is allowed; the pool drops it.

## Loading

| Function | What it does | Returns / errors |
|---|---|---|
| `loadTabulaAsset(url, { baked?, textureBaseUrl?, textures? })` | Fetch a `.tbin`, its embedded atlas's page textures and optional `.baked`. `textures` selects tier/KTX2 ([textures-ktx2.md](textures-ktx2.md)). | `TabulaAsset`. Rejects on HTTP errors, an `.tbin` without atlas, a baked-hash mismatch. |
| `unloadTabulaAsset(asset)` | Free the page textures of an asset from `loadTabulaAsset` / `loadAtlasTextures`, unless another loaded asset still uses them. Idempotent. | Destroy views first. User-created textures are untouched. |
| `createTabulaAsset(data, atlas, textures, baked?)` | Build an asset from parsed data and your own textures (`Map<pageName, BaseTexture>`). | Throws if a page has no texture. |
| `loadAtlasTextures(atlas, baseUrl, options?)` | Load an atlas's pages (images through Pixi Assets, premultiplied; or tier/KTX2 files). | `Map<pageName, BaseTexture>`. A failing KTX2 page falls back to the image. |
| `loadPageTexture(page, choice, fallback, size, url, options?)` | Load one page (what the manager uses). | `{ texture, report, release() }`. |
| `deviceTextureHints(renderer?)` | Device class inputs for tier choice. | `DeviceTextureHints`. |
| `TabulaAssetManager` | Manifest + load groups ([manifest.md](manifest.md)). | |
| `tabulaAssetsExtension` | Pixi `Assets` load parser for `.tbin` URLs (see below). | `Assets.load` resolves to a `TabulaAsset`; `Assets.unload` calls `unloadTabulaAsset`. |
| `loadTabulaJson(url, { atlas?, textureBaseUrl?, textures?, name? })` (`tabula-pixi/json`) | Load a Spine JSON export + its `.atlas` (default: next to the JSON) + pages, without compiling. | `TabulaAsset` (live playback only). Throws on Spine versions other than 4.1/4.2. |
| `tabulaJsonAssetsExtension` (`tabula-pixi/json`) | `tabulaAssetsExtension` plus Spine JSON: register one of the two. | Spine JSON is detected by content after Pixi's JSON loader; other JSON is left alone. |

`TabulaAsset` = `{ data, atlas, textures, resolve, baked }`, shared by all
views of a skeleton.

### Pixi `Assets` (existing asset lists, CDN and cloud URLs)

A game that already loads everything through `Assets.add` / `Assets.load`
(asset lists from an API, bucket URLs) keeps doing so: register the parser
and point the entries at `.tbin` files, or at the Spine `.json` exports with
the JSON parser.

```ts
import { Assets, extensions } from 'pixi.js';
import { tabulaJsonAssetsExtension } from 'tabula-pixi/json'; // or tabulaAssetsExtension from 'tabula-pixi' (.tbin only)

extensions.add(tabulaJsonAssetsExtension);
tabulaJsonAssetsExtension.config = { baked: true, textures: { renderer: app.renderer, transcoder: '/basis/' } };

Assets.add({ alias: 'symbol1', src: `${bucket}/slots/symbol1.tbin` });          // compiled
Assets.add({ alias: 'reel', src: `${bucket}/slots/reel.json` });                    // Spine export, reel.atlas next to it
Assets.add({ alias: 'logo', src: `${bucket}/logo.json`, data: { atlas: `${bucket}/atlases/logo.atlas` } });
const { symbol1, reel } = await Assets.load(['symbol1', 'reel']);
runtime.createView(symbol1).play('symbolIdle', { loop: true });
```

| `data` / `config` key | Default | Meaning |
|---|---|---|
| `baked` | none | `.tbin` only: `true` loads `<name>.baked` next to the skeleton; a string is its URL. Missing file = rejected load, so set it only where bakes exist. |
| `textureBaseUrl` | the skeleton's (JSON: the atlas's) folder | Where the page images are. |
| `textures` | 1× pages as the atlas names them | Tier / KTX2 options ([textures-ktx2.md](textures-ktx2.md)); merged key by key over `config.textures`. |
| `atlas` | `<name>.atlas` next to the JSON | JSON only: the atlas URL. |

Query strings (cache busting, `?v=3`) are kept on derived URLs (`.baked`,
`.atlas`) and ignored when finding the folder. JSON skeletons always play
live: compile them (`tabula compile --bake`, e.g. in the upload pipeline)
when load time or update cost matters.

### Atlas setups

Two layouts are supported; both compile to one `.tbin` per skeleton.

**1. One atlas + one texture shared by many JSONs** (e.g. all symbols on one
page). Compile every JSON against the shared atlas:

```sh
# assets/symbols/symbol1.json … symbol9.json, symbols.atlas, symbols.png
tabula compile assets/symbols --atlas assets/symbols/symbols.atlas -o public/assets
cp assets/symbols/symbols.png public/assets/
```

```ts
const assets = await Promise.all(['symbol1', 'symbol2', 'symbol3'].map((n) => loadTabulaAsset(`/assets/${n}.tbin`)));
// symbols.png is fetched and uploaded once; every asset shares the same BaseTexture.
unloadTabulaAsset(assets[0]); // page stays: other symbols still use it
// ... the page is freed when the last asset using it is unloaded.
```

Pages are shared by URL, so keep the `.tbin` files next to the page image (or
pass the same `textureBaseUrl`). The same holds for `TabulaAssetManager`:
skeletons in one or several groups hold the shared page once
(`manager.pageRefCount('symbols.png')`), and `unloadGroup` frees it only when
no loaded group needs it.

**2. Separate atlas + texture + JSON per skeleton** (the Spine export
default: `hero.json`, `hero.atlas`, `hero.png`). No flag needed: each JSON
uses the `<name>.atlas` next to it.

```sh
tabula compile assets/hero.json assets/bigWin.json -o public/assets
cp assets/hero.png assets/bigWin.png public/assets/
```

```ts
const hero = await loadTabulaAsset('/assets/hero.tbin');     // loads hero.png
const bigWin = await loadTabulaAsset('/assets/bigWin.tbin'); // loads bigWin.png
unloadTabulaAsset(bigWin); // frees bigWin.png only
```

Page file names must be unique per folder: two different atlases that both
call their page `skeleton.png` would be treated as one texture.

## TabulaRenderer

The plugin itself. You rarely touch it directly.

| Member | What it does |
|---|---|
| `lastFrameStats` / `stats` | Last completed frame / frame in progress. |
| `maxTextures` | Units per batch in use. |
| `reorder` | Overlap-aware batch ordering (default true; `false` = plain draw order, same pixels, more draw calls). |
| `TabulaRenderer.maxTexturesOverride` | Static cap (same as `registerTabulaRenderer({ maxTextures })`), set before the first frame. |
| `setTransform(matrix)`, `drawTriangles(...)`, `flush()` | `DrawSink` implementation `ClipView` uses; custom display objects can stream triangles the same way. |

`BatchBreakReason`: `'textures'`, `'blend'`, `'vertices'` (see reference).

### WebGL context loss

Nothing to set up. When the browser drops the WebGL context (GPU reset,
driver update, too many contexts, a laptop switching GPUs) and gives it back,
the scene draws again as it was:

- Pixi re-uploads every texture (atlas pages, KTX2 pages, SDF font and
  runtime glyph pages), buffer and shader program from the sources it keeps.
- The Tabula renderer re-enables the WebGL extensions on the restored context
  first. Pixi 7 does not, and compressed (KTX2) pages would otherwise fail to
  upload and draw garbage.
- The texture-unit limit is read again; the Tabula shader is rebuilt only if it
  changed.
- Clips, sleeping views, pools and texts keep their state: animation simply
  continues.

While the context is lost, rendering draws nothing and does not throw.
`npm run test:context-loss` checks this in Chromium: loses and restores the
context in five scenes (PNG atlas, multiply/screen batches, KTX2 pages,
pooled cascade, SDF text with runtime glyphs) and compares the frames pixel
by pixel.

## KTX2 and workers

`loadKtx2Texture`, `unloadKtx2Texture`, `loadBasisTranscoder`,
`compressedTextureSupport`, `Ktx2WorkerPool`, `sharedKtx2WorkerPool`,
`disposeSharedKtx2WorkerPools`, `workersSupported`, `defaultWorkerCount`:
see [textures-ktx2.md](textures-ktx2.md).
