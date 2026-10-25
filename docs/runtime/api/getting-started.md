# Getting started

This walks through a complete scene. The full code is
[`docs/examples/getting-started.ts`](../examples/getting-started.ts)
(typechecked). Method details: [core.md](core.md) (Clip) and
[pixi-v7.md](pixi-v7.md) (views, loading). On Pixi 8 (WebGL2 / WebGPU) the
same steps use `tabula-pixi/pixi-v8` and an async `app.init()`:
[pixi-v8.md](pixi-v8.md), example [`docs/examples/v8/getting-started.ts`](../examples/v8/getting-started.ts).

## 1. Install

```sh
npm install tabula-pixi pixi.js@7
```

- `pixi.js` ^7 is a peer dependency. The bridge is the only code that imports it.
- `sharp` is an optional dependency, used only by `tabula repack` (page images, tiers).
- KTX2 encoding needs the `ktx` tool. `tabula ktx-tool --install` downloads the pinned,
  checksum-verified KTX-Software 4.4.2 into `node_modules/.cache/tabula` (no admin
  rights, nothing installed system-wide); `repack --ktx2` does this on first use.
- The Basis transcoder for KTX2 pages ships in the package:
  `node_modules/tabula-pixi/vendor/basis/basis_transcoder.{js,wasm}`.
  Serve both from one URL (for example copy them to `public/basis/`).

Requirements: Node 18+ for the CLI; a WebGL1/2 browser for the runtime.

## 2. Build the assets

Spine exports (JSON 4.1 or 4.2 + `.atlas` + page images) are compiled at build
time. The runtime never parses JSON or atlas text.

```sh
# Check that every export uses only supported features (CI: exit code 1 on errors).
npx tabula check assets/

# Simplest: one .tbin per skeleton (atlas regions embedded) + baked animations.
npx tabula compile assets/ -o public/assets --bake

# Production: repack pages per co-draw group, KTX2 + tiers, then a manifest with load groups.
npx tabula repack assets/ -o public/assets --groups atlas-groups.json --compile --bake \
  --ktx2 uastc --tiers 1,0.75,0.5
npx tabula manifest public/assets --load-groups load-groups.json
```

All commands and flags: [cli.md](../../../tabula-tools/docs/cli.md).

## 3. Create the renderer and runtime

```ts
import { Application } from 'pixi.js';
import { createTabulaRuntime, loadTabulaAsset, registerTabulaRenderer } from 'tabula-pixi';

registerTabulaRenderer();                    // BEFORE new Application(): plugins are created with the renderer
const app = new Application({ width: 1280, height: 720 });
const runtime = createTabulaRuntime(app);    // advances every view it creates from app.ticker
```

`registerTabulaRenderer({ maxTextures })` caps texture units per batch (default
min(GPU units, 8)). `runtime.stats` reports draw calls, vertices and batch
breaks of the last frame.

## 4. Load

```ts
const asset = await loadTabulaAsset('/assets/symbol1.tbin', { baked: '/assets/symbol1.baked' });
```

- Page images load from the `.tbin`'s folder (or `textureBaseUrl`).
- With `textures: { manifest, tier, renderer, transcoder }` it loads tiers and KTX2 pages, see [textures-ktx2.md](textures-ktx2.md).
- For many skeletons, use the manifest and load groups instead: [manifest.md](manifest.md).

## 5. Play

```ts
const view = runtime.createView(asset).play('symbolIdle', { loop: true });
view.position.set(640, 360);
app.stage.addChild(view);
const clip = view.clip;                     // Pixi-agnostic playback API
```

`play(name, { loop, speed, from, mix })`:

| Option | Meaning |
|---|---|
| `loop` | `true` forever, a number = that many extra repeats, `false` once. **Carries over** to the next `play()` when omitted. |
| `speed` | Rate multiplier (also `clip.speed`). Carries over. |
| `from` | Start time in seconds (default 0). |
| `mix` | Crossfade seconds from the current pose (default 0 = cut). |

Other controls: `pause()`, `resume()`, `stop()` (setup pose), `seek(t, fireEvents)`,
`skipToEnd(fireEvents)` (turbo/quick stop), `time`, `duration`, `playing`,
`animationName`, `animationNames`, `hasAnimation(name)`, `kind` (`'baked'`/`'live'`),
`await clip.finished()` (resolves when a non-looping animation completes,
rejects if it is stopped or replaced).

## 6. Mix (crossfade)

```ts
clip.play('symbolWin', { mix: 0.2, loop: false });
```

During the mix, bone world transforms (rotation and scale by angle,
translation linearly), slot colors and matching deforms blend from the
outgoing pose to the new animation. Attachments and draw order switch to the
new animation at once, and only the new animation fires events. Works between
baked and live animations. `clip.mixing` is true while it runs. It is a
single-track crossfade in world space. For several tracks, queues, per-pair mix
durations or additive layers, use Spine's AnimationState as `clip.state`
(see [animation-state.md](animation-state.md)).

