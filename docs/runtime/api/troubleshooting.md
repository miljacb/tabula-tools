# Troubleshooting

## Setup and rendering

| Symptom / message | Cause | Fix |
|---|---|---|
| `tabula: TabulaRenderer is not registered (call registerTabulaRenderer() before creating the Application)` / `tabula: call registerTabulaRenderer() before creating the Pixi Application` | The plugin was registered after the renderer was created. | Call `registerTabulaRenderer()` before `new Application()`. |
| Nothing visible, no error | View not on stage, zero alpha, off-screen, or a skin without attachments. | Check `view.getPoseBounds()`, `clip.tint.a`, `view.worldVisible`; try `clip.setSkin(...)`. |
| `tabula: missing atlas region "…"` (once per region) | The atlas does not contain an attachment's region (wrong atlas, stale repack). | Run `tabula check`; recompile with the right `--atlas` / rerun `repack`. |
| Dark halos or too-bright edges | Pages premultiplied twice or not at all. | Keep the atlas `pma` flag accurate (repack writes it). Don't premultiply pages yourself. |
| More draw calls than expected | Multiply/screen slots on views that overlap each other (their order must be kept), too many atlas pages in one batch, or non-spine objects between views (each ends a run). | `runtime.stats.batchBreaks` says why; repack co-drawn skeletons into one group; keep spine views adjacent in the display list. |
| Animation stays the same after `play('x')` with `loop` | `loop`/`speed` carry over from the previous `play()`. | Pass `loop` (and `speed`) explicitly. |
| `finished()` rejects with "Animation restarted" / "Animation stopped" | Another `play()` or `stop()` replaced it. | Expected; catch it or use `on('complete')`. |
| Manual bone change has no effect | Each pose starts from the setup pose. | Change bones after the runtime's update (ticker `UPDATE_PRIORITY.LOW`) and call `skeleton.updateWorldTransform()` ([core.md](core.md#skeleton-bone-slot)). |
| Garbage or missing KTX2 pages after the screen went black for a moment (WebGL context lost and restored) | Pixi 7 does not re-enable WebGL extensions on a restored context; Tabula's `TabulaRenderer` does. | Make sure `registerTabulaRenderer()` ran for that renderer; for a renderer without it, call `renderer.context.getExtensions()` on `webglcontextrestored` (capture phase). |
| Physics bones whip after moving a view far | Physics sees the jump as motion. | `clip.resetPhysics()` after teleports; `skeleton.physicsTranslate` for intended motion. |

## Pixi v8 bridge

