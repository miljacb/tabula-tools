# Textures and KTX2

Atlas pages can ship at several **resolution tiers** (2×, 1×, 0.75×, 0.5×) and as
**KTX2 / Basis Universal** files that the runtime transcodes to the GPU's
compressed format (ASTC, BC7, ETC2, BC3, PVRTC1, or RGBA8). Transcoding runs in
**Web Workers** by default, so loading does not block the main thread.
Example: [`docs/examples/textures-ktx2.ts`](../examples/textures-ktx2.ts).
Build results (sizes, VRAM): [textures.md](../textures.md).

## Build

Building tiers and KTX2 pages needs **tabula-tools** (image encoding and the
native `ktx` encoder); the runtime only loads and transcodes them.

```sh
npx tabula repack assets/ -o public/assets --groups atlas-groups.json --compile \
  --ktx2 uastc --tiers 1,0.75,0.5
```

Per group this writes `game.atlas`, `game.png`, `game@0.75x.png`,
`game@0.5x.png`, `game.ktx2`, `game@0.75x.ktx2`, `game@0.5x.ktx2` (per page)
and `game.textures.json` (tiers, codec and file sizes per page). One atlas
and one `.tbin` serve every tier (UVs are normalised). The
[Tabula app](../../../tabula-tools/docs/app.md) writes the same files from its export settings.

### Tiers above 1

A tier above 1 (e.g. 2× for desktop when the art was made for phones) is
**never upscaled**. It needs the designer's higher-resolution export next
to each skeleton: `symbol1@2x.atlas` and its pages (a `symbol1@2x.json`
there is ignored). The 2× page keeps the 1× layout; each region is cut
from the 2× export by name, so its trim may differ. Without the export,
`repack` fails and the app exports that skeleton as raw JSON, naming the
missing file.

| Codec | Flag | Use for | Size / quality |
|---|---|---|---|
| UASTC | `--ktx2 uastc` (`--ktx2-quality 0-4`, default 2) | symbols, UI, sharp art | ~2.4 MiB per 2048² page pair; render PSNR 45–57 dB |
| ETC1S | `--ktx2 etc1s` (`--ktx2-quality 1-255`, default 128) | backgrounds, soft art | ~4× smaller than UASTC; PSNR 25–43 dB (visible on sharp edges) |
| none | `--ktx2 none` | PNG/WebP only | |

