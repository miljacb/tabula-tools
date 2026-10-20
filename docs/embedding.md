# Recreating the export in another app

Written for: engineers who will run or port the Tabula export inside their own tool.

This is the logic of the export, not the UI. The engine is `exportProject` in
[src/export/export-project.ts](../src/export/export-project.ts). Everything it
needs is in `src/export/` and the `tabula-pixi` package (`tabula-pixi/core/*`), so an app can call it directly or
port the steps below.

## What goes in and out

**Input: a source folder** of Spine exports, as the designer produced them:

- Skeletons as **JSON** (Spine 4.1 or 4.2), each with its `.atlas` and the
  atlas pages (PNG or WebP) next to it. Binary `.skel` is not supported; the
  engine warns and skips it.
- Sprite sheets (`*.json` with a `meta.image`, plus the image).
- Standalone images.
- SDF fonts from `tabula font` (`*.font.json` with its pages).
- An optional `tabula-project.json` (see `PROJECT_CONFIG_FILE` in
  [src/export/config.ts](../src/export/config.ts) and `loadProjectConfig`): output
  format and mode, atlas size and padding, load groups, tiers, image format,
  quality, KTX2 codec, bake settings.

**Output: an export folder** containing:

- `assets.manifest.json`: the index the game loads. Lists every file, its
  tiers, load groups and sizes.
- For each compressed skeleton: `<name>.tbin` (compiled data) and
  `<name>.baked` (pre-baked samples, when baking succeeded).
- For each atlas group: its pages per tier (and KTX2 pages), a
  `<group>.atlas` text file, and a textures manifest.
- `raw/`: skeletons that could not be compressed, as they were exported.
- `sprites/`, `images/`, `fonts/`: the other assets.
- Release mode (default): `.tbla` bundles per load group and tier, and the
  manifest points at them. Development mode: one `.tbla` per asset and tier.
- `export-report.json`: what was written, warnings, fallbacks and sizes.

The output folder is emptied before writing. It must contain the
`.tabula-export` marker, or be empty; any other folder is refused, so the
engine never deletes someone's files.

## The steps, in order

`exportProject` runs these phases. Each has a weight in the progress bar
(`PHASE_WEIGHTS`), and the order matters because later steps read earlier
output.

### 1. Read and discover

`discoverProject` finds the skeletons, sprite sheets, standalone images and
fonts. Nothing is written yet.

- Each skeleton is checked: JSON and atlas must both exist, and every atlas
  page must exist. A skeleton missing its atlas is not exported.
- Decide the image format. If the atlases use WebP pages and no format is set,
  the output uses WebP. A PNG copy of lossy WebP grows several times, so this
  default matters.

### 2. Validate the skeletons to compress

For each skeleton selected for compression (`compress` option, names or globs;
default all):

1. Parse the atlas (`AtlasParser`) and the skeleton (`SpineJsonParser`).
2. Validate with `validateSkeleton(data, atlas)`. Errors stop compression for
   that skeleton; warnings are kept in the report.
3. Load higher-resolution atlases for the other tiers (`loadHiResAtlases`).

A skeleton that fails any of this is **exported raw** (`fallback`). Raw means
the game plays it from its JSON, so the export never loses an asset.

Skeletons not selected are also raw (`not selected for compression`).

### 3. Repack the atlas pages

`repackAtlases` in [src/export/pack/repack.ts](../src/export/pack/repack.ts).

- Skeletons are grouped into **co-draw groups** (`config.atlas.groups`, with
  glob patterns; unmatched skeletons go to `misc`). In development mode every
  skeleton is its own group.
- Within a group, all regions from all its atlases are packed into new pages
  (MaxRects, `src/export/pack/maxrects.ts`), with the settings: `maxSize`
  (default 2048), `padding` (2), `extrude` (0), rotation on, power-of-two
  pages.
- Result: one new atlas per group. Skeletons in the same group then draw from
  the same pages, which means fewer draw calls at runtime.
- Each region records where it came from, so its higher-resolution copies can
  be found for the higher tiers.

Repacking is per group, so one page set can serve many skeletons.

### 4. Encode the pages, per tier

`encodeGroupPages` in [src/export/pages.ts](../src/export/pages.ts), for each
group:

- For each **tier** (`tiers` in the config; tier 1 is the 1× size), the pages
  are scaled to the tier size. Tiers above 1 are rendered from the
  higher-resolution exports (`renderTierPages`), cut to the 1× layout. They are
  **never upscaled**.
- Each page is written as an image in the chosen format (PNG or WebP at
  `quality`), and, if KTX2 applies to that page, as a KTX2 texture
  (`encodeKtx2`, `src/export/pack/ktx2.ts`, which calls the `ktx` tool). KTX2
  is chosen per group and per page by `ktx2Selector` from the config.
- KTX2 encodings are cached by a hash of the input pixels and settings
  (`cachedKtx2`, `src/export/export-project.ts`). A cached file is the same as
  a fresh encode, so re-exports are fast. The cache is never inside the project.

Which tiers a device downloads is decided later by the manifest; this step
writes all of them.

### 5. Compile and bake the skeletons

For each skeleton in an encoded group, with its group's atlas:

