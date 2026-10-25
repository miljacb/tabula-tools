# Recipe: cascade / tumble symbols

In cascade (tumble) slots dozens of symbols fall in stacks. While falling
they show a still pose; on landing each plays `spinStop` once; then it rests.
With pixi-spine every symbol is a full `Spine` object updated every frame for
that one animation. In Tabula skeleton data and atlas pages are shared per
asset already, and two features remove the per-symbol cost:

- **Sleeping views** ([pixi-v7.md#sleeping-views](../pixi-v7.md#sleeping-views)):
  `view.sleep(pose)` freezes a pose into cached quads. A sleeping view is
  skipped by the update loop, allocates nothing per frame and still batches
  with everything else. `play()` (or `wake()`) resumes with no pop.
- **A view pool** ([pixi-v7.md#view-pool](../pixi-v7.md#view-pool)):
  `runtime.pool(asset, { prewarm, max })`; `release` resets everything
  (state, tracks, listeners, tint, skin, attachments, transform, parent).

Full example: [`docs/examples/cascade.ts`](../../examples/cascade.ts)
(typechecked). Live demo: `npm run demo`, "7x7 Cascade" (or
`?scene=cascade&variant=pool`).

## Steps

1. One pool per symbol asset at load time. Symbol types that are skins of one
   skeleton share the asset and so one pool. Prewarm about two grids (the old
   grid falls out while the refill falls in); `max` a bit above that.

   ```ts
   const pool = runtime.pool(asset, { prewarm: 98, max: 120 });
   ```

2. Refill: acquire and sleep on the pose shown while falling (the first
   `spinStop` frame), then tween the position only.

   ```ts
   const view = pool.acquire({ skin }).sleep({ animation: 'symbolSpinStop', time: 0 });
   grid.addChild(view);
   ```

3. Landing (staggered per column / row): play once, then sleep on the rest pose.

   ```ts
   view.play('symbolSpinStop', { sleepOnComplete: { animation: 'symbolIdle', time: 0 } });
   ```

   `sleepOnComplete: true` freezes the last `spinStop` frame instead. If the
   idle must keep looping, play it without `sleepOnComplete` (the view stays
   awake, still cheaper than pixi-spine).

4. Cleared symbols: `pool.release(view)` (removes it from its parent). A second
   release is ignored with a warning.

5. Check with `runtime.viewCounts` (`{ total, awake }`): between cascades
   `awake` should be 0.

Works the same for live, baked and multi-track (`clip.state`) clips, with tint
/ tint black, clipping attachments and hit tests (on the frozen pose).

## Measured after run planning (MacBook Air M4, 2026-10-14)

Same run, `--no-heap` ([reference](../../../bench-results/reference/2026-10-14-cascade/README.md)):

| variant | update ms | render ms | GL draws | frame interval | long frames |
|---|---|---|---|---|---|
| pool | 0.391 | 0.832 | 3 | 17.52 ms | 1/287 |
| sleep | 0.299 | 0.829 | 3 | 16.67 ms | 0/301 |
| awake | 0.820 | 0.986 | 3 | 16.66 ms | 0/301 |
| live | 0.637 | 1.188 | 3 | 16.67 ms | 0/301 |
| pixi-spine | 1.563 | 1.555 | 95.9 (max 142) | 35.07 ms | 24/144 |

## Measured (MacBook Air M4, 2026-10-08)

`npm run bench -- --scene cascade` (demo/cascade.ts): 7×7 grid, 98 symbols
falling at once per cascade (old grid out, refill in), staggered `spinStop`,
a cascade every 2.2 s; 3 s warm-up, 11 s measured (5 cascades). Nine symbol
types from seven skeletons on one shared 5-page atlas.

| variant | what it is |
|---|---|
| live | live (unbaked) views, posed every frame (first spinStop frame while falling, idle loop after landing): the always-live setup |
| awake | the same with baked animations |
| sleep | baked; asleep while falling, `play(..., { sleepOnComplete })` on landing; refills create views, cleared ones are destroyed |
| pool | sleep + `runtime.pool` refills (prewarmed) |
| pixi-spine | pixi-spine 4.0.6 `Spine` objects, always updated (the old-project baseline) |
| spine-official | Esoteric's official runtime, `@esotericsoftware/spine-pixi-v7` 4.2.120 `Spine` objects, always updated (added 2026-10-16; results: [2026-10-16-official](../../../bench-results/reference/2026-10-16-official/README.md): 70 draw calls vs 3, ≈ 2.8× CPU, ≈ 82 MB garbage and 15 GCs per cascade) |

### Metal, after the upload fix (f1264ba)


#### Metal, heap stats (`../../../bench-results/reference/2026-10-08-cascade/cascade-metal-fixed.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.710 / 1.160 | 1.109 / 1.725 | 19.84 (37) | 0/661 | 2731 | 1.2 | 11198 (0) |
| awake | 0.679 / 0.975 | 1.237 / 1.720 | 19.83 (37) | 0/661 | 2378.6 | 1 | 11215 (0) |
| sleep | 0.356 / 0.795 | 0.962 / 1.315 | 19.82 (37) | 0/661 | 2160.6 | 1 | 15832 (2981) |
| pool | 0.371 / 0.820 | 0.955 / 1.380 | 19.83 (37) | 0/661 | 2172.3 | 0.8 | 16375 (2981) |
| pixi-spine | 1.686 / 2.865 | 1.709 / 3.130 | 99.58 (154) | 199/400 | 13363.8 | 2.6 | 52136 (0) |

#### Metal, --no-heap (`../../../bench-results/reference/2026-10-08-cascade/cascade-metal-noheap-fixed.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.680 / 1.110 | 1.204 / 1.730 | 19.83 (37) | 0/661 | – | – | – |
| sleep | 0.355 / 0.760 | 0.912 / 1.240 | 19.85 (37) | 0/661 | – | – | – |
| pool | 0.373 / 0.805 | 0.994 / 1.380 | 19.83 (37) | 0/661 | – | – | – |
| pixi-spine | 1.585 / 2.705 | 1.552 / 2.645 | 100.7 (152) | 182/430 | – | – | – |

No lean frame is longer than 1.5× the median in any variant (0 GL buffer
rewrites per frame). pixi-spine still drops frames for the same reason the
Tabula renderer did (below): Pixi's batch renderer re-uploads its buffers 50
times per frame.

### Earlier runs (before the fix)

CPU 4× and low GPU were measured before the fix; the fix changes only how
batches are uploaded, and these profiles showed no lean long frames.

#### Before the fix: Metal, heap stats (precise memory + expose-gc) (`../../../bench-results/reference/2026-10-08-cascade/cascade-metal.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.501 / 0.955 | 0.804 / 1.365 | 18.85 (37) | 96/539 | 2844.6 | 1.2 | 11196 (0) |
| awake | 0.475 / 0.815 | 0.874 / 1.440 | 19.21 (37) | 43/618 | 2192.8 | 1 | 11211 (0) |
| sleep | 0.347 / 0.830 | 0.774 / 1.170 | 19.25 (37) | 43/617 | 2590.3 | 1.2 | 15800 (2981) |
| pool | 0.370 / 0.870 | 0.795 / 1.205 | 19.15 (37) | 39/620 | 1862.9 | 1.2 | 16373 (2981) |
| pixi-spine | 0.923 / 1.680 | 0.860 / 1.855 | 101.97 (152) | 83/570 | 16306.7 | 3.2 | 52120 (0) |

#### Before the fix: Metal, --no-heap (`../../../bench-results/reference/2026-10-08-cascade/cascade-metal-noheap.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.629 / 1.075 | 0.878 / 1.355 | 19.22 (37) | 60/597 | – | – | – |
| awake | 0.631 / 1.025 | 0.893 / 1.390 | 18.8 (37) | 78/576 | – | – | – |
| sleep | 0.383 / 0.955 | 0.780 / 1.175 | 18.77 (37) | 103/552 | – | – | – |
| pool | 0.378 / 0.980 | 0.824 / 1.315 | 19.06 (37) | 57/599 | – | – | – |
| pixi-spine | 1.490 / 2.255 | 1.526 / 2.660 | 102.49 (152) | 65/388 | – | – | – |

#### Before the fix: CPU 4x (CDP, vsync on), --no-heap (`../../../bench-results/reference/2026-10-08-cascade/cascade-cpu4x-noheap.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.259 / 0.775 | 0.572 / 1.210 | 19.84 (37) | 0/661 | – | – | – |
| awake | 0.253 / 0.785 | 0.609 / 1.290 | 19.83 (37) | 0/661 | – | – | – |
| sleep | 0.110 / 0.445 | 0.298 / 0.775 | 19.84 (37) | 0/662 | – | – | – |
| pool | 0.189 / 0.820 | 0.468 / 1.215 | 19.85 (37) | 0/661 | – | – | – |
| pixi-spine | 0.925 / 2.240 | 1.167 / 2.230 | 102.62 (153) | 32/629 | – | – | – |

#### Before the fix: CPU 4x, vsync off (--unthrottled), --no-heap (`../../../bench-results/reference/2026-10-08-cascade/cascade-novsync-cpu4x.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.366 / 0.940 | 8.224 / 14.945 | 17.93 (37) | 168/1236 | – | – | – |
| awake | 0.360 / 0.985 | 9.051 / 18.905 | 17.18 (37) | 255/1118 | – | – | – |
| sleep | 0.292 / 0.915 | 9.093 / 16.855 | 18.08 (37) | 149/1110 | – | – | – |
| pool | 0.239 / 0.890 | 8.409 / 16.735 | 17.65 (37) | 190/1218 | – | – | – |
| pixi-spine | 1.515 / 3.135 | 12.604 / 22.725 | 96.5 (155) | 131/728 | – | – | – |

#### Before the fix: Low GPU (SwiftShader in Chromium 153, 4 tex units, 0.5x tier, 800x360@2), --no-heap (`../../../bench-results/reference/2026-10-08-cascade/cascade-low-noheap.json`)

| variant | update ms mean / p95 | render ms mean / p95 | GL draws mean (max) | long frames | alloc KiB / cascade | GC / cascade | bytes / view (frozen) |
|---|---|---|---|---|---|---|---|
| live | 0.200 / 0.285 | 0.210 / 0.300 | 33.51 (51) | 2/659 | – | – | – |
| awake | 0.132 / 0.175 | 0.206 / 0.290 | 33.51 (51) | 0/661 | – | – | – |
| sleep | 0.089 / 0.175 | 0.191 / 0.250 | 33.51 (51) | 0/661 | – | – | – |
| pool | 0.100 / 0.195 | 0.210 / 0.285 | 33.44 (51) | 4/657 | – | – | – |
| pixi-spine | 0.467 / 0.710 | 0.416 / 0.660 | 102.31 (152) | 129/519 | – | – | – |

Reading the numbers:

- update ms = scene step (tweens, landing, animation); render ms = CPU time of
  `renderer.render` (without `--sync`, the GPU runs asynchronously).
- Sleeping cuts update time 30–60 % against awake views; the remaining
  update is the position tween and the views playing `spinStop`. pixi-spine
  needs 2.5–5× the update time and 5× the GL draw calls (it batches per
  attachment run, not per page).
- Lean draws are about 19 per frame in every lean variant: one symbol type in
  nine has a multiply slot, and multiply starts a new batch. Sleeping views
  batch exactly like awake ones.
- bytes / view: retained JS heap per resting symbol (200 created, `gc()`
  before and after). A sleeping view keeps its `Clip` (to wake instantly)
  plus the frozen frame (about 3 KB), so it holds about 16 KB against 11 KB
  awake; pixi-spine needs about 52 KB per symbol.
- alloc / GC per cascade: heap growth summed over frames (precise memory
  info) and the heap drops seen. The pool variant allocates least; the rest
  is mostly Pixi (`ShaderSystem.bind`) and the demo itself.
- CPU 4× via CDP with vsync on measures *lower* ms than 1× (the throttler's
  suspension slices rarely overlap sub-millisecond work, and the cores run at
  low clocks); the vsync-off run shows the scaling. Its render ms includes GPU
  back-pressure.
- Frame drops on Metal (fixed): before f1264ba every lean variant dropped
  6–18 % of frames on Metal (and pixi-spine 15–50 %) while the CPU time per
  frame stayed under 5 ms. A Chrome trace (`bench --trace`,
  `node scripts/trace-frames.mjs`) showed each long frame waiting on the GPU
  process executing our GL commands for 15–35 ms (median 0.6 ms). Cause: the
  Tabula renderer re-uploaded one shared vertex/index buffer for every batch,
  and a frame of the cascade has 19–37 batches (the multiply slot); a buffer
  rewritten after a draw of the same frame read it makes ANGLE on Metal stall.
  The game scene draws in one batch, so it never showed this. The renderer now
  uploads each batch of a frame into its own buffer pair (reused from frame to
  frame), and the benchmark reports GL buffer rewrites per frame (must be 0).
  Ruled out on the way: the mask (`--no-mask`: still dropping), heap
  tracking (`--no-heap`: still dropping), GPU time (`--sync`: render incl.
  `gl.finish` 0.5 ms), uploads at cascade start (drops spread over the fall).
- After the fix render ms (CPU) is 0.1–0.3 ms higher on Metal (the renderer
  now binds a different vertex array per batch); the frame interval is a
  flat 16.67 ms (p95 17.5 ms) in every lean variant.
- Multiply (and screen) cannot share the normal / additive blend state:
  premultiplied multiply needs `src·dst + dst·(1 − αs)`, and the destination
  colour can only enter the source factor through framebuffer fetch (not in
  WebGL) or dual-source blending (`WEBGL_blend_func_extended`, not on all
  devices). So multiply slots need their own batch. Since 2026-10-14 the
  renderer plans each run: symbols that do not overlap share the multiply
  batch and the normal batches around it, so the cascade draws in 3 calls
  (was 22 on average, 37 max) with identical pixels; render CPU −15 to −19 %.
  Overlapping symbols keep their order and can still add batches.
- Low GPU = SwiftShader with 4 texture units, which doubles the lean draws.

Reproduce:

```sh
npm run bench -- --scene cascade                      # Metal, with heap stats
npm run bench -- --scene cascade --no-heap            # timing only
npm run bench -- --scene cascade --no-heap --cpu-throttle 4
npm run bench -- --scene cascade --no-heap --gpu-profile low --executable-path <Chromium 153>
```