| Symptom / message | Cause | Fix |
|---|---|---|
| `tabula: call registerTabulaRenderer() before app.init()` | The pipe was registered after the renderer was created (render pipes are created in `app.init()`). | Call `registerTabulaRenderer()` before `await app.init()`. |
| Deprecation warning `addChild: Only Containers will be allowed to add children` on a `ClipView` / `SdfText` | Pixi 8 views cannot have children. | Put the view and the objects that follow it in a `Container` ([pixi-v8.md](pixi-v8.md#differences-from-v7)). |
| A view is darker / more transparent than on v7 | Pixi 8 inherits `tint` and `alpha` from parents; the clip tint is multiplied by them. | Expected; tint the parent only where intended, or `clip.setTint` on the view. |
| `containsPoint` misses where `hitTest` hits | In Pixi 8 `containsPoint` takes a **local** point. | Use `view.hitTest(globalPoint)` for stage coordinates. |
| One row of pixels differs between WebGL2 and WebGPU along an edge | Rasterizer tie rule with WebGPU's flipped y axis (Pixi's own sprites do the same). | Expected; not a rendering error. |
| KTX2 pages load as RGBA8 on WebGPU (larger VRAM) | Compressed WebGPU textures need sizes that are multiples of 4, or the device lacks the format's feature. | Repack with page sizes in multiples of 4 (`maxSize` power of two); check `compressedTextureSupport(app.renderer)`. |
| Type errors after installing a newer `pixi.js` 8.x | The bridge is pinned to 8.21.x (it uses Pixi internals). | Stay on 8.21.x or follow [Upgrading Pixi 8](pixi-v8.md#upgrading-pixi-8). |

## Loading

| Symptom / message | Cause | Fix |
|---|---|---|
| `Not a Tabula compiled skeleton (bad magic)` | The URL served HTML (404 page / SPA fallback) or another file. | Check the URL and server routes. |
| `Unsupported .tbin format version N …; recompile the skeleton` / `.tbin compiled for IR version N …` | Built by another Tabula version. | Recompile with the installed CLI. |
| `"x.tbin" was compiled without an atlas` | Compiled with `--no-atlas`. | Recompile without it, or load the atlas and use `createTabulaAsset`. |
| `Baked data for "…" does not match skeleton "…" (hash mismatch)` | `.baked` from an older export. | Rebake together with the `.tbin` (`compile --bake`). |
| `Animation "x" not found` / `Skin "x" not found` / `Slot "x" not found` / `Attachment "x" not found …` | Name typo or the asset changed. | `clip.animationNames`, `asset.data.skins`, `asset.data.slots`. |
| `Skeleton "x" is not loaded (load a group that contains it: …)` | `getAsset` before `loadGroup`. | Await the listed group first. |
| `Unknown load group "x"` | Not in the manifest. | `manager.groupNames`; rebuild with `--load-groups`. |
| `Not a Tabula asset manifest` / `Asset manifest version N is not supported (expected 1–2); update tabula-pixi` | Wrong file, or a manifest with raw JSON skeletons (version 2) read by an older runtime. | Update `tabula-pixi` in the game, or export with every skeleton compressed (version 1). |
| `The manifest lists raw Spine JSON skeletons (…): pass \`json: spineJson\`` | The export has skeletons as raw JSON (not compressed, or compression failed) and the manager has no JSON parser. | `import { spineJson } from 'tabula-pixi/json'` and pass `json: spineJson` (about 14 KB). Games that take exports from the app should always pass it. |
| Views break after `unloadGroup` / `unloadTabulaAsset` | Textures were destroyed while views still drew them. | Destroy views first. |

## KTX2

| Symptom / message | Cause | Fix |
|---|---|---|
| `tabula: KTX2 pages need the renderer and transcoder options; loading the images` | `renderer` or `transcoder` missing. | Pass both (`transcoder: '/basis/'`). |
| `tabula: x.ktx2: …; loading the image instead` | The KTX2 page failed (404, transcoder missing, bad file); the PNG/WebP loaded instead. | Fix the message's cause; images keep the game working meanwhile. |
| `…basis_transcoder.js did not define BASIS` | Wrong transcoder URL (HTML returned) or a different build. | Serve `vendor/basis/basis_transcoder.{js,wasm}` from the package, same folder. |
| `tabula: …; transcoding on the main thread` | Workers could not start (CSP blocks `blob:` workers, no Worker support). | Allow `worker-src blob:` in the CSP to get worker transcoding; loading works either way. |
| `"x" is not a Basis Universal KTX2 file` | A KTX2 file not encoded with Basis (e.g. raw ASTC). | Encode with `tabula repack --ktx2`. |
| Blurry art on a capable device | The game asked for a lower tier, or `'auto'` picked one (small canvas, low memory, software GL). | Check the `tier` option and `manager.tier`; `'auto'`: check `deviceTextureHints(app.renderer)`. |
| `--ktx2` fails: no `ktx` found | Download disabled or offline. | `tabula ktx-tool --install` with network, set `TABULA_KTX`, or unset `TABULA_KTX_DOWNLOAD=0`. |
| `ktx-tool --install`: checksum mismatch | Corrupted or tampered download. | Retry; it never installs an unverified file. |

## Build

| Symptom / message | Cause | Fix |
|---|---|---|
| `Unsupported attachment type "…"` / `slot timeline "…"` / `bone timeline "…"` | The export uses a feature the runtime does not render. | Remove it in Spine, or open an issue; see [feature-audit.md](../feature-audit.md). |
| Spine version rejected / `Spine 5.x JSON is not supported yet` | 4.1 and 4.2 are supported; newer 4.x is read best-effort (warnings); 5.x and anything before 4.1 are rejected. | Export as 4.2 (or 4.1) JSON. |
| Warning `Spine 4.x export read best-effort` / `section "…" is ignored` | A newer 4.x export; data the runtime does not know is skipped. | Check it in the app's preview against the editor. |
| `Tier 2x needs symbol1@2x.atlas` | A tier above 1 without the higher-resolution export (never upscaled). | Export the skeleton at 2× from Spine next to the 1× one, or drop the tier. |
| `Spine binary (.skel) is not supported` | Binary exports are not read. | Export JSON. |
| `… is not empty and was not written by a Tabula export` (app export) | The export folder holds other files; an export empties its folder. | Choose an empty folder. |
| `Input file is missing: …webp` (repack) | A page image named in the atlas is not next to it. | Copy the page images with the atlas. |
| `repack --bake needs --compile` | `.baked` files pair with compiled `.tbin`. | Add `--compile`. |
| `Page "…" of x.tbin not found at …` (manifest) | The manifest directory lacks a page file. | Run `manifest` on the folder that holds `.tbin` and pages (repack output). |
| `sharp` errors | Optional dependency missing for this platform. | `npm install sharp` (needed only by `repack`). |
