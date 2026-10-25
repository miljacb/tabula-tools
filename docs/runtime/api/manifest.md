# Asset manifest and load groups

One JSON file lists every skeleton, baked file, page (with tiers and KTX2
files), texture set, sprite sheet and SDF font of a build, grouped into **load groups**
(for example `base` for the reels, `bigwin` for win celebrations). The
`TabulaAssetManager` loads, preloads and unloads groups, sharing pages between
loaded groups by reference count. Both bridges export it with the same API
(`tabula-pixi` and `tabula-pixi/pixi-v8`; the group logic is shared code).
Example: [`docs/examples/manifest.ts`](../examples/manifest.ts).

## Build

The [Tabula app](../../../tabula-tools/docs/app.md) writes the manifest with every export. From the
command line:

```sh
npx tabula repack assets/ -o public/assets --groups atlas-groups.json --compile --bake --ktx2 uastc --tiers 1,0.5
npx tabula manifest public/assets --load-groups load-groups.json   # writes public/assets/assets.manifest.json
```

`load-groups.json`:

```json
{
  "groups": {
    "base": ["backgroundLandscape", "reelLandscape", "symbol[1-9]", "*Button"],
    "bigwin": ["bigWinGradingLandscape", "megaWin*"]
  },
  "defaultGroup": "extras",
  "preload": ["bigwin"]
}
```

- Patterns are globs (`*`, `?`, `[a-z]`) over skeleton, sprite sheet and font names (`Inter-Bold` for `Inter-Bold.font.json`); a member may be in several groups.
- Unmatched members go to `defaultGroup` (default `"base"`).
- `preload`: groups the runtime may fetch in the background after the first load.
- Skeletons are named by their `.tbin` header; a `.baked` pairs with the `.tbin` of the same base name. Sprite sheets are TexturePacker-style JSON + image; `ui@0.5x.json` next to `ui.json` is its 0.5× tier.
- **Raw Spine JSON** (`symbol1.json` + `symbol1.atlas` + pages) is listed too, as `format: "json"`, so one manifest can mix compiled and raw skeletons. A compiled skeleton wins over a raw one of the same name (warning). A `.tbin` that cannot be read falls back to its raw export (warning with the reason); without one it is an error. `symbol1@2x.json` (a tier export) is not a skeleton of its own.
- Every file gets a content hash (for `cacheBust`). Missing page files are an error; other problems print warnings.

In code: `buildAssetManifest(files, spec)` returns `{ manifest, warnings }`;
`validateAssetManifest(json)` checks a parsed manifest (format
`tabula-manifest`, versions 1 to `ASSET_MANIFEST_VERSION`).

**Versions.** A manifest with raw JSON skeletons is version 2; without them
it stays version 1, which older runtimes read. An older runtime given
version 2 fails with "version 2 is not supported; update tabula-pixi"
instead of misreading the files.

## Bundles, images

