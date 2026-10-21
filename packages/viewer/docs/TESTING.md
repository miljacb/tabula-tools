# Manual test checklist

Run `pnpm dev` and open the printed URL. Automated checks are `pnpm test` (snap math, atlas page names, scene JSON, perf maths).

## Samples

- Load samples. Two skeletons appear.
- Slots (`1`), performance (`2`), skins (`3`), animations (`4`), and bones (`5`) toggle.
- Select a slot. Cycle the mask color (green, blue, red) and turn on slot color pulse.
- Mix skins on the badge (`default` and `plain`).
- Put `idle` on track 0 and `pulse` on track 1. Dots use the track colors. Clear a track.
- Seek with the range and with Arrow Left / Arrow Right (1 ms tap, 10 ms while held).
- Select a bone. X, Y, rotation, world scale, and local scale update while the animation plays.
- Performance shows memory, vertices, draw calls, constraints, clippings, and blends. Toggle Selected / All.
- Zoom, reset, fit, and fit selection keep both sprites in view. Drag empty canvas to pan. Wheel zooms toward the cursor.

## Composer

- Drag one sprite into the other. Edges or centers snap. Magenta guides appear. Alt drags freely. Shift locks the drag to one axis. Snap can be turned off in the toolbar.
- Scene list: rename, hide, lock, reorder, duplicate, delete. `[` and `]` change order. Locked sprites are not dragged.
- Save writes `spine-scene.json`. Open scene, choose the sample files, and the transforms come back.
- Reload the tab: dropped files and atlas images are gone. Drop them again to continue.
- Menu **Clear all assets**: confirm, then the stage is empty after reload. A second reload stays empty.

## Files

- Dropping a `.skel` shows a message to export JSON. A Spine 3.8, 4.0 or 4.3 JSON file is refused with tabula-pixi's version message and is not added.
- A real export (JSON, atlas and every page image) loads, plays every animation, and the debug toggles (bones, regions, mesh hulls, bounding boxes, IK) draw on top.

## Exports

Make one with `tabula app` (Export) or `exportProject`, then:

- Drop a single `game.tbla` of a simple release export (as Studio writes it): it opens on its own. Drop `assets.manifest.json` with its bundles (`game.tbla`, `game@0.5x.tbla`, `game.ktx2.tbla`… of a release with tiers, load groups or KTX2), with every `<name>.tbla` (development) or with all the loose files (`files` export). A chooser lists the skeletons (all ticked up to 12) and, for an export with several tiers, a Tier select (the pages load at that tier). Add puts the skeletons side by side, spaced by their size while the idle animation plays, and fits the stage.
- Drop one `<name>.tbla` of a development export: it opens on its own. Drop one bundle of a split release (for example `game@0.5x.tbla`) alone: a message asks for `assets.manifest.json` with it. Drop the manifest alone: it names the missing bundles.
- Play animations, toggle debug overlays, select slots: same as raw skeletons. Asset health on a compiled skeleton shows "Compiled export" instead of export-data findings.
- Save the scene, Open scene and drop the export with the scene file: the instances come back with their animations.

## Build

- `pnpm build` emits `dist/` with a `pixi` chunk and a `tabula` chunk.
- `netlify.toml` publishes `dist/`.
