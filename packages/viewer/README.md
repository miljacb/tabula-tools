# Tabula Viewer

Browser composer for Tabula skeletons. Drop a Spine JSON export (4.1 or 4.2), its atlas and page images onto the canvas. Arrange several skeletons, snap their edges, and inspect each asset's bones, slots, attachments, skins, constraints, events and draw order in one outliner tree, plus animations, draw calls and asset health.

Everything is drawn and played by [tabula-pixi](https://www.npmjs.com/package/tabula-pixi) on PixiJS 7: the same runtime a game uses, so what you see is what the game plays. There is no Spine runtime in this app.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Asset health](docs/ASSET_HEALTH.md)
- [Manual test checklist](docs/TESTING.md)

## Run locally

From the repository root (this package is a pnpm workspace package):

```bash
pnpm install
cd packages/viewer
pnpm dev
```

Open the printed local URL. Use **Load samples** to drop two placeholder skeletons on the stage, or drag your own `.json` plus the matching `.atlas` and page images.

```bash
pnpm test
pnpm build
```

## What it loads

| Input | Status |
|---|---|
| Spine JSON 4.1 / 4.2 + `.atlas` + PNG / WebP pages | Supported. Played live by tabula-pixi. |
| Tabula export: `assets.manifest.json` with its `.tbla` bundles or loose files, or one self-contained `.tbla` | Supported, loaded by tabula-pixi's `TabulaAssetManager` exactly as a game does (compiled and baked skeletons, tiers, KTX2). An export with several skeletons asks which to add, and at which resolution tier when it has more than one. |
| Binary `.skel`, Spine 3.8 / 4.0 / 4.3 | Not supported by tabula-pixi. Export as JSON 4.1 or 4.2. |

## Deploy

`netlify.toml` publishes `dist/`. No server is required.

Dropped atlas images are not kept after **reload** or closing the tab. Drop the files again to continue. **Menu → Clear all assets** also removes UI prefs, as if the app had never been opened here.

## Input routing

- Wheel on the canvas zooms the camera around the cursor.
- Pointer down on an unlocked instance selects it and starts a move. Bounds are snapshotted for snapping. A hit on a region or mesh attachment also selects that slot.
- Pointer down on empty canvas starts a marquee (or pans with Space / middle mouse).
- Space held forces pan even when the pointer starts on an instance.
- Shift during a move flips instance-edge snap and grid snap.
- Guide lines are a Pixi `Graphics` object on a layer above the world.

## Asset loading

Raw Spine files:

`src/tabula/loader.js` parses the atlas and skeleton with tabula-pixi's JSON adapter, validates them, loads each atlas page from its object URL (blob URLs have no directory, so pages are matched by atlas page name) and builds a `TabulaAsset`. Each instance is a `TabulaView` (a tabula-pixi `ClipView` the viewer updates itself) that shares its asset with other instances of the same skeleton. Object URLs and textures are released when the last instance of an asset is deleted.

Exports (`.tbla`, manifest): `src/tabula/package.js` serves the opened files from memory to the manager, which gets a manifest URL and a `fetch` that answers from them (nothing touches the network; a manifest with loose files is packed into one in-memory bundle). `src/tabula/exportManager.js` opens the manager (JSON skeletons through `tabula-pixi/json`, KTX2 pages through tabula-pixi's Basis transcoder), lists the skeletons and loads the groups of the chosen ones. The manager's assets become instances like any other and are freed when the last of them is deleted. Scenes saved with such instances open again when the export is dropped with the scene file.

## Persistence

`sceneFile.js` serializes the scene. Pixi objects and `File` blobs are not serialized. On open, the user drops a folder that contains every `assetKey`; the restorer matches by file name.

Panel and overlay prefs are stored in `localStorage` under `spine-viewer-web.ui`.
