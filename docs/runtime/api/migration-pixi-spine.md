# Migrating from pixi-spine

Tabula replaces `pixi-spine` (Pixi v7) for slot-game scenes. The main
differences: assets are **compiled at build time** (no JSON parsing in the
browser), every skeleton draws through **one batched renderer** (views of any
skeletons share draw calls), and playback is a **`Clip`**: single-track
`play()` with crossfades (the fast path, baked when available), or Spine's
multi-track `AnimationState` as `clip.state` when you need tracks.
Side-by-side code: [`docs/examples/migration-pixi-spine.ts`](../examples/migration-pixi-spine.ts).

## Steps

1. Add a build step: `tabula check assets/` then `tabula compile assets/ -o public/assets --bake` (or `repack … --compile --bake` + `manifest`), see [cli.md](../../../tabula-tools/docs/cli.md).
2. Call `registerTabulaRenderer()` before `new Application()` and create one runtime: `const runtime = createTabulaRuntime(app)`.
3. Replace `new Spine(spineData)` with `runtime.createView(asset)`. Loading: keep `Assets.load` and register `tabulaJsonAssetsExtension` (`tabula-pixi/json`: Spine JSON and `.tbin` URLs resolve to a `TabulaAsset`), or use `loadTabulaAsset('/assets/x.tbin')` / `TabulaAssetManager`. Step 1 is then optional per file: JSON loads and plays live.
4. Port the calls with the table below.
5. Remove `pixi-spine` and the `@pixi-spine/*` packages.

## API mapping

| pixi-spine | Tabula |
|---|---|
| `Assets.load('symbol.json')` → `res.spineData` | same call with `tabulaJsonAssetsExtension` registered → `TabulaAsset`; or `await loadTabulaAsset('/assets/symbol.tbin', { baked })` |
| `new Spine(spineData)` | `runtime.createView(asset)` (auto-updated) or `new ClipView(asset)` |
| `spine.state.setAnimation(0, 'idle', true)` | `view.play('idle', { loop: true })` |
| `spine.state.setAnimation(0, 'win', false)` | `view.play('win', { loop: false })` (`loop` carries over between calls: pass it) |
| `stateData.setMix('idle', 'win', 0.2)` / `defaultMix` | `clip.play('win', { mix: 0.2 })` (per call) |
| `state.addAnimation(0, 'idle', true, 0)` | `clip.finished().then(() => clip.play('idle', { loop: true }))` or `clip.on('complete', …)` |
| Spine's `AnimationState` itself (tracks, queues, `setMix`, listeners) | `view.clip.state`: the same API, see [animation-state.md](animation-state.md) |
| `state.timeScale = 2` / `entry.timeScale` | `clip.speed = 2` / `play(name, { speed: 2 })` |
| `entry.trackTime = t` | `clip.seek(t)` / `play(name, { from: t })` |
| `state.clearTracks(); skeleton.setToSetupPose()` | `clip.stop()` |
| `state.addListener({ event, complete, … })` | `clip.on('event' \| 'complete' \| 'loop', fn)` |
| `event.data.audioPath`, `event.volume` | `e.audio?.path`, `e.audio?.volume`, `e.audio?.balance` |
| `skeleton.setSkinByName('gold'); skeleton.setSlotsToSetupPose()` | `clip.setSkin('gold')` |
| `const s = new Skin('mix'); s.addSkin(data.findSkin('10')); s.addSkin(data.findSkin('explode')); skeleton.setSkin(s); skeleton.setSlotsToSetupPose()` | `clip.setSkin(['10', 'explode'])` (built once per asset, shared), or `defineSkin(asset, 'mix', ['10', 'explode'])` then `'mix'` anywhere |
| `skeleton.setAttachment('slot', 'name')` | `clip.setAttachment('slot', 'name')` (persists until `clearAttachment`) |
| `spine.tint = 0xff0000` | `clip.setTint(0xff0000)` (+ dark multiplier: `setTint(light, dark)`) |
| `slot.color.set(…)`, `slot.darkColor` | `clip.skeleton.findSlot(name).color` / `.darkColor` |
| `spine.autoUpdate = false; spine.update(dt)` | same: `view.autoUpdate = false; view.update(dt)` |
| `skeleton.findBone('b').worldX` | `clip.skeleton.findBone('b').worldX` (view-local, y down) |
| `spine.skeleton.getBoundsRect()` / `spine.getBounds()` | `view.getPoseBounds()` / `view.getBounds()` |
| `SkeletonBounds` + `containsPoint` | `view.hitTest(globalPoint)`, `clip.hitTest(x, y)`; `eventMode = 'static'` hit-tests bounding boxes |
| `BitmapText` / `Text` added to a slot container (a win amount on a plate) | `view.setSlotText('slot', sdfText)`: drawn at the slot's layer, follows its bone and color, see [text.md](text.md#text-in-a-spine-slot) |
| `spine.hackTextureBySlotName(…)` | Not supported: add the image to the Spine project as an attachment and use `setAttachment` |
| `spine.state.data.skeletonData.animations` | `clip.animationNames`, `asset.data.animations` |
| physics: `skeleton.physicsTranslate`, `Physics.update` | `clip.skeleton.physicsTranslate(x, y)`, `clip.resetPhysics()`; stepping is automatic |
| `spine.destroy()` | `view.destroy()`, then `unloadTabulaAsset(asset)` or `manager.unloadGroup(group)` |

## Not like pixi-spine

