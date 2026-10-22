# Performance panel

Everything the panel shows, top to bottom, and where each number comes from.

## Budget

A target for the whole stage: **Mobile · low end**, **Mobile · high end**, **Desktop**, or **Custom** (frame ms, draw calls, vertices, VRAM MB). Presets are starting points for a typical game screen, not platform rules. Values turn amber above 80 % of a limit and red above it, in the panel and in the health list footer. The choice is saved with the UI state.

## Frame

- **FPS** against the display rate. Browsers do not report the refresh rate, so it is estimated from the fastest 10 % of frames and snapped to a common rate (60, 120, 144 …).
- **Graph**: last 10 s, reference lines at 30, 60 and the display rate; red ticks mark stutters.
- **Frame time**: average and worst frame interval over 10 s. **1 % low**: average FPS of the slowest 1 % of frames.
- **Stutters**: frames longer than twice the display's frame time, with the likely cause — a texture uploading to the GPU (the GPU texture count rose that frame), a browser long task (Chrome / Edge), slow update or render work, or none of those (browser / GPU) — and what was playing.
- **CPU**: milliseconds of the last frame spent in the viewer's update (skeletons + UI) and in Pixi's render call. GPU time is not measurable from a page.

## Stage · last frame

The Tabula renderer's own counts (`lastFrameStats`): draw calls, triangles, vertices, peak over 10 s, and why extra draw calls were needed (textures, blend mode, vertex limit). Pixi graphics such as guides are not included.

## Memory

- **JS heap** (Chrome / Edge, `performance.memory`): coarse and delayed by the browser on purpose; JS objects only.
- **Measure page memory** (`performance.measureUserAgentSpecificMemory`): appears only when the page is cross-origin isolated (the dev and preview servers send the headers). JS, DOM and canvas, by type. Never GPU memory — use Chrome's Task Manager (Shift+Esc) for that.

## Selected skeleton / All skeletons

Counted with tabula-pixi's `SkeletonRenderer` + `BatchCounter`, the renderer's own rules: up to 8 atlas pages per draw call, Normal and Additive share a blend state, Multiply and Screen need their own; inactive bones and transparent slots draw nothing; clipped meshes count clipped vertices. *Selected* draws the skeleton alone; *All* draws the visible skeletons together in z-order and world space, so they batch with each other as on screen.

**Texture units** (8 / 4 / 2 / 1) recounts as if the GPU allowed fewer units per draw call. It changes these counts and the health scan, not the live renderer.

Also: **CPU update** (smoothed ms per frame for the skeleton), **Load** (parse, decode or KTX2 transcode, and GPU upload when it was opened; exports show tabula-pixi's per-page load report), bones, constraints, clippings, mask vertices, blends.

## Atlas VRAM

See [ASSET_HEALTH.md](ASSET_HEALTH.md#atlas-vram-on-a-multi-skeleton-stage). KTX2 pages count their compressed level buffers.

## Recording

**Record** captures every frame for up to 60 s (frame time, CPU update / render, draw calls, vertices, triangles, stutter cause, JS heap, what was playing). **Export JSON** adds a summary (average / worst frame, 1 % low, stutters, peaks), the budget, and each skeleton's numbers; **Export CSV** has one row per frame.

## Per skeleton (All)

Each skeleton drawn alone: draw calls, vertices, CPU ms per frame, and the atlas VRAM it adds. Click a row to select it.