- **Compile** with `compileSkeleton` (`tabula-pixi/core/slb-writer.js`).
  This turns the Spine JSON into the `.tbin` binary, referencing regions by
  the repacked atlas. It is the data the runtime loads.
- **Bake** with `bakeToBuffer` (`tabula-pixi/core/bake-report.js`),
  unless `config.bake` is off. Baking pre-computes the animation samples
  within `maxError` (`DEFAULT_BAKE_MAX_ERROR`), so the runtime can play
  without evaluating the curves live. If baking fails, the skeleton still
  exports, and the game plays it live (a warning is recorded).
- A failure in compile makes the skeleton raw (`compile failed`).

### 6. Copy the raw skeletons and fonts

Skeletons that are not compressed are copied under `raw/`, with their JSON,
atlas and pages, as the designer exported them. Fonts (`*.font.json` and their
pages) are copied under `fonts/`.

### 7. Sprite sheets and standalone images

Each sprite sheet and image gets its own pages, encoded like atlas pages
(tiers, KTX2). Sprite sheet frames are rescaled to each tier's exact page size
(`scaleSpriteSheet`). Standalone images are recorded in the manifest's
`images` section.

### 8. Build the manifest

`buildAssetManifest` (`tabula-pixi/core/manifest.js`) runs
over exactly the files written. It records:

- every file, its size and content hash,
- each skeleton's group, tiers and costs (`TierCost`: download and GPU
  memory per tier),
- load groups from the config (`loadGroups`), which decide what loads together
  (for example `base` and `bonus`).

Warnings from the manifest and page conflicts (a page shared by several load
groups) are added to the report. Pages shared by several load groups are reported as
conflicts, so review them.

### 9. Pack `.tbla` bundles (release mode)

`packBundles` in `export-project.ts` groups the files into bundles, one per
load group and tier, with the manifest embedded so each bundle can be read on
its own.

- Bundles are split by kind: data (`.tbin`, `.baked`, JSON) first, KTX2
  pages next, image copies last. A device that supports KTX2 never downloads
  the image copies.
- Data files may be deflated (`.tbla` version 2). Pages are not, because they
  are compressed already.

The format is documented at the top of tabula-pixi's `src/core/tbla.ts`.
`writeBundle` writes it; `readBundle` reads it back for checks.

Development mode skips the bundling and writes one `.tbla` per asset and tier
(see [app.md](app.md#export-modes-and-tbla)).

### 10. Write the manifest and report

`assets.manifest.json` and `export-report.json` are written last. The engine
does not print or exit: it reports through `onEvent` (progress, steps,
warnings, fallbacks) and returns the report.

## Settings that change the output

| Setting | Effect |
|---|---|
| `config.mode` (release / development) | Group repacking and bundling. Default release. |
| `config.format` (`tbla` / `files`) | Whether bundles are written. Default `tbla`. |
| `compress` (option) | Which skeletons are compressed. Others are raw. |
| `config.atlas` | Page size, padding, extrude, co-draw groups. |
| `config.tiers` | Resolution tiers, e.g. `[2, 1, 0.5]`. Tier 1 is always included. Each tier multiplies the page work. |
| `config.imageFormat`, `quality` | Page image format and quality. |
| `config.ktx2`, `ktx2Quality` | KTX2 codec per group; `none` turns it off. |
| `config.bake` | Bake settings, or `false` to skip baking. |
| `config.loadGroups` | How the manifest groups files for loading. |
| `cacheDir` | KTX2 cache location. |

## Porting checklist

To run the same export in another app, you need:

1. **Node** (the engine uses `node:fs` and `sharp`). A browser or a non-Node
   runtime cannot run it as is.
2. **The engine** (`src/export/`) and the `tabula-pixi` package it imports
   the runtime modules from (`tabula-pixi/core/*`).
3. **The `ktx` tool**, if KTX2 is used: `tabula ktx-tool --install`, or
   `TABULA_KTX` pointing at your binary. Or pass your own `encodeKtx2`
   (the option returns `null` to keep a page as an image).
4. **Sharp**, an optional dependency of the package, for image decode and
   encode. Install it where the export runs.

Then:

```ts
import { exportProject, loadProjectConfig } from 'tabula-tools';

const config = await loadProjectConfig(sourceDir); // optional tabula-project.json
const report = await exportProject({
  sourceDir,
  outDir,
  config,
  compress: ['hero*', 'symbol*'],   // optional; default: all
  onEvent: (e) => { /* progress, steps, warnings, fallbacks */ },
});
// report.manifest, report.skeletons (per-skeleton format, reason, warnings), report.bundles
```

To port without the package, follow the steps above with the same modules.
Each step is a function you can call alone: `discoverProject`,
`repackAtlases`, `encodeGroupPages`, `compileSkeleton`, `bakeToBuffer`,
`buildAssetManifest`, `packBundles`, `writeBundle`.

## Known gaps

- `tabula app` (the `app` command and desktop shell) still loads the Basis
  transcoder from a tabula-pixi checkout. The export itself does not.
- Tests, the app and the demo scripts still use the tabula-pixi checkout.
- Binary `.skel` input is not supported.