A manifest may list `.tbla` bundles (`bundles`: file, tier, group, paths;
version 3): every file listed in one is read from the bundle of the
manager's tier, streamed, with no other change. Standalone images
(`images`, `getTexture(name)`) and sprite sheets whose image is a page
(`sprites[name].page`: tiers and KTX2) are version 3 too. A bundle's data
files may be stored deflated (`.tbla` version 2), which needs
`DecompressionStream` (every current browser; Safari from 16.4). If a
server ignores range requests, a file needed after the download stopped
costs one more download of the whole bundle, which then serves every later
file. See
[app.md](../../../tabula-tools/docs/app.md#export-modes-and-tbla).

## Raw and compiled skeletons together

Raw skeletons need the JSON parser (about 14 KB), which the core leaves
out. Pass it as `json`:

```ts
import { spineJson } from 'tabula-pixi/json'; // tabula-pixi/pixi-v8/json for Pixi 8

const manager = await TabulaAssetManager.load('/assets/assets.manifest.json', { renderer: app.renderer, json: spineJson });
```

Without it, a manifest that lists raw skeletons fails when the manager is
created, naming them. A game that takes exports from the app should always
pass it: then an export can switch any skeleton between raw and compressed,
or fall back to raw when compression failed, with no code change. Raw
skeletons play live (no baked samples) and load their pages at 1×.

## Runtime: TabulaAssetManager

```ts
const manager = await TabulaAssetManager.load('/assets/assets.manifest.json', {
  renderer: app.renderer, transcoder: '/basis/', tier: 1, cacheBust: true, json: spineJson,
});
await manager.loadGroup('base');
manager.preloadInBackground();
const view = runtime.createView(manager.getAsset('symbol1')).play('symbolIdle', { loop: true });
```

### Options

| `TabulaAssetManagerOptions` | Default | Meaning |
|---|---|---|
| `renderer` | none | Decides the KTX2 transcode format (and the `'auto'` tier). |
| `transcoder` | none | Basis transcoder URL or factory. Without it, pages load as images. |
| `ktx2` | `true` | Load KTX2 pages when available (needs `renderer` + `transcoder`). |
| `tier` | `1` | Resolution tier. The game decides; see `availableTiers()`. A page or sprite sheet without that tier loads the largest one below it. `'auto'` picks by device ([textures-ktx2.md](textures-ktx2.md#tier-choice)). |
| `json` | none | Raw Spine JSON support (`spineJson` from the `/json` entry). Required when the manifest lists JSON skeletons. |
| `workers` | `true` | Worker transcoding (or a `Ktx2WorkerPool`). |
| `cacheBust` | `false` | Append `?v=<content hash>` to every URL (cache files forever). |
| `target` | auto | Force a transcode target. |
| `fetch` | `globalThis.fetch` | Custom fetch (tests, auth headers). |
| `language` | none | Language for font variants (`main@ka`), see [Languages](#languages). |
| `skins` | none | Skin combinations to name on skeletons as they load, by skeleton: `{ symbol23: { wild10: ['10', 'explode'] } }` ([combined skins](getting-started.md#8-skins)). Several per skeleton; a definition may use one listed before it (they run in order). Defined again on every reload. |

### Methods

| Member | What it does | Returns / errors |
|---|---|---|
| `TabulaAssetManager.load(url, options?)` | Fetch + validate the manifest, create the manager. URLs resolve against `url`. | Rejects on HTTP or format errors. |
| `new TabulaAssetManager(manifest, manifestUrl, options?)` | Same with a parsed manifest. | Throws on an invalid manifest. |
| `loadGroup(name, { onProgress? })` | Load every member (skeleton + pages + baked, sprite sheets, SDF fonts). Members already loaded by another group are shared. Repeated calls return the same promise. | Rejects for an unknown group or a failed file (and emits `error`); members loaded so far stay counted so `unloadGroup` frees them. |
| `preloadGroup(name)` | Fetch a group's bytes at low priority, without decoding or uploading. A later `loadGroup` only parses and uploads. | Promise. |
| `preloadInBackground(groups = manifest.preload)` | Preload when the main thread is idle. | void |
| `unloadGroup(name)` | Release a group: members and pages only it held are destroyed. Destroy its views first. No-op if not loaded. | void |
| `isGroupLoaded(name)`, `groupNames`, `groupsOf(member, kind?)` | Group state and membership. | |
| `getAsset(name)` | The `TabulaAsset` of a loaded skeleton. | Throws if no loaded group contains it (names the groups that do). |
| `getSprites(name)` | The Pixi `Spritesheet` of a loaded sprite sheet. | Throws if not loaded. |
| `getFont(name)` | The loaded SDF font (for [`SdfText`](text.md)). For a font with language variants, you get the current language's variant, with its `fallbacks` linked. KTX2 pages are used when the font has them and the manager has a `transcoder`. `unloadGroup` frees it when no loaded group holds it. | Throws if not loaded. |
| `setLanguage(lang)` | Loads the `lang` variants (and their fallbacks) of the fonts in loaded groups, switches live texts using the previous variants to the new ones (only those re-lay out), then releases the previous variants. A released font is unloaded once no text uses it. | Promise, resolved after the switch. Texts with `followLanguage = false` keep their font. |
| `language`, `fontLanguages`, `fontVariant(name, lang?)`, `loadedFonts()` | Current language, languages with variants, which manifest font a name resolves to, and loaded fonts with reference counts. | |
| `pageRefCount(page)`, `loadedPages()`, `gpuBytes` | Page reference counts, loaded page reports, GPU memory of loaded pages. | |
| `on(event, fn)` | `progress` (`GroupProgress`: bytes/files loaded and total, `progress` 0..1), `loaded` (`{ group, ms }`), `unloaded`, `error` (`{ group, error }`). | Returns an unsubscribe function. |
| `availableTiers(group?)` | The tiers the manifest offers, largest first, with `imageBytes`, `ktx2Bytes` and `vramBytes` (RGBA8) of the group's pages (default: all pages) at each. For the game to choose `tier` with. | Throws for an unknown group. |
| `manifest`, `tier`, `useKtx2` | The manifest, the tier in use, whether KTX2 is used. | |
| `destroy()` | Unload everything and drop preloaded bytes. | |

### Measured (Mac M4, Metal, warm cache)

| Step | Time |
|---|---|
| manifest fetch | 2.4 ms |
| `loadGroup('base')` (demo load-groups.json, KTX2) | 92–94 ms |
| `loadGroup('bigwin')` cold | 52–54 ms |
| `loadGroup('bigwin')` after `preloadGroup` (12.6 ms in background) | 51 ms |
| pages after `unloadGroup('bigwin')` | 6 → 2 |

At 4× CPU throttling: base 151 ms, bigwin 104 ms cold / 62 ms after preload.

## Languages

`tabula font ... --per-lang` writes one font per language, named
`<name>@<lang>`, together with its fallback fonts (`NotoSansGeorgian-Bold@ka`).
`tabula manifest` records each variant's `language` and `base`. A load
group lists the base name once (`fonts: ["main"]`). Fonts that only serve
as fallbacks are not group members: they load with the font that lists
them.

```ts
const manager = await TabulaAssetManager.load('/assets.manifest.json', { renderer: app.renderer, language: 'hr' });
await manager.loadGroup('base');                  // loads main@hr only
const title = runtime.createText('VELIKI DOBITAK', { font: manager.getFont('main'), fontSize: 96 });

await manager.setLanguage('ka');                  // loads main@ka + NotoSansGeorgian-Bold@ka, switches title, frees main@hr
title.text = 'დიდი მოგება';
```

A font name resolves in this order:

1. the exact `<name>@<lang>`;
2. the language without its region (`ka-GE` uses `ka`);
3. the plain font `<name>`;
4. the first variant by name.

Atlases of the test build (Inter Bold plus Noto Sans Georgian / Armenian
Bold, 48 px per em; `scripts/text-visual.mjs`):

| Language | Fonts | Pages | PNG | GPU (RGBA8) |
|---|---|---|---|---|
| hr | main@hr | 552×548 | 289 KB | 1.15 MiB |
| el | main@el | 648×688 | 420 KB | 1.70 MiB |
| ru | main@ru | 648×672 | 399 KB | 1.66 MiB |
| ka | main@ka + NotoSansGeorgian-Bold@ka | 516×520 + 428×452 | 477 KB | 1.76 MiB |
| hy | main@hy + NotoSansArmenian-Bold@hy | 520×520 + 492×452 | 461 KB | 1.88 MiB |

One font with all five languages (`--lang hr,el,ru,ka,hy` without
`--per-lang`) would keep about 400 glyphs resident. Per-language variants
keep only 120 to 190.
