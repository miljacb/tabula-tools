# Tabula app and export

The Tabula app reads a folder of Spine exports, plays them, and writes an
export folder a game loads through its [asset manifest](../../tabula-pixi/docs/api/manifest.md). It
does three things:

- **Read**: list every skeleton, sprite sheet and font, with its size, Spine version, errors and warnings.
- **Play**: preview a skeleton from its source JSON and from the export side by side, at any tier, with or without KTX2.
- **Produce**: choose what to compress and how, export, and see what it saved.

Compression is optional. A game can load raw exports (Spine JSON + atlas +
pages), compressed ones, or a mix, with the same code.

## Start

**Desktop app** (no Node needed by its users): open the app, then use
**Open folder…**, drop a folder onto the window, or pick a recent
project. File → Open Folder… (Cmd/Ctrl+O) switches projects.

```sh
# in the tabula-tools folder (next to tabula-pixi; build tabula-pixi first)
npm run desktop                # run it from the repo (builds first); add a folder to open it
npm run desktop:dist           # installers in dist-desktop/: .dmg (macOS), .exe (Windows), AppImage (Linux)
```

Each installer is built on its own platform. The app is not code-signed
yet: macOS asks to confirm it on first open (right-click → Open), Windows
shows SmartScreen. The KTX2 encoder and its cache go to the app's data
folder; the recent projects too.

**Browser**, from a terminal:

```sh
npx tabula app path/to/assets          # opens http://127.0.0.1:43300/
npx tabula app                         # start screen: recent projects, or type a folder path
npx tabula app path/to/assets -o dist/assets --port 8080 --no-open
```

A browser cannot hand a page the path of a dropped folder, so there the
folder is given on the command line or typed in. The server listens on
127.0.0.1 only. Repo development, in the tabula-tools folder: `npm run app`
(Vite, on `TABULA_PROJECT` or `../tabula-pixi/test-assets/`; exports of the test assets go
to `node_modules/.cache/tabula-app-export`), `npm run app:build` builds the
page `tabula app` serves (`dist-app/`).

## Workflow