## 7. Events

```ts
clip.on('event', (e) => e.audio ? playSound(e.audio.path, e.audio.volume) : console.log(e.name, e.int, e.float, e.string));
clip.on('loop', () => {});        // each wrap-around
clip.on('complete', () => {});    // non-looping end (also skipToEnd)
clip.off('event', listener);
```

Events follow Spine's rule (fire when `lastTime < t <= time`; keys at the loop
boundary fire on every loop). Listeners run synchronously inside
`update()`/`seek()`.

## 8. Skins

```ts
asset.data.skins.map((s) => s.name);  // available skins
clip.setSkin('gold');                  // throws if unknown; the pose is kept
new ClipView(asset, { skin: 'gold' }); // or runtime.createView(asset, { skin: 'gold' })
```

Several skins at once (a symbol value plus its explosion, an outfit plus a
weapon) take one call: pass their names. Where two skins fill the same
attachment, the later name wins.

```ts
clip.setSkin(['10', 'explode']);                  // combined, no Skin objects to build
defineSkin(asset, 'wild10', ['10', 'explode']);   // or name the combination on the asset...
clip.setSkin('wild10');                           // ...and use the name anywhere a skin goes
pool.acquire({ skin: 'wild10' });
await loadTabulaAsset(url, { skins: { wild10: ['10', 'explode'] } }); // or define it at load
```

`skins` takes as many combinations as you need, one name each, and a
definition may use a name defined **before** it in the same map
(definitions run in order; a later one is not found yet and loading throws
`skin "…" not found`). Combinations you do not name need no declaration:
`setSkin(['3', 'explode'])` works at any time and is built on first use.

```ts
await loadTabulaAsset('/assets/symbol23.tbin', {
  skins: {
    wild2:  ['2', 'explode'],
    wild10: ['10', 'explode'],
    wild10gold: ['wild10', 'gold'], // uses wild10, so it comes after it
  },
});
// TabulaAssetManager: the same per skeleton name.
new TabulaAssetManager(manifest, url, {
  skins: { symbol23: { wild10: ['10', 'explode'] }, symbol15: { big: ['5', '6'] } },
});
```

Demo: **Combined skins** in the sidebar (`?scene=skins`) shows every value
skin of symbol23 alone and with `explode`; in the skeleton browser, check
several skins in the bottom bar (`?skeleton=symbol23&skin=10,explode`), and
the names defined at load are listed there in italics.

A combination is built once per asset and shared by all its views, so it
costs what any `setSkin` costs and nothing per frame. It holds the parts'
own attachments, so baked playback, sleeping views and hit tests work
unchanged. Draw calls depend on where the parts' images were packed: give
skins that are shown together the same atlas group when repacking.

## 9. Tint and tint black

```ts
clip.setTint(0xff8080);           // light multiplier for the whole clip
clip.setTint(0xffffff, 0x404040); // + dark multiplier: scales two-color ("tint black") slots' dark color
clip.tint.a = 0.5;                // whole-clip alpha (view.alpha also works)
```

Two-color tint (Spine "tint black") is rendered by the Tabula shader for every
slot that has a dark color, at no extra draw calls; animated dark colors play
from both live and baked data. Per-slot colors are on
`clip.skeleton.findSlot(name).color` / `.darkColor` (overwritten by the next
keyed frame). Tinting never needs a rebake.

## 10. Attachments

```ts
clip.setAttachment('weapon', 'sword');   // show 'sword' (active skin, then default skin)
clip.setAttachment('weapon', null);      // hide the slot
clip.clearAttachment('weapon');          // back to setup pose / animation keys
clip.clearAttachment();                  // remove all overrides
```

Overrides win over setup pose and attachment keys until cleared, in live and
baked playback. Unknown slots or attachments throw.

## 11. Bounds and hit tests

```ts
view.getPoseBounds();                            // local Rectangle of the drawn pose
view.eventMode = 'static';                       // pointer events only inside bounding boxes
view.on('pointertap', () => spin());
const hit = view.hitTest(globalPoint);           // topmost bounding box at a stage point, or null
clip.getPointTransform('coinSpawn', out);        // point attachment / bone transform (skeleton space)
```

Details: [hit-testing.md](hit-testing.md).

## 12. Unload

```ts
view.destroy();               // views first
unloadTabulaAsset(asset);      // frees its page textures unless another loaded asset shares them
runtime.destroy();            // when leaving the scene
// with the manifest: manager.unloadGroup('bigwin')
```

## Next

- Ship compressed textures: [textures-ktx2.md](textures-ktx2.md).
- Load and unload by game phase: [manifest.md](manifest.md).
- Problems: [troubleshooting.md](troubleshooting.md).
