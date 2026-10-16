/**
 * KTX2 / Basis Universal page encoding (export, `tabula repack --ktx2`,
 * `tabula font --ktx2`). Encoding is done by the `ktx` tool of KTX-Software
 * (https://github.com/KhronosGroup/KTX-Software, 4.3 or newer): found as
 * `$TABULA_KTX`, else the project-local copy (`tabula ktx-tool
 * --install`, installed automatically on first use), else `ktx` on PATH. See
 * ktx-tool.ts.
 *
 * Pages are encoded premultiplied: a compressed texture cannot be
 * premultiplied on upload, and premultiplying before block compression is
 * also what keeps bilinear filtering free of dark fringes. The DFD
 * KHR_DF_FLAG_ALPHA_PREMULTIPLIED flag is set so loaders know.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { KHR_DF_FLAG_ALPHA_PREMULTIPLIED, parseKtx2Header } from '../../core/texture-formats.js';
import type { BasisCodec } from '../../core/texture-formats.js';
import type { RgbaImage } from './image.js';
import { installKtxTool, ktxVersionSync, resolveKtxTool } from './ktx-tool.js';

const run = promisify(execFile);

/** Encoder settings of one page. */
export interface Ktx2EncodeOptions {
  codec: BasisCodec;
  /** UASTC: pack level 0-4 (default 2). ETC1S: quality 1-255 (default 128). */
  quality?: number;
  /** UASTC: rate-distortion optimisation for smaller Zstandard output (default on). */
  rdo?: boolean;
  /** Write a full mip chain (for pages whose filter uses mipmaps). */
  mipmaps?: boolean;
  /** Data texture (e.g. SDF font pages): linear transfer, straight alpha (default false: sRGB, premultiplied). */
  linear?: boolean;
}

let tool: string | null = null;

/** The `ktx` executable to run (see {@link resolveKtxTool}; after {@link checkKtxTool}, the one it settled on). */
export function ktxTool(): string {
  return tool ?? resolveKtxTool().path;
}

let checked: Promise<string> | null = null;
let installLog: (message: string) => void = () => undefined;

/** Where progress of the automatic `ktx` install goes (default: nowhere). The CLI prints it. */
export function setKtxInstallLog(log: (message: string) => void): void {
  installLog = log;
}

/**
 * Version string of the `ktx` tool. If none is found and
 * `$TABULA_KTX_DOWNLOAD` is not `0`, installs the pinned KTX-Software
 * build into the project cache first ({@link installKtxTool}).
 * @throws with install instructions if no tool is available.
 */
export function checkKtxTool(): Promise<string> {
  checked ??= (async (): Promise<string> => {
    const found = resolveKtxTool();
    const version = ktxVersionSync(found.path);
    if (version) {
      tool = found.path;
      return version;
    }
    if (found.source !== 'env' && process.env.TABULA_KTX_DOWNLOAD !== '0') {
      try {
        tool = await installKtxTool({ log: installLog });
        return ktxVersionSync(tool) ?? '';
      } catch (error) {
        throw new Error(`KTX2 output needs the "ktx" tool from KTX-Software 4.3+ and installing it into the project failed: ${(error as Error).message}`);
      }
    }
    throw new Error(
      `KTX2 output needs the "ktx" tool from KTX-Software 4.3+: run "tabula ktx-tool --install" (project-local, no admin rights), ` +
        `put ktx on PATH, or set TABULA_KTX to its path`,
    );
  })();
  checked.catch(() => (checked = null));
  return checked;
}

/** Encode a premultiplied RGBA8 page (or, with `linear`, a data texture) to KTX2 (Basis Universal UASTC + Zstandard, or ETC1S/BasisLZ). */
export async function encodeKtx2(image: RgbaImage, options: Ktx2EncodeOptions): Promise<Uint8Array> {
  await checkKtxTool();
  if (image.width % 4 || image.height % 4) throw new Error(`KTX2 pages must be multiples of 4 pixels, got ${image.width}x${image.height}`);
  const dir = await mkdtemp(join(tmpdir(), 'tabula-ktx-'));
  try {
    const input = join(dir, 'page.raw');
    const output = join(dir, 'page.ktx2');
    await writeFile(input, image.data);
    const args = ['create', '--format', options.linear ? 'R8G8B8A8_UNORM' : 'R8G8B8A8_SRGB', '--raw', '--width', String(image.width), '--height', String(image.height)];
    if (options.codec === 'uastc') {
      args.push('--encode', 'uastc', '--uastc-quality', String(options.quality ?? 2));
      if (options.rdo ?? !options.linear) args.push('--uastc-rdo');
      args.push('--zstd', '18');
    } else {
      args.push('--encode', 'basis-lz', '--clevel', '2', '--qlevel', String(options.quality ?? 128));
    }
    if (options.mipmaps) args.push('--generate-mipmap');
    args.push(input, output);
    await run(ktxTool(), args, { maxBuffer: 16 << 20 });
    const bytes = new Uint8Array(await readFile(output));
    return options.linear ? bytes : markPremultiplied(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Set the DFD premultiplied-alpha flag of a KTX2 file in place. */
export function markPremultiplied(bytes: Uint8Array): Uint8Array {
  const info = parseKtx2Header(bytes);
  bytes[info.dfdFlagsOffset] = bytes[info.dfdFlagsOffset]! | KHR_DF_FLAG_ALPHA_PREMULTIPLIED;
  return bytes;
}
