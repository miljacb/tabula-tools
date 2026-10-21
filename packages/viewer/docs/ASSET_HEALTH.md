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

Per-asset atlas warnings use **marginal** VRAM when more than one skeleton is on stage: atlas pages are deduped by **file name + decoded size** (`contentPageKey`), in **z-index order** (first skeleton “owns” a shared WebP).

The **Asset health** modals also show **stage totals**:

- **Unique by file** — same mental model as one copy of each WebP on the stage.
- **Unique GPU** — distinct Pixi texture uploads (`uid`); duplicate imports of the same file still get separate uploads unless they share the same atlas object.
- **Stacked** — sum of each skeleton’s local atlas estimate (upper bound when every drop re-uploads textures).

**Bands:** Excellent 85+, Good 70–84, Moderate 55–69, Poor 40–54, Critical below 40. Bands are guidance, not guaranteed frame times.

## Runtime sampling

For each animation, the scanner steps track 0 through time (20 Hz, capped samples), applies the pose, and measures vertices and draw calls. The **worst** animation runtime score drives the asset runtime score.

Setup pose is also measured once for static skeleton findings.

## UI

- **Inspect** (stage toolbar): one selected instance → detail modal.
- **Asset health**: all instances, worst overall first; **Atlas** column is live marginal VRAM on stage; row opens detail.
- Scene list **health score chip** (left of name) opens that asset’s report; **♥ Asset health** on the stage toolbar opens the full list.
- **Re-scan** / **Copy report JSON** in the detail modal.

## Report JSON

Copied JSON uses `schemaVersion: 1` with scores, findings, and per-animation rows for CI or spreadsheets.
