/**
 * Compressed page textures (design §15.1): KTX2 container parsing, the choice
 * of GPU format a Basis Universal page is transcoded to, resolution tiers and
 * their file names. Pure functions: no WebGL, Pixi or Node; the Pixi bridge
 * feeds them the context's extensions and device hints.
 */

/** Basis Universal codec of a KTX2 page. */
export type BasisCodec = 'uastc' | 'etc1s';

/** Header facts of a KTX2 file that the loader needs. */
export interface Ktx2Info {
  width: number;
  height: number;
  levels: number;
  /** 'uastc' / 'etc1s' for Basis Universal payloads, null for other formats. */
  codec: BasisCodec | null;
  /** 0 none, 1 BasisLZ, 2 Zstandard, 3 ZLIB. */
  supercompression: number;
  /** DFD flag KHR_DF_FLAG_ALPHA_PREMULTIPLIED. */
  premultiplied: boolean;
  /** Byte offset of the DFD flags byte (for writers that patch it). */
  dfdFlagsOffset: number;
}

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
/** DFD color models of Basis Universal payloads. */
const KHR_DF_MODEL_ETC1S = 163;
const KHR_DF_MODEL_UASTC = 166;
/** DFD flags bit: color channels are premultiplied by alpha. */
export const KHR_DF_FLAG_ALPHA_PREMULTIPLIED = 1;