Per group/page codecs go in the groups file (`"ktx2"` on a group, `"pages":
{"game_2": "etc1s"}`), see [cli.md](../../../tabula-tools/docs/cli.md#repack). Pages are premultiplied
before encoding and flagged `KHR_DF_FLAG_ALPHA_PREMULTIPLIED`.

### The KTX encoder (`ktx`)

`repack --ktx2` needs KTX-Software's `ktx` at build time only. It is resolved in this order:

1. `$TABULA_KTX` (path to a `ktx` binary).
2. The project-local copy in `node_modules/.cache/tabula/ktx-software/4.4.2/<platform-arch>/`
   (override the cache root with `TABULA_CACHE_DIR`). If missing, it is downloaded on first use:
   the pinned KTX-Software 4.4.2 release for macOS arm64/x64 or Linux x64/arm64, verified by
   SHA-256, unpacked without installing (`pkgutil --expand-full` on macOS, tar on Linux).
   No sudo, nothing outside the project. `TABULA_KTX_DOWNLOAD=0` forbids the download.
3. `ktx` on `PATH`.

```sh
npx tabula ktx-tool            # which ktx is used, and its version
npx tabula ktx-tool --install  # download + verify now (e.g. in CI setup)
npx tabula ktx-tool --install --force
```

Output is identical between machines within ~0.1 dB PSNR (measured box Linux vs Mac M4).

## Runtime

### With `loadTabulaAsset`

```ts
const asset = await loadTabulaAsset('/assets/symbol1.tbin', {
  textures: {
    manifest: '/assets/game.textures.json', // or the parsed object
    tier: 0.5,               // the game decides (default 1); 'auto' picks by device
    renderer: app.renderer,  // decides the GPU format (and the 'auto' tier)
    transcoder: '/basis/',   // URL of basis_transcoder.js/.wasm, or a factory
    workers: true,           // default; a Ktx2WorkerPool, or false for main thread
    onLoaded: (report) => console.log(report),
  },
});
```

`PageTextureOptions`:

| Option | Default | Meaning |
|---|---|---|
| `manifest` | none (load pages as named in the atlas) | `<group>.textures.json`, parsed or URL. |
| `tier` | `1` | Resolution tier. A tier the manifest lacks resolves to the largest one below it (else the smallest). `'auto'`: by device, see [Tier choice](#tier-choice). |
| `ktx2` | `true` if `renderer` and `transcoder` are set | Load the KTX2 files the manifest lists. Without renderer/transcoder, images load (with a console warning if KTX2 exists). |
| `renderer`, `transcoder` | none | Needed for KTX2. |
| `workers` | `true` | Transcode in the shared worker pool for the transcoder URL. |
| `target` | auto | Force a transcode target (testing/comparison). |
| `upload` | `true` (with a WebGL `renderer`) | Upload each page to the GPU as soon as it loads, in its own task. With `false`, the first render uploads every page at once, inside one long task. |
| `onLoaded(report)` | none | `{ tier, pages: [{ name, file, format, width, height, gpuBytes, ms, ktx2? }], gpuBytes, ms }`. |

With the manifest manager, the same options go to `TabulaAssetManager` ([manifest.md](manifest.md)).

### Keeping load off the main thread

Loading is split so no single main-thread task gets long:

- KTX2 pages transcode in workers.
- Baked samples decode in their own task while the pages are still
  downloading or transcoding.
- Each page uploads in its own task as soon as it arrives (`upload`).
- `createTabulaRuntime` compiles the Tabula shader at start-up.

At CPU 4× on an M4, the longest load task of the game scene went from 56 ms
to 20 ms, and total blocking time went to 0
(`bench-results/reference/2026-10-08-mac-m4-load/`). Your own setup code
matters too: creating many views and sampling their bounds in one go is one
task. `await yieldToMain()` (from `tabula-pixi`) between
views splits it:

```ts
import { yieldToMain } from 'tabula-pixi';

for (const asset of assets) {
  stage.addChild(runtime.createView(asset).play('idle', { loop: true }));
  await yieldToMain(); // one task per view
}
```

`node scripts/load-profile.mjs --cpu-throttle 4` prints the main-thread
tasks of a bench case's load, with a trace-event breakdown and the JS
functions that take the most time.

### Tier choice

The game decides the tier; the runtime never lowers it on its own (default
1). `TabulaAssetManager.availableTiers(group?)` lists the tiers with the
download and GPU memory of each, and `resolveTier(requested, tiers)` shows
which one loads. For a device-based default, pass `tier: 'auto'` or call
`chooseTextureTier(deviceTextureHints(renderer), tiers)` yourself: **0.5** for software
GL, ≤ 2 GiB device memory, `MAX_TEXTURE_SIZE` < 4096 or a canvas under 0.6 Mpx;
**0.75** for ≤ 4 GiB, ≤ 4 cores or a canvas under 1.5 Mpx; else **1**. The
largest available tier at or below that is used.

### Format choice

`chooseTranscodeTarget(codec, compressedTextureSupport(renderer), w, h)`:

- UASTC → ASTC 4×4 > BC7 > ETC2 > BC3 > PVRTC1 > RGBA8
- ETC1S → ETC2 > BC7 > ASTC > BC3 > PVRTC1 > RGBA8

PVRTC1 only for square power-of-two pages. Apple GPUs (Metal) and SwiftShader pick ASTC.

### Worker transcoding

| Export | What it does |
|---|---|
| `sharedKtx2WorkerPool(transcoderUrl)` | The pool used by default (one per transcoder URL). |
| `new Ktx2WorkerPool({ transcoderUrl, size?, shareWasm?, createWorker? })` | Own pool. `size` default `defaultWorkerCount()` = cores − 1, 1..4. `shareWasm` (default true) fetches the `.wasm` once and copies it to workers. |
| `pool.warm(count?)` | Start workers now so the transcoder is compiled before pages arrive. |
| `pool.transcode(bytes, request)` | Transcode in a worker (the buffer is transferred). Rejects with `Ktx2WorkerUnavailableError` if no worker can run it (bytes intact), or an `Error` for a bad file. |
| `pool.size`, `workerCount`, `pending`, `unavailable` | Limits and state; `unavailable` explains why workers cannot run. |
| `pool.dispose()` / `disposeSharedKtx2WorkerPools()` | Terminate workers; queued jobs reject. |
| `workersSupported()` | Blob-URL workers available here. |

Fallback contract: if workers cannot start (CSP without `blob:` in
`worker-src`, no Worker), the page is transcoded on the main thread, so
loading always works. A factory `transcoder` always runs on the main thread.

Measured (Mac M4, game scene, 2 UASTC 2048² pages): longest main-thread task
86–92 ms → 14–18 ms, total blocking time 36–42 ms → 0, same load time. At 4×
CPU throttling: longest task 324–330 ms → 103–110 ms, load 403–409 ms →
198–199 ms. See [STATUS.md](../STATUS.md).

### Lower level

| Export | What it does |
|---|---|
| `loadKtx2Texture(url, { renderer, transcoder, scaleMode?, target?, workers?, fetchBytes? })` | Fetch + transcode + upload one page as a premultiplied `BaseTexture` (Pixi v7) or `TextureSource` (`CompressedSource` / RGBA8 `BufferImageSource`, Pixi v8); cached per URL. Returns `{ texture, stats }`. |
| `unloadKtx2Texture(url, target?)` | Forget a cached page (after destroying its texture). |
| `loadBasisTranscoder(source)` | Load and initialise the transcoder once. |
| `compressedTextureSupport(renderer)` | `{ astc, bc7, etc2, bc3, pvrtc }`: WebGL extensions; on Pixi v8 WebGPU, the device features (`texture-compression-astc` / `-bc` / `-etc2`). `pvrtc` is always false on Pixi v8 (no PVRTC format there). |
| `compressedTextureSupportFor(renderer, width, height)` (Pixi v8) | The same for one page: on WebGPU, pages whose size is not a multiple of 4 get no compressed format (RGBA8). |
| core: `parseKtx2Header`, `transcodeBasisFile`, `transcodedBytes`, `tierSize`, `tierFileName`, `manifestPageFile`, `TRANSCODE_TARGETS` | Header parsing, transcoding, sizes and file naming used by the loaders. |

Both bridges share the fetch / transcode / worker / fallback code
(`src/shared/ktx2.ts`); only the texture wrapping differs. Pixi 8's own
`loadKTX2` is not used, so tiers, format choice and the image fallback
behave the same on both.

Serve `.ktx2` as `application/octet-stream` (any type works; it is fetched as bytes) and the `.wasm` as `application/wasm`.