pixi-spine builds one Pixi display object per attachment, inside one
container per slot. Tabula draws a whole skeleton as one batched mesh
(that is where its draw call and CPU savings come from), so code that
reaches into that object tree has no direct equivalent:

| pixi-spine | Tabula |
|---|---|
| `spine.slotContainers[i].addChild(obj)`: any Pixi object at a slot's layer | Text: `view.setSlotText(slot, sdfText)` draws it at the slot's layer. Other objects (sprites, particles, Pixi `Text`) cannot go between two slots of a skeleton: put them above or below the whole view and follow a bone or point attachment with `clip.getPointTransform(name, out)` each frame |
| `spine.children` / per-attachment sprites and meshes | None: attachments are not display objects. Read poses through `clip.skeleton` (bones, slots, `findBone`, `findSlot`) |
| `spine.hackTextureBySlotName(slot, texture)` | Not supported: add the image to the Spine project as an attachment and switch to it with `clip.setAttachment` |
| Per-attachment Pixi filters or masks | Spine clipping attachments, or a filter / mask on the whole view |
| `.skel` binary exports | Spine JSON (4.1, 4.2) or compiled `.tbin` |

## Replacing an always-live symbol stack

In pixi-spine every `Spine` object carries its full skeleton and is updated
every frame, even when it shows a still pose. Cascade and tumble games keep
dozens of falling symbols alive just for one `spinStop` on landing. In
Tabula skeleton data and atlas pages are already shared per asset, and
two features remove the per-symbol cost:

- **Sleeping views** (`view.sleep(pose)`): a symbol that is not animating
  draws a frozen frame with no update work at all, in the same batch.
- **A view pool** (`runtime.pool(asset)`): cleared symbols are reset and
  reused instead of destroyed and rebuilt.

| pixi-spine (always live) | Tabula |
|---|---|
| `const s = new Spine(data); s.state.setAnimation(0, 'spinStop', false); s.state.timeScale = 0;` (hold the first frame while falling) | `const v = pool.acquire({ skin }).sleep({ animation: 'spinStop', time: 0 });` |
| tween `s.y`, and every frame `s.update(dt)` | tween `v.y`; nothing else (asleep: skipped by the update loop) |
| on landing: `s.state.timeScale = 1; s.state.setAnimation(0, 'spinStop', false); s.state.addAnimation(0, 'idle', true, 0);` | `v.play('spinStop', { sleepOnComplete: { animation: 'idle', time: 0 } });` |
| idle loop updated forever | asleep on the idle pose after `spinStop` |
| cleared: `s.destroy()`; refill: `new Spine(data)` | `pool.release(v)`; refill: `pool.acquire({ skin })` |
| skins of one skeleton: one `Spine` per symbol, `setSkinByName` | one pool per asset, `acquire({ skin })` |

Steps:

1. Create one pool per symbol asset at load time, with `prewarm` about two
   grids (the old grid falls out while the new one falls in) and `max` a bit
   above that: `runtime.pool(asset, { prewarm: 98, max: 120 })`.
2. Where you created a `Spine`, `acquire` a view and put it to sleep on the
   pose it shows while falling.
3. On landing, `play` the landing animation with `sleepOnComplete` (the rest
   pose, or `true` for its last frame).
4. Where you destroyed the symbol, `release` it.
5. If the idle animation must keep looping, play it without
   `sleepOnComplete`; the view then stays awake like a pixi-spine object,
   only cheaper.

Measured on a 7×7 cascade (about 100 falling symbols, staggered `spinStop`,
pooled refills) the sleeping and pooled variant needs a fraction of the
update time, draw calls and memory per symbol of the pixi-spine 4.0.6 scene:
see [recipes/cascade.md](recipes/cascade.md) for the table and the full
recipe ([`docs/examples/cascade.ts`](../examples/cascade.ts)). Against Esoteric's
official Pixi 7 runtime (`@esotericsoftware/spine-pixi-v7` 4.2.120), the same
cascade draws 70 calls per frame vs Tabula's 3, at about 2.8× the CPU and
30× the garbage ([measurements](../../bench-results/reference/2026-10-16-official/README.md)).

## Tracks and mixing

Two ways to play:

- **`clip.play(name, { mix })`**: one animation at a time with a world-space crossfade (bone transforms, colors and deforms blend; attachments and draw order switch immediately). It uses baked samples when loaded, so it is the cheapest option for symbols, buttons and backgrounds. Queue with `finished()` / `'complete'`.
- **`clip.state`**: spine-core's `AnimationState` (tracks, `addAnimation` queues, `setMix` / `defaultMix`, empty animations, track `alpha`, additive `MixBlend.add`, `holdPrevious`, entry and state listeners), validated frame by frame against spine-core 4.1 and 4.2. Code written against `spine.state` ports over almost unchanged: replace `spine.state` with `view.clip.state`. It always evaluates timelines live. See [animation-state.md](animation-state.md).

## Behaviour differences

- Spine 4.1 and 4.2 exports are supported (constraints follow the export version's math). Other versions are rejected by `check`/`compile`.
- No full-Spine fallback: features the runtime cannot render are build errors (`tabula check`), not silent differences.
- Baked animations (default with `--bake`) do not evaluate constraints at runtime; physics skeletons always play live.
- Events at the loop boundary fire on every loop; `seek` fires events only with `fireEvents`.
- Blend modes: normal and additive batch together; multiply and screen each start a new batch. Premultiplied multiply needs the destination colour in the source term, which WebGL blending cannot express without framebuffer fetch or dual-source blending (`WEBGL_blend_func_extended`, not available everywhere).
