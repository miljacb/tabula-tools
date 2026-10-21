# CLI reference

```sh
npx tabula <command> [paths...] [options]
npx tabula --help
```

Input is Spine **4.1 or 4.2 JSON** exports (newer 4.x best-effort, with warnings) with their `.atlas` (same base
name, same folder, or one shared atlas via `compile --atlas`) and page
images. Directories are searched recursively for `.json` files; JSON that is
not a Spine skeleton (fonts, manifests, sprite sheets) is skipped. Errors print one
line and exit with code 1.

| Command | Purpose |
|---|---|
| [`check`](#check) | Validate exports (CI gate). |
| [`audit`](#audit) | Feature usage + validation report. |
| [`compile`](#compile) | JSON → `.tbin` (+ `.baked`). |
| [`bake`](#bake) | Bake one skeleton's animations, with an error report. |
| [`repack`](#repack) | Rebuild atlas pages per co-draw group; tiers, KTX2, `.tbin`, `.baked`. |
| [`manifest`](#manifest) | Write `assets.manifest.json` with load groups. |
| [`font`](#font) | TTF/OTF → SDF font for `SdfText`. |
| [`ktx-tool`](#ktx-tool) | Show / install the KTX2 encoder. |
| [`app`](#app) | Open the Tabula app on a project folder. |
| `inspect <f.tbla>` | A `.tbla` bundle's files, sizes and assets (checksums checked); `--unpack <dir>` writes them, `-f json` for scripts. |

## check

```sh
tabula check <path...>
```

Parses and validates every export against what the runtime renders. Prints
`✓ name` / `✗ name` with `error:` and `warning:` lines; exit code 1 if any
skeleton has errors.

- Errors: unsupported attachment types or timelines, missing atlas regions, IK setups spine-core would throw on, a Spine version other than 4.1/4.2.
- Warnings: multiply/screen slots (each costs a batch break), two-bone IK on bones without normal inheritance (no-op), path attachments no constraint uses.

```sh
tabula check assets/            # in CI before building
```

## audit

```sh
tabula audit <path...> [-o report.md|report.json] [-f markdown|json]
```

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <file>` | stdout | Write the report to a file (`.json` implies JSON). |
| `-f, --format <fmt>` | `markdown` | `markdown` or `json`. |

Lists per skeleton which features are used (bones, constraints, attachment
types, timelines, blend modes, clipping, sequences…) plus validation results.
`pnpm run audit` runs it on `test-assets/`; the committed result is
feature-audit.md.

```sh
tabula audit assets/ -o audit.md
tabula audit assets/ -f json > audit.json
```

## compile

```sh
tabula compile <path...> [-o dir] [--atlas file | --no-atlas] [--bake [--max-error n] [--tolerance n]]
```

Validates (errors abort) and writes `<name>.tbin` per export, embedding the
atlas pages and only the regions the skeleton uses.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <dir>` | next to each JSON | Output directory. |
| `--atlas <file>` | `<name>.atlas` next to each JSON | Atlas to embed. |
| `--no-atlas` | off | Do not embed an atlas (load it yourself and use `createTabulaAsset`). |
| `--bake` | off | Also write `<name>.baked` (all animations, auto sample rate). |
| `--max-error <n>` | 0.05 | With `--bake`: vertex error budget, skeleton units (0 = lossless). |
| `--tolerance <n>` | 0.25 | With `--bake`: max deviation from live between samples (0 = fixed rate). |

```sh
tabula compile assets/ -o public/assets --bake
# one shared atlas + texture for many JSONs:
tabula compile assets/symbols --atlas assets/symbols/symbols.atlas -o public/assets
```

With one atlas shared by many JSONs, pass it with `--atlas`; the shared page
then loads once at runtime for all of them (see
pixi-v7.md: Atlas setups). With one atlas per
skeleton, `<name>.atlas` next to each JSON is used automatically.

## bake

```sh
tabula bake <file.json> [-o out.baked] [--fps n] [--max-error n] [--tolerance n] [-a anim,anim] [--skin name] [--no-report]
```

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <file>` | `<name>.baked` next to the JSON | Output file. |
| `--fps <n>` | smallest multiple of the key rate ≥ 30 (else 30) | Base sample rate. |
| `--max-error <n>` | 0.05 | Compression budget, skeleton units (0 = lossless). |
| `--tolerance <n>` | 0.25 | Extra samples where interpolation deviates more than this from live. |
| `-a, --animations <list>` | all | Comma-separated animation names. |
| `--skin <name>` | default skin | Skin to bake with. |
| `--no-report` | report on | Skip the per-animation error report. |

Skeletons with physics constraints write no animations (they always play
live). See baking.md.

```sh
tabula bake assets/symbol1.json -o public/assets/symbol1.baked --fps 60 -a symbolWin,symbolWinLoop
```

## repack

```sh
tabula repack <path...> -o <dir> [--groups file] [layout flags] [--image-format f] [--compile [--bake]] [--ktx2 codec] [--tiers list]
```

Rebuilds atlas pages per **co-draw group** (skeletons drawn together share
pages; a region used by several groups is copied into each). Writes
`<group>.atlas`, pages, `<group>.textures.json`, optional `.tbin`/`.baked`, and
`repack-report.json` (pages, fill, VRAM and file size before/after). Needs the
optional dependency `sharp`.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <dir>` | required | Output directory. |
| `--groups <file>` | one group | Co-draw groups JSON (below). |
| `--max-size <n>` | 2048 | Largest page side (e.g. 4096). |
| `--padding <n>` | 2 | Pixels between regions. |
| `--extrude <n>` | 0 | Edge pixels repeated around regions. |
| `--pma` | as the source | Premultiply alpha in the pages. |
| `--no-rotate` | rotate | Do not rotate regions 90°. |
| `--no-pot` | power of two | Allow non-power-of-two page sizes. |
| `--image-format <f>` | `png` | `png`, `webp` or `webp-lossless`. |
| `--quality <n>` | 90 | Lossy WebP quality. |
| `--compile` | off | Also write `<skeleton>.tbin` embedding its group atlas. |
| `--bake` | off | With `--compile`: also write `<skeleton>.baked` (`--max-error`, `--tolerance` apply). |
| `--ktx2 <codec>` | none | Also write KTX2 pages: `uastc` (quality), `etc1s` (size), `none`. |
| `--ktx2-quality <n>` | UASTC 2 / ETC1S 128 | UASTC level 0–4, ETC1S quality 1–255. |
| `--tiers <list>` | `1` | Resolution tiers, e.g. `2,1,0.75,0.5`: writes `<page>@0.5x.png` (and `.ktx2`). Tiers above 1 need `<name>@2x.atlas` exports next to each JSON (never upscaled). |

Groups file (CLI flags are defaults; the file overrides per group/page):

```json
{
  "maxSize": 2048,
  "ktx2": "uastc",
  "tiers": [1, 0.75, 0.5],
  "groups": [
    { "name": "game", "skeletons": ["symbol*", "reel*"], "pages": { "game_2": "etc1s" } },
    { "name": "background", "skeletons": ["background*"], "ktx2": "etc1s" },
    { "name": "ui", "skeletons": ["*Button"], "ktx2": "none" }
  ]
}
```

Unmatched skeletons go to group `misc`. KTX2 encoding uses `ktx`, see [ktx-tool](#ktx-tool).

```sh
tabula repack assets/ -o public/assets --groups atlas-groups.json --compile --bake --ktx2 uastc --tiers 1,0.75,0.5
tabula repack assets/ -o out --max-size 4096 --image-format webp --quality 85
```

## manifest

```sh
tabula manifest <dir...> [-o assets.manifest.json] [--load-groups file]
```

Scans build outputs (`.tbin`, `.baked`, page images and tier/KTX2 files,
`*.textures.json`, sprite sheet JSON + image, `*.font.json` SDF fonts with
their pages) and writes the asset manifest
with content hashes and load groups.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <file>` | `<first dir>/assets.manifest.json` | Manifest path; file paths in it are relative to it. |
| `--load-groups <file>` | everything in `base` | `{"groups": {"base": ["symbol*"], "bonus": ["bonus*"]}, "defaultGroup": "base", "preload": ["bonus"]}` |

Prints per group the member count, pages and bytes. See manifest.md.

```sh
tabula manifest public/assets --load-groups load-groups.json
```

## font

```sh
tabula font <font.ttf|otf...> -o <dir> [--size 48] [--range 16] [--charset latin-ext] [--lang hr,el,ka]
                [--charset-from i18n/*.json] [--chars "★"] [--name n] [--ktx2 uastc]
tabula font --google "Noto Sans" [--weights 400,700] -o <dir> [...]
tabula font Inter.ttf NotoSansGeorgian.ttf --chain --lang hr,el,ka --per-lang --name main -o <dir>
```

Compiles TrueType / OpenType fonts to SDF fonts for `SdfText`:
`<name>.font.json` (metrics, glyphs, kerning classes, fallbacks) plus page
images (`<name>.png`, `<name>_1.png`, ...). msdfgen (WebAssembly, nothing
to install) generates the glyphs: RGB holds a multi-channel SDF for sharp
corners, and alpha holds a true SDF for outline, glow and shadow. Kerning
comes from the GPOS `kern` feature (all lookups, class and pair formats,
extension lookups) or from the legacy `kern` table.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --output <dir>` | required | Output directory. |
| `--size <n>` | 48 | Atlas pixels per em. Higher means sharper corners at large sizes and bigger pages. |
| `--range <n>` | 16 | Distance range in atlas pixels. Outline plus glow reach at most `range / 2` atlas pixels (1/6 em at the defaults). |
| `--charset <list>` | `latin-ext` (if no `--lang`, `--charset-from` or `--chars` is given) | Comma-separated. Latin: `digits`, `ascii`, `latin` (Latin-1 plus typographic punctuation), `latin-ext` (adds Latin Extended-A, which covers Croatian čćđšž and most European languages), `latin-ext-all` (adds Latin Extended-B and Extended Additional). Scripts: `greek`, `cyrillic`, `georgian` (with Mtavruli capitals), `armenian`, `vietnamese`, `turkish`. Other: `currency`, `punctuation`. |
| `--lang <list>` | | Languages, e.g. `hr,el,ru,ka,hy,tr,vi`. Each adds its CLDR exemplar letters in both cases, plus ASCII (codes, brand names, EUR), typographic punctuation, `$ ¢ £ ¥ €` and its own currency (₺ ₾ ֏ ₽ ₴ ₫ …). Known: en hr bs sr-latn sl cs sk pl hu ro de fr es it pt nl sv da no nb fi et lv lt sq is ga mt tr az vi el ru uk be bg sr mk kk ka hy. A region subtag falls back to its language (`pt-BR` uses `pt`). |
| `--charset-from <files>` | | i18n files, comma-separated or repeated. For `.json` files the compiler takes every string value (not keys); for other files, all of the text. The text is NFC-normalized. You get exactly the characters used; add the characters of runtime values (names, amounts) with `--lang` or `--chars`. With `--per-lang`, a file named after a language (`ka.json`) feeds only that language. |
| `--chars <text>` | | Extra characters. |
| `--google <families>` | | Download Google Fonts families (comma-separated or repeated) at build time. See below. |
| `--weights <list>` | `400` | Weights for `--google`. Several weights write one font each (`Name-Regular`, `Name-Bold`). |
| `--chain` | off | The fonts form a **fallback chain**. Each character goes to the first font that has it, so later fonts only get what earlier ones lack. The first font lists the others in its `fallbacks`. With `--google`, font files given as arguments head the chain of every weight. |
| `--per-lang` | off | One variant per `--lang` code, named `<name>@<lang>` (and `<fallback>@<lang>`). Variants hold only that language's characters. The manifest groups them so that `manager.setLanguage` can switch between them. |
| `--fallback <names>` | | Fallback font names to record in the `.font.json` by hand. |
| `--lock <file>` | `./tabula-fonts.lock.json` | Lockfile for `--google`. |
| `--update-lock` | off | Resolve `--google` downloads again and re-pin them. |
| `--name <name>` | font file name | Output base name (what `manager.getFont(name)` uses). With `--chain`, the name of the head font. |
| `--ktx2 uastc` | off | Also write UASTC KTX2 pages (linear, no RDO). `loadSdfFont` uses them when it has a transcoder. |

The command prints, per font: glyph count, kerning pairs, page sizes with
PNG bytes, fallbacks, and the characters the font (or the whole chain) does
not contain.

### Google Fonts

`--google "Noto Sans Georgian" --weights 400,700` asks the Google Fonts CSS
API for the static TTF of each weight. That API serves whole-font TrueType
files to non-browser clients, so no variable-font instancing is needed. The
license (`OFL.txt`, `LICENSE.txt` or `UFL.txt`) comes from the
[google/fonts](https://github.com/google/fonts) repository and is copied
next to the output as `<Family>-OFL.txt`.

Each file's URL and SHA-256 are pinned in `tabula-fonts.lock.json`.
Commit that file. Later builds use the pinned URLs, check the hashes, and
take the files from `node_modules/.cache/tabula/fonts` (or
`$TABULA_CACHE_DIR/fonts`), so they work offline. If a pinned file
changes on the server, the build fails until you pass `--update-lock`.

All of this happens at build time. The runtime never loads web fonts: it
only loads the compiled `.font.json` and its pages. For font files you
supply yourself, an `OFL.txt` / `LICENSE.txt` / `<Family>-OFL.txt` next to
the font is copied to the output too.

### Examples

```sh
# Latin + Croatian (default charset)
tabula font assets/fonts/Inter-Regular.ttf assets/fonts/Inter-Bold.ttf -o public/fonts
tabula font Brand.otf --chars "ΑΒΓΩαβγω★" --size 64 --range 24 -o public/fonts --ktx2 uastc

# Exactly the characters of the game's strings, Greek and Cyrillic from Inter
tabula font Inter-Bold.ttf --charset-from locales/el.json,locales/ru.json --lang el,ru -o public/fonts

# Inter, then Noto Sans Georgian, then Noto Sans Armenian; one variant per language
tabula font assets/fonts/Inter-Bold.ttf --google "Noto Sans Georgian,Noto Sans Armenian" --weights 700 \
  --chain --lang hr,el,ru,ka,hy --per-lang --name main -o public/fonts
#  ✓ main@hr: 131 glyphs, pages 552x548 (289 KB)
#  ✓ main@ka: 122 glyphs, pages 516x520 (261 KB), fallbacks NotoSansGeorgian-Bold@ka
#  ✓ NotoSansGeorgian-Bold@ka: 66 glyphs, pages 428x452 (216 KB)
#  ...
tabula manifest public -o public/assets.manifest.json   # group font "main" with variants hr, el, ru, ka, hy
```

Right-to-left scripts and complex shaping (Arabic, Hebrew, Indic scripts,
Thai, Khmer, …) are **not supported**: the compiler would bake the glyphs,
but the layout does not shape or reorder them. Use Pixi `Text` for those
languages.

## ktx-tool

```sh
tabula ktx-tool [--install [--force]]
```

Shows which `ktx` encoder `repack --ktx2` uses (`$TABULA_KTX`, project
cache, or `PATH`) and its version; exit code 1 if none is found.

| Flag | Meaning |
|---|---|
| `--install` | Download the pinned KTX-Software 4.4.2 for this platform (macOS arm64/x64, Linux x64/arm64), verify its SHA-256 and unpack it into `node_modules/.cache/tabula/ktx-software/4.4.2/<platform-arch>`. No admin rights; nothing outside the project. |
| `--force` | With `--install`: reinstall even if present. |

| Environment variable | Meaning |
|---|---|
| `TABULA_KTX` | Path of a `ktx` binary to use instead. |
| `TABULA_CACHE_DIR` | Cache root instead of `node_modules/.cache/tabula`. |
| `TABULA_KTX_DOWNLOAD=0` | Never download automatically (`repack --ktx2` then fails with instructions if no `ktx` is found). |

```sh
tabula ktx-tool --install
# ktx: …/node_modules/.cache/tabula/ktx-software/4.4.2/darwin-arm64/bin/ktx (project cache)
# version: ktx version: v4.4.2
```

## app

```sh
tabula app [folder] [-o <export dir>] [--port n] [--no-open]
```

Opens the [Tabula app](app.md) on `folder` (default `.`): a local page
(127.0.0.1 only) that lists the assets, saves `tabula.config.json` and runs
the export (no preview: use the Tabula Viewer). The export folder
defaults to `<folder>/tabula-export`.

## Global

| Flag | Meaning |
|---|---|
| `-h, --help` | Show the usage summary. |
