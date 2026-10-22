# Asset health inspector

Automatic export and runtime health reports for skeletons in the Tabula viewer.

## Input

Scans read the Spine **`.json`** export. Runtime numbers (draw calls, vertices) come from tabula-pixi's own batching rules.

## Scores

| Score | Meaning |
|-------|---------|
| **Overall** | Default mix: 60% runtime + 40% export (0–100). |
| **Runtime** | Sampled playback cost: bones, mesh/draw calls, clipping, blends, constraints. Inspired by [Spine Benchmark](https://github.com/schmooky/spine-benchmark) categories (MIT). |
| **Export** | Data lint: key rates, deform/attachment/draw-order density, atlas VRAM estimate, skeleton size. |

### Atlas VRAM on a multi-skeleton stage

Sizes are decoded pixels, not file size: `width × height × bytes per pixel` (4 for RGBA), plus the exact mipmap chain (every level down to 1×1) when mipmaps are on. MB = 1024 × 1024 bytes. Pixi uploads a texture on its first draw; pages nothing has drawn yet are flagged “not uploaded yet”.

When more than one skeleton is on stage, each skeleton is charged only what it **adds**, walking skeletons in z-order (lowest first):

- **Shared** — same GPU texture (`baseTexture.uid`) as a lower skeleton, e.g. made with Duplicate. Costs 0.
- **Duplicate** — same image file (name + decoded size) but a separate upload, e.g. the same files imported twice. Costs its full size again and raises an **export-atlas-duplicate** warning.
- **New** — first upload of that page.

Warn at 16 MB added, fail at 32 MB. The Performance panel and the health list use the same numbers: total GPU MB and texture count for All, and size / pages / “adds X MB” / shared / duplicate counts for the selected skeleton.

**Bands:** Excellent 85+, Good 70–84, Moderate 55–69, Poor 40–54, Critical below 40. Bands are guidance, not guaranteed frame times.

## Runtime sampling

For each animation, the scanner steps track 0 through time (20 Hz, capped at 80 samples, so long clips sample more sparsely), applies the pose, and measures vertices, draw calls, clipping and blend modes. Each clip is scored on its **peak pose**: the highest value of each metric across all samples, so the score always matches the Peak DC / Peak verts shown. The asset runtime score is the lowest of the setup pose and every sampled clip; zero-length clips are not sampled and not scored.

Draw calls, vertices and triangles are counted exactly as tabula-pixi's renderer batches (its `SkeletonRenderer` walk into a `BatchCounter`): up to 8 atlas pages per call (or fewer, from the Performance panel's Texture units), Normal and Additive in one blend state, Multiply and Screen in their own; inactive bones and transparent slots draw nothing; clipped meshes count their clipped vertices.

Thresholds: bones warn above 60; vertices warn above 300, fail above 600; draw calls warn above 8, fail above 16; clipping warns above 2 masks; blend modes warn with two or more non-Normal modes. Each runtime metric is its own penalty category (warn −5, fail −15, at most −30 per category).

Export key counts read Spine 3.x and 4.x JSON: split bone timelines (`translatex`…), slot `rgba`/`rgb`/`alpha`, IK/transform/path/physics timelines, and deform keys in both the 4.0 `deform` and 4.1+ `attachments` layouts.

## UI

- **Inspect** (stage toolbar): one selected instance → detail modal.
- **Asset health**: all instances, worst overall first, with worst clip; **Atlas** column is live marginal VRAM on stage; row opens detail.
- **Detail**: overall score with how runtime and export were derived, setup-pose stats, where points are lost per category, asset issues grouped by category with what/fix text, and every animation as an expandable row (peak numbers, JSON key stats, its own runtime and export issues).
- Outliner **health score chip** (right of the asset name) opens that asset’s report; **♥ Asset health** on the stage toolbar opens the full list.
- **Re-scan** / **Copy report JSON** in the detail modal.

## Report JSON

Copied JSON uses `schemaVersion: 1` with scores, findings, and per-animation rows for CI or spreadsheets.