1. The designer exports from Spine as **JSON** (4.1 or 4.2) with the atlas and its pages, into the project folder. Binary `.skel` is not supported.
2. During development the game loads these raw files through the manifest; see [Raw and compiled skeletons together](../../tabula-pixi/docs/api/manifest.md#raw-and-compiled-skeletons-together).
3. In the app, check the skeletons to compress and set the tiers and KTX2 codec, then press **Export**.
4. Compare source and exported in the preview, at each tier, and approve the exported version: it is what players will see.
5. Ship the export folder. Designers can also send an export folder instead of raw files.

## Export modes and `.tbla`

| | Release (default) | Development |
|---|---|---|
| Bundles | Per load group and tier: `game.tbla` (data, and pages without a KTX2 copy), `game.ktx2.tbla` (KTX2 pages), `game.images.tbla` (the image copies of those pages); `game@0.5x.tbla` … per tier; `base…`, `bonus…` with load groups. Without KTX2 one bundle per group and tier. | One `.tbla` per asset and tier: `symbol1.tbla`, `symbol1@0.5x.tbla` |
| Pages | Skeletons of a page set share repacked atlas pages (fewest draw calls) | Each skeleton has its own pages |
| Use | Shipping | Swapping or sending one asset at a time; each bundle has its manifest inside, so it opens on its own |

`format: "files"` writes loose files instead (inspect, debug).

A `.tbla` holds the files of an export by path, each with a CRC-32: the
embedded manifest (development bundles) first, skeletons and data next,
KTX2 pages next, PNG pages last; within each, in the order the load group
lists its assets. Data files (`.tbin`, `.baked`, JSON) are stored
deflated where that saves 10% or more (format version 2; read with
`DecompressionStream`, every current browser, Safari from 16.4); pages and
images are stored as they are, so HTTP compression of `.tbla` gains
little.

Each tier is its own set of files, so a device downloads one tier. Release
bundles are split by page format: a device with KTX2 support reads the data
and KTX2 bundles, any other device the data and image bundles, so neither
downloads the copy it does not use. An image goes into the image bundle
only when the KTX2 copy of the same page and tier exists; images every
device needs stay in the data bundle. The manager reads a bundle as it
streams in and stops the download once the group is loaded (a file needed
later, e.g. a PNG fallback for a page whose KTX2 failed, comes by HTTP
range request). The app's report shows what one device downloads per tier,
with and without KTX2, measured on the bundles written. Language font
variants go into their own bundle (`fonts.ka.tbla`), loaded with the
language. `tabula inspect x.tbla` lists a bundle (checksums checked,
deflated sizes shown); `--unpack <dir>` writes its files, unpacked.

The game code is the same for every mode and format:
`TabulaAssetManager.load('assets.manifest.json')`, then assets by name.
`TabulaAssetManager.load('symbol1.tbla')` opens a development bundle alone.

**Images.** PNG / WebP / JPG files not used by an atlas, sprite sheet or
font are exported as textures (tiers, KTX2): `manager.getTexture('logo')`.
Sprite sheet images are pages too (tiers, KTX2), frames scaled per tier.

## Page sets and load groups

- **Page set** (`atlas.groups`): which skeletons share atlas pages. Drawn together → one page set → fewer draw calls, less GPU memory.
- **Load group** (`loadGroups`): which assets are initialized together (decoded and uploaded to the GPU). Download can happen earlier (`preloadGroup`).

Select a skeleton in the app and pick its page set and load group below the
preview ("New…" creates one). A name assigned there wins over patterns
(`symbol*`) of other sets. When a page set holds skeletons of several load
groups, the app warns: initializing one group uploads the whole page.

## Scene and performance

Show → **Scene**: the selected skeleton's page set, repeated (Count), from
the export when there is one. Live: draw calls (and why each extra batch
broke), GPU memory, CPU per frame, pages, triangles, FPS. **Weak device**
(desktop app) slows the CPU 4× or 6× like a cheap phone.

## Export settings (`tabula.config.json`)

The app saves its settings in the project folder; every field is optional.
This file and the export folder (`tabula-export/`) are all Tabula adds to a
project. Keep the file with the project (commit it, send it along): it is
how the next export, or someone else's, uses the same settings. It is only
written once a setting is changed.

```json
{
  "tiers": [2, 1, 0.5],
  "ktx2": "uastc",
  "ktx2Quality": 2,
  "imageFormat": "png",
  "atlas": {
    "maxSize": 2048,
    "groups": [{ "name": "reel", "skeletons": ["symbol*", "reel*"], "pages": { "reel_2": "etc1s" } }]
  },
  "bake": { "maxError": 0.05 },
  "loadGroups": { "groups": { "base": ["symbol*"], "bonus": ["bonus*"] }, "preload": ["bonus"] }
}
```

| Field | Default | Meaning |
|---|---|---|
| `tiers` | `[1]` | Resolution tiers of the atlas pages and sprite sheets. Below 1: downscaled. Above 1: from `<name>@2x` exports, never upscaled ([tiers above 1](../../tabula-pixi/docs/api/textures-ktx2.md#tiers-above-1)). |
| `ktx2` | `none` | `uastc` (quality) or `etc1s` (small) KTX2 pages; per group or page in `atlas.groups`. Trade-off: KTX2 devices download more (test assets, 1x: 10.9 MB vs 7.3 MB) but use about 4× less GPU memory (22 MB vs 89 MB). |
| `atlas` | one group | Packing and co-draw groups: skeletons drawn together share pages (fewer draw calls). |
| `bake` | on | Baked animations (`.baked`); `false` plays everything live. |
| `loadGroups` | everything in `base` | The manifest's load groups. |
| `mode` | `release` | `release` or `development` (see above). |
| `format` | `tbla` | `tbla` bundles or loose `files`. |
| `images` | `true` | Export standalone images. |

## What an export writes

| Path | What |
|---|---|
| `assets.manifest.json` | The manifest over exactly the files below. |
| `<skeleton>.tbin`, `<skeleton>.baked` | Compressed skeletons. |
| `<group>.png`, `<group>@0.5x.png`, `<group>.ktx2`, … , `<group>.textures.json`, `<group>.atlas` | Repacked pages per co-draw group, per tier and format. |
| `raw/…` | Skeletons exported raw: JSON, atlas and pages as the designer exported them. |
| `sprites/…` | Sprite sheets, with `@0.5x` tiers (frames scaled, `meta.scale` set so sprites keep their size) and KTX2 pages when `ktx2` is set. |
| `images/…` | Standalone images, as pages of their own (tiers, KTX2). |
| `fonts/…` | SDF fonts from `tabula font`, copied. |
| `export-report.json` | The report the app shows: per skeleton what it became and why, sizes, tiers, warnings. |
| `.tabula-export` | Marks the folder as an export. |

**Nothing is reused from earlier exports.** The export empties its folder
first (only a folder with `.tabula-export`; any other non-empty folder is
refused), so the game only loads what this export wrote. Only KTX2
encodings are cached, by content hash, in the tools cache
(`node_modules/.cache/tabula/ktx2` of the tools, the desktop app's user
data folder, or `$TABULA_CACHE_DIR`), never in the project (encoding takes
seconds per page). A `.tabula-cache/` folder left in a project by older
versions can be deleted.

**When compression fails** for a skeleton (validation errors, a missing
`@2x` export, a repack error), it is exported raw and the app says why. The
game plays it from its JSON (needs `json: spineJson`); nothing older is
used in its place.

## Deploy checklist

- Upload the whole export folder; paths in the manifest are relative to it.
- Serve `basis_transcoder.js` and `.wasm` from tabula-pixi's `vendor/basis/` (same folder) when the export has KTX2 pages, and pass `transcoder` to the manager.
- MIME types: `.wasm` → `application/wasm` (required for streaming compilation), `.ktx2` → `image/ktx2`, `.tbin` / `.baked` → `application/octet-stream`.
- Caching: pass `cacheBust: true` to the manager (URLs get `?v=<content hash>`) and cache files for a long time; serve `assets.manifest.json` with `Cache-Control: no-cache`.
- Pass `json: spineJson` if any skeleton may be raw.
- Choose the tier in the game (`tier`, default 1); `availableTiers()` gives the cost of each.

## Versions

| What | Policy |
|---|---|
| Spine JSON 4.1, 4.2 | Supported. |
| Spine JSON 4.3 and later 4.x | Read best-effort: a warning names the version and any section the runtime ignores. Check the preview. |
| Spine 5.x | Rejected until supported ("not supported yet"). |
| Spine before 4.1 | Rejected: re-export as 4.1 or 4.2. |
| Spine binary `.skel` | Not supported: export JSON. |
| `.tbin`, `.baked` | Versioned; a runtime reads a range of versions and names the problem otherwise ("recompile the skeleton"). |
| `assets.manifest.json` | Version 1 without raw skeletons (older runtimes read it), 2 with them. |

## In code

The export is one function, also usable from build scripts (Node; needs the
optional `sharp` dependency):

```ts
import { exportProject } from 'tabula-tools';

const report = await exportProject({
  sourceDir: 'assets', outDir: 'public/assets', compress: ['symbol*'],
  config: { tiers: [1, 0.5], ktx2: 'uastc' },
  onEvent: (e) => console.log(e),
});
```

`report`: `skeletons` (per name: `format`, `reason`, `group`, `warnings`,
`bytes`, `sourceBytes`), `sprites`, `fonts`, `bundles` (path, tier, group,
`kind`: data / ktx2 / images / asset, size), `tiers` (page download and GPU
memory per tier), `downloads` (what one device downloads per tier, with and
without KTX2, measured on the files written; font variants per language),
`warnings`, `sourceBytes`, `outputBytes`, `ms`, and the `manifest`.
