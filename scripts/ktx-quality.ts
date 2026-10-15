/**
 * KTX2 encoder quality check: encodes atlas pages with the resolved `ktx`
 * tool (UASTC and ETC1S, repack defaults), transcodes them back to RGBA with
 * the vendored Basis transcoder and reports PSNR against the premultiplied
 * source, file size and a SHA-256 of the KTX2 bytes, so runs on different
 * machines (box vs Mac) can be compared.
 *
 *   npx tsx scripts/ktx-quality.ts [--out file.json] [page.png ...]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import sharp from 'sharp';
import { checkKtxTool, encodeKtx2, ktxTool } from '../src/export/pack/ktx2.js';
import { createImage, premultiply } from '../src/export/pack/image.js';
import type { RgbaImage } from '../src/export/pack/image.js';

const BASIS_RGBA32 = 13;
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : null;
const pages = args.length ? args : ['storeBackground.png', 'fontBandidoTextImage.png', 'shotgunShells.png'].map((p) => `../tabula-pixi/test-assets/${p}`);

interface BasisFile {
  isValid(): number; startTranscoding(): number; getImageTranscodedSizeInBytes(l: number, a: number, f: number, fmt: number): number;
  transcodeImage(dst: Uint8Array, l: number, a: number, f: number, fmt: number, g: number, c0: number, c1: number): number; close(): void; delete(): void;
}

async function main(): Promise<void> {
  const version = await checkKtxTool();
  const require = createRequire(import.meta.url);
  const factory = require('tabula-pixi/basis/basis_transcoder.js') as (o: object) => Promise<{ initializeBasis(): void; KTX2File: new (b: Uint8Array) => BasisFile }>;
  const basis = await factory({ wasmBinary: readFileSync(require.resolve('tabula-pixi/basis/basis_transcoder.wasm')) });
  basis.initializeBasis();
  const results = [];
  for (const file of pages) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const image = createImage(Math.ceil(info.width / 4) * 4, Math.ceil(info.height / 4) * 4);
    for (let y = 0; y < info.height; y++) image.data.set(data.subarray(y * info.width * 4, (y + 1) * info.width * 4), y * image.width * 4);
    premultiply(image);
    for (const codec of ['uastc', 'etc1s'] as const) {
      const start = performance.now();
      const bytes = await encodeKtx2(image, { codec });
      const encodeMs = performance.now() - start;
      const decoded = transcode(basis, bytes);
      results.push({
        page: basename(file), codec, width: image.width, height: image.height, bytes: bytes.length,
        psnr: Number(psnr(image, decoded).toFixed(3)), sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16), encodeMs: Math.round(encodeMs),
      });
      console.log(`${basename(file).padEnd(32)} ${codec.padEnd(6)} ${String(bytes.length).padStart(9)} B  PSNR ${psnr(image, decoded).toFixed(2)} dB  ${Math.round(encodeMs)} ms`);
    }
  }
  const report = { tool: ktxTool(), version, platform: `${process.platform}-${process.arch}`, results };
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}

function transcode(basis: { KTX2File: new (b: Uint8Array) => BasisFile }, bytes: Uint8Array): Uint8Array {
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid() || !file.startTranscoding()) throw new Error('invalid KTX2');
    const dst = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, BASIS_RGBA32));
    if (!file.transcodeImage(dst, 0, 0, 0, BASIS_RGBA32, 0, -1, -1)) throw new Error('transcode failed');
    return dst;
  } finally {
    file.close();
    file.delete();
  }
}

/** PSNR over all four channels (premultiplied RGBA8). */
function psnr(source: RgbaImage, decoded: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < source.data.length; i++) {
    const d = source.data[i]! - decoded[i]!;
    sum += d * d;
  }
  const mse = sum / source.data.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