/** Parse the KTX2 header and basic data format descriptor. Throws if `bytes` is not KTX2. */
export function parseKtx2Header(bytes: Uint8Array): Ktx2Info {
  if (bytes.length < 80 || KTX2_IDENTIFIER.some((b, i) => bytes[i] !== b)) throw new Error('Not a KTX2 file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number): number => view.getUint32(o, true);
  const dfdOffset = u32(48);
  // DFD: total size (4), then the basic block: vendor/type (4), version/size (4), colorModel, primaries, transfer, flags.
  const colorModel = bytes[dfdOffset + 12]!;
  const flags = bytes[dfdOffset + 15]!;
  return {
    width: u32(20),
    height: u32(24),
    levels: Math.max(1, u32(40)),
    supercompression: u32(44),
    codec: colorModel === KHR_DF_MODEL_UASTC ? 'uastc' : colorModel === KHR_DF_MODEL_ETC1S ? 'etc1s' : null,
    premultiplied: (flags & KHR_DF_FLAG_ALPHA_PREMULTIPLIED) !== 0,
    dfdFlagsOffset: dfdOffset + 15,
  };
}

/** GPU texture formats a Basis page can be transcoded to (all with alpha), and uncompressed RGBA8. */
export type TranscodeTarget = 'astc' | 'bc7' | 'etc2' | 'bc3' | 'pvrtc' | 'rgba';

/** Per target: Basis transcoder_texture_format, WebGL internal format (0 = uncompressed RGBA8), bits per pixel. */
export const TRANSCODE_TARGETS: Readonly<Record<TranscodeTarget, { basisFormat: number; glFormat: number; bitsPerPixel: number }>> = {
  astc: { basisFormat: 10, glFormat: 0x93b0, bitsPerPixel: 8 }, // cTFASTC_4x4_RGBA → COMPRESSED_RGBA_ASTC_4x4_KHR
  bc7: { basisFormat: 6, glFormat: 0x8e8c, bitsPerPixel: 8 }, // cTFBC7_RGBA → COMPRESSED_RGBA_BPTC_UNORM_EXT
  etc2: { basisFormat: 1, glFormat: 0x9278, bitsPerPixel: 8 }, // cTFETC2_RGBA → COMPRESSED_RGBA8_ETC2_EAC
  bc3: { basisFormat: 3, glFormat: 0x83f3, bitsPerPixel: 8 }, // cTFBC3_RGBA → COMPRESSED_RGBA_S3TC_DXT5_EXT
  pvrtc: { basisFormat: 9, glFormat: 0x8c02, bitsPerPixel: 4 }, // cTFPVRTC1_4_RGBA → COMPRESSED_RGBA_PVRTC_4BPPV1_IMG
  rgba: { basisFormat: 13, glFormat: 0, bitsPerPixel: 32 }, // cTFRGBA32
};

/** Compressed formats a WebGL context supports (from its extensions). */
export interface CompressedTextureSupport {
  astc: boolean;
  bc7: boolean;
  etc2: boolean;
  bc3: boolean;
  pvrtc: boolean;
}

/**
 * Preference per source codec. UASTC is ASTC-like: ASTC and BC7 keep its
 * quality, ETC2 and BC3 are good. ETC1S is ETC1-like: ETC2 is a near copy,
 * BC7 and ASTC are fine. PVRTC1 is last for both (lowest quality, square
 * power-of-two only). Uncompressed RGBA8 is the fallback that always works.
 */
const PREFERENCE: Readonly<Record<BasisCodec, readonly Exclude<TranscodeTarget, 'rgba'>[]>> = {
  uastc: ['astc', 'bc7', 'etc2', 'bc3', 'pvrtc'],
  etc1s: ['etc2', 'bc7', 'astc', 'bc3', 'pvrtc'],
};

/** The format to transcode a `width`×`height` page of `codec` to on a device with `support`. */
export function chooseTranscodeTarget(codec: BasisCodec, support: CompressedTextureSupport, width: number, height: number): TranscodeTarget {
  const pow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
  for (const target of PREFERENCE[codec]) {
    if (!support[target]) continue;
    if (target === 'pvrtc' && (width !== height || !pow2(width))) continue;
    if (width % 4 !== 0 || height % 4 !== 0) continue; // block formats need whole 4×4 blocks for every mip-free page
    return target;
  }
  return 'rgba';
}

/** GPU memory of one transcoded level. */
export function transcodedBytes(target: TranscodeTarget, width: number, height: number): number {
  if (target === 'rgba') return width * height * 4;
  const bw = Math.ceil(width / 4) * 4;
  const bh = Math.ceil(height / 4) * 4;
  return (bw * bh * TRANSCODE_TARGETS[target].bitsPerPixel) / 8;
}

/** Resolution tiers the CLI writes by default (scale of the exported pages). */
export const DEFAULT_TEXTURE_TIERS: readonly number[] = [1, 0.75, 0.5];

/**
 * File name of a page at a tier: `game_0.png` → `game_0@0.5x.png` (unchanged
 * at 1), with the extension swapped when `extension` is given.
 */
export function tierFileName(pageName: string, scale: number, extension?: string): string {
  const dot = pageName.lastIndexOf('.');
  const base = dot > 0 ? pageName.slice(0, dot) : pageName;
  const ext = extension ?? (dot > 0 ? pageName.slice(dot + 1) : '');
  return `${base}${scale === 1 ? '' : `@${+scale.toFixed(4)}x`}${ext ? `.${ext}` : ''}`;
}

/** Page size at a tier, rounded to whole 4×4 blocks. */
export function tierSize(width: number, height: number, scale: number): { width: number; height: number } {
  if (scale === 1) return { width, height };
  return { width: Math.max(4, Math.round((width * scale) / 4) * 4), height: Math.max(4, Math.round((height * scale) / 4) * 4) };
}

/** What the tier choice looks at (all optional except the texture size limit). */
export interface DeviceTextureHints {
  /** GL MAX_TEXTURE_SIZE. */
  maxTextureSize: number;
  /** navigator.deviceMemory (GiB; Chromium only, capped at 8). */
  deviceMemory?: number;
  /** navigator.hardwareConcurrency. */
  cores?: number;
  /** Canvas backing-store pixels (CSS size × resolution). */
  canvasPixels?: number;
  /** Software rasterizer (SwiftShader, llvmpipe) or a major-performance-caveat context. */
  software?: boolean;
}

/**
 * Resolution tier for a device (design §10.2): the largest of `tiers` at
 * or below the device class. Low (software GL, ≤ 2 GiB, MAX_TEXTURE_SIZE <
 * 4096, or a canvas under 0.6 Mpx) → 0.5; medium (≤ 4 GiB, ≤ 4 cores, or a
 * canvas under 1.5 Mpx) → 0.75; else 1.
 */
export function chooseTextureTier(hints: DeviceTextureHints, tiers: readonly number[] = DEFAULT_TEXTURE_TIERS): number {
  const memory = hints.deviceMemory ?? 8;
  const cores = hints.cores ?? 8;
  const pixels = hints.canvasPixels ?? Infinity;
  let want = 1;
  if (hints.software || memory <= 2 || hints.maxTextureSize < 4096 || pixels < 0.6e6) want = 0.5;
  else if (memory <= 4 || cores <= 4 || pixels < 1.5e6) want = 0.75;
  const sorted = [...tiers].sort((a, b) => b - a);
  return sorted.find((t) => t <= want + 1e-9) ?? sorted[sorted.length - 1] ?? 1;
}

/**
 * `<group>.textures.json`, written by `tabula repack` next to the atlas:
 * which tiers and encodings exist for each page. The atlas itself always
 * describes the 1× pages; a tier file has the same layout scaled, and UVs
 * are normalised by the atlas page size, so any tier fits the same atlas.
 */
export interface TextureManifest {
  version: 1;
  /** Tiers written for every page, largest first. */
  tiers: number[];
  pages: Record<string, TextureManifestPage>;
}

/** One page of a `textures.json` texture manifest: size, KTX2 codec and the files per tier/format. */
export interface TextureManifestPage {
  /** 1× size (as in the atlas). */
  width: number;
  height: number;
  /** Basis codec of the `.ktx2` files of this page, or null if it has none. */
  ktx2: BasisCodec | null;
  /** File name → bytes, for every tier and encoding written. */
  files: Record<string, number>;
}

/** The tier of `tiers` used for a `requested` one: the largest at or below it, else the smallest (1 without tiers). */
export function resolveTier(requested: number, tiers: readonly number[]): number {
  if (!tiers.length) return 1;
  const sorted = [...tiers].sort((a, b) => b - a);
  return sorted.find((t) => t <= requested + 1e-9) ?? sorted[sorted.length - 1]!;
}

/**
 * The file to load for `pageName` at `tier` (see {@link resolveTier} when the
 * manifest lacks that tier): the KTX2 file when wanted and present, else the
 * image; `tier` is the tier of that file.
 */
export function manifestPageFile(manifest: TextureManifest, pageName: string, tier: number, ktx2: boolean): { file: string; ktx2: boolean; tier: number } {
  const page = manifest.pages[pageName];
  const useTier = page ? resolveTier(tier, manifest.tiers) : 1;
  if (page && ktx2 && page.ktx2) return { file: tierFileName(pageName, useTier, 'ktx2'), ktx2: true, tier: useTier };
  return { file: tierFileName(pageName, useTier), ktx2: false, tier: useTier };
}
