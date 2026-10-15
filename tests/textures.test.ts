/**
 * Page encoding for compressed textures: the KTX2 premultiplied flag, tier
 * resampling, repack page output (tiers, PMA, per-page codecs), the
 * project-local ktx tool and the encoder (round-tripped through the Basis
 * transcoder of tabula-pixi).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { TRANSCODE_TARGETS, parseKtx2Header } from 'tabula-pixi/core/texture-formats.js';
import { createImage, premultiply, resizeArea } from '../src/export/pack/image.js';
import type { RgbaImage } from '../src/export/pack/image.js';
import { encodeGroupPages, ktx2Selector } from '../src/export/pages.js';
import type { RepackedGroup } from '../src/export/pack/repack.js';
import { encodeKtx2, markPremultiplied } from '../src/export/pack/ktx2.js';
import { installKtxTool, ktxCacheDir, ktxVersionSync, resolveKtxTool, KTX_SOFTWARE_ASSETS, KTX_SOFTWARE_VERSION } from '../src/export/pack/ktx-tool.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('KTX2 premultiplied flag', () => {
  it('rejects other files and sets the flag in place', () => {
    expect(() => parseKtx2Header(new Uint8Array(100))).toThrow(/Not a KTX2/);
    const bytes = fixture('gradient16x8-uastc.ktx2').slice();
    const info = parseKtx2Header(bytes);
    bytes[info.dfdFlagsOffset] = 0;
    expect(parseKtx2Header(bytes).premultiplied).toBe(false);
    expect(parseKtx2Header(markPremultiplied(bytes)).premultiplied).toBe(true);
  });
});

describe('tier resampling', () => {
  it('area-resamples without reaching across the atlas padding', () => {
    // Two 6×6 opaque regions 2 px apart (padding), red and green.
    const img = createImage(16, 8);
    const fill = (x0: number, rgb: [number, number, number]): void => {
      for (let y = 0; y < 6; y++) for (let x = x0; x < x0 + 6; x++) img.data.set([...rgb, 255], (y * 16 + x) * 4);
    };
    fill(0, [255, 0, 0]);
    fill(8, [0, 255, 0]);
    const half = resizeArea(img, 8, 4);
    for (let x = 0; x < 8; x++) {
      const [r, g] = [half.data[x * 4]!, half.data[x * 4 + 1]!];
      expect(r === 0 || g === 0).toBe(true); // no red/green mix anywhere
    }
    expect([...half.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    // 0.75×: weights sum to 1 (flat stays flat)
    const flat = createImage(8, 8);
    flat.data.fill(200);
    expect(new Set(resizeArea(flat, 6, 6).data)).toEqual(new Set([200]));
  });
});

/** A group with one straight-alpha 8×8 page. */
function group(pma: boolean): RepackedGroup {
  const image = createImage(8, 8);
  for (let i = 0; i < 64; i++) image.data.set([200, 100, 50, i < 32 ? 128 : 255], i * 4);
  const page = { name: 'g.png', width: 8, height: 8, format: 'RGBA8888', minFilter: 'Linear', magFilter: 'Linear', uWrap: 'ClampToEdge', vWrap: 'ClampToEdge', pma };
  if (pma) premultiply(image);
  return { name: 'g', skeletons: [], atlas: { pages: [page], regions: new Map() }, images: [image], sourcePages: [], regionPixels: 0, sharedRegions: [] } as unknown as RepackedGroup;
}

describe('repack page encoding', () => {
  it('writes every tier as image and KTX2, encoding KTX2 from premultiplied pixels', async () => {
    const emitted = new Map<string, Uint8Array>();
    const ktxInputs: RgbaImage[] = [];
    const manifest = await encodeGroupPages(group(false), {
      imageFormat: 'png', tiers: [0.5, 1], ktx2For: () => 'etc1s',
      encodeKtx2: async (image) => { ktxInputs.push(image); return new Uint8Array([1, 2, 3]); },
    }, (name, bytes) => { emitted.set(name, bytes); });
    expect([...emitted.keys()].sort()).toEqual(['g.ktx2', 'g.png', 'g@0.5x.ktx2', 'g@0.5x.png']);
    expect(manifest.tiers).toEqual([1, 0.5]);
    expect(manifest.pages['g.png']).toMatchObject({ ktx2: 'etc1s', width: 8, height: 8 });
    expect(manifest.pages['g.png']!.files['g@0.5x.ktx2']).toBe(3);
    expect(ktxInputs.map((i) => i.width)).toEqual([8, 4]);
    // straight (200, 100, 50, 128) → premultiplied (100, 50, 25, 128)
    expect([...ktxInputs[0]!.data.subarray(0, 4)]).toEqual([100, 50, 25, 128]);
  });

  it('drops KTX2 for a page whose encoder returns null, and selects codecs per group and page', async () => {
    const manifest = await encodeGroupPages(group(true), {
      imageFormat: 'png', tiers: [1, 0.5], ktx2For: () => 'uastc', encodeKtx2: async () => null,
    }, () => undefined);
    expect(manifest.pages['g.png']!.ktx2).toBeNull();
    expect(Object.keys(manifest.pages['g.png']!.files).sort()).toEqual(['g.png', 'g@0.5x.png']);
    const select = ktx2Selector({ ktx2: 'uastc', groups: [{ name: 'reel', skeletons: [], ktx2: 'etc1s', pages: { reel_2: 'none', 'reel_3.png': 'uastc' } }] }, 'reel');
    expect([select('reel.png'), select('reel_2.png'), select('reel_3.png')]).toEqual(['etc1s', null, 'uastc']);
    expect(ktx2Selector({ ktx2: 'uastc' }, 'misc')('misc.png')).toBe('uastc');
    expect(ktx2Selector({ ktx2: 'uastc' }, 'misc', 'none')('misc.png')).toBeNull();
    expect(ktx2Selector({}, 'misc')('misc.png')).toBeNull();
  });
});

interface BasisFile {
  isValid(): boolean | number; startTranscoding(): boolean | number; getImageTranscodedSizeInBytes(l: number, a: number, f: number, fmt: number): number;
  transcodeImage(dst: Uint8Array, l: number, a: number, f: number, fmt: number, g: number, c0: number, c1: number): number; close(): void; delete(): void;
}

async function basis(): Promise<{ KTX2File: new (b: Uint8Array) => BasisFile }> {
  const require = createRequire(import.meta.url);
  const factory = require('tabula-pixi/basis/basis_transcoder.js') as (o: object) => Promise<{ initializeBasis(): void; KTX2File: new (b: Uint8Array) => BasisFile }>;
  const module = await factory({ wasmBinary: readFileSync(require.resolve('tabula-pixi/basis/basis_transcoder.wasm')) });
  module.initializeBasis();
  return module;
}

function transcode(module: Awaited<ReturnType<typeof basis>>, bytes: Uint8Array, target: keyof typeof TRANSCODE_TARGETS): Uint8Array {
  const file = new module.KTX2File(bytes);
  try {
    expect(file.isValid()).toBeTruthy();
    expect(file.startTranscoding()).toBeTruthy();
    const format = TRANSCODE_TARGETS[target].basisFormat;
    const out = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
    expect(file.transcodeImage(out, 0, 0, 0, format, 0, -1, -1)).toBeTruthy();
    return out;
  } finally {
    file.close();
    file.delete();
  }
}

const hasKtx = ktxVersionSync(resolveKtxTool().path) !== null;

describe('project-local ktx tool', () => {
  it('pins a checksum per platform and rejects a download that does not match', async () => {
    for (const asset of Object.values(KTX_SOFTWARE_ASSETS)) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(KTX_SOFTWARE_ASSETS)).toEqual(expect.arrayContaining(['darwin-arm64', 'darwin-x64', 'linux-x64']));
    const dir = mkdtempSync(join(tmpdir(), 'tabula-ktx-test-'));
    const saved = process.env.TABULA_CACHE_DIR;
    process.env.TABULA_CACHE_DIR = dir;
    try {
      const install = installKtxTool({ force: true, download: async () => new Uint8Array([1, 2, 3]) });
      if (KTX_SOFTWARE_ASSETS[`${process.platform}-${process.arch}`]) await expect(install).rejects.toThrow(/Checksum mismatch/);
      else await expect(install).rejects.toThrow(/No pinned KTX-Software build/);
      expect(ktxCacheDir()).toContain(join(dir, 'ktx-software', KTX_SOFTWARE_VERSION));
    } finally {
      if (saved === undefined) delete process.env.TABULA_CACHE_DIR;
      else process.env.TABULA_CACHE_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves $TABULA_KTX first', () => {
    const saved = process.env.TABULA_KTX;
    process.env.TABULA_KTX = '/opt/custom/ktx';
    try {
      expect(resolveKtxTool()).toEqual({ path: '/opt/custom/ktx', source: 'env' });
    } finally {
      if (saved === undefined) delete process.env.TABULA_KTX;
      else process.env.TABULA_KTX = saved;
    }
  });
});

describe.skipIf(!hasKtx)('ktx encoder (needs KTX-Software: tabula ktx-tool --install)', () => {
  it('encodes a page that round-trips through the transcoder, flagged premultiplied', async () => {
    const image = { width: 16, height: 8, data: fixture('gradient16x8.rgba') };
    const module = await basis();
    for (const codec of ['uastc', 'etc1s'] as const) {
      const bytes = await encodeKtx2(image, { codec });
      expect(parseKtx2Header(bytes)).toMatchObject({ codec, premultiplied: true, width: 16, height: 8 });
      expect(transcode(module, bytes, 'rgba').length).toBe(512);
    }
    await expect(encodeKtx2({ width: 6, height: 8, data: new Uint8Array(192) }, { codec: 'uastc' })).rejects.toThrow(/multiples of 4/);
  });
});
