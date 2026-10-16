/**
 * Bake-time error report: poses every animation from the compressed baked
 * samples and compares attachment world vertices and slot colors against
 * exact references, so the CLI states the measured error, not just a bound.
 *
 * Geometry is compared for every attached region/mesh regardless of its
 * alpha, so a vertex count never depends on whether an attachment is
 * momentarily transparent.
 */

import { Clip } from './clip.js';
import { bakeGridCount, bakedFrameTime, bakeSkeletonAnimations } from './bake.js';
import type { BakedSkeletonData } from './bake.js';
import { computeRegionGeometry, computeRegionWorldVertices, computeWorldVertices, currentRegionPath, QUAD_FLOATS } from './attachments.js';
import type { RegionGeometry } from './attachments.js';
import type { Skeleton } from './skeleton.js';
import type { AtlasData, AtlasRegion, RegionAttachment, SkeletonData } from './types.js';
import { DEFAULT_BAKE_MAX_ERROR, bakeEncoding, deserializeBakedData, serializeBakedData } from './baked-format.js';

/** Where inside each interval between samples playback is compared with live. */
const PROBES = [0.25, 0.5, 0.75];

/** Measured errors of one baked animation. */
export interface AnimationBakeError {
  animation: string;
  samples: number;
  /** Samples added by error-driven refinement (beyond the base grid). */
  refinedSamples: number;
  /** Max vertex distance (skeleton units) between compressed and exact samples, at every sample time. */
  encodeError: number;
  /** Max slot color channel difference (0–1, light and dark) between compressed and exact samples. */
  colorError: number;
  /**
   * Max vertex distance between compressed baked playback and live evaluation,
   * at a quarter, half and three quarters of every interval between samples,
   * over attachments visible (alpha > 0) in the live pose.
   */
  interpolationError: number;
}

/** World vertices of every attached region/mesh/clipping polygon in draw order, with per-vertex visibility. */
export class GeometryCapture {
  readonly vertices: number[] = [];
  /** Per vertex: 1 if its attachment is drawn with alpha > 0. */
  readonly visible: number[] = [];
  private readonly scratch: number[] = [];
  private readonly regionGeometry = new Map<RegionAttachment, Map<AtlasRegion, RegionGeometry>>();

  constructor(private readonly atlas: AtlasData) {}

  capture(skeleton: Skeleton): number[] {
    const out = this.vertices;
    out.length = 0;
    this.visible.length = 0;
    for (const slot of skeleton.drawOrder) {
      const attachment = slot.attachment;
      const start = out.length;
      if (attachment?.type === 'region') {
        const region = this.atlas.regions.get(currentRegionPath(attachment, slot));
        if (!region) continue;
        let perRegion = this.regionGeometry.get(attachment);
        if (!perRegion) this.regionGeometry.set(attachment, (perRegion = new Map()));
        let geometry = perRegion.get(region);
        if (!geometry) perRegion.set(region, (geometry = computeRegionGeometry(attachment, region)));
        this.scratch.length = QUAD_FLOATS;
        computeRegionWorldVertices(slot, geometry.offsets, this.scratch, 0, 2);
        out.push(...this.scratch);
      } else if (attachment?.type === 'mesh' || attachment?.type === 'clipping') {
        const n = attachment.worldVerticesLength;
        this.scratch.length = n;
        computeWorldVertices(attachment, slot, 0, n, this.scratch, 0, 2);
        out.push(...this.scratch);
      }
      const alpha = slot.color.a * (attachment && 'color' in attachment ? attachment.color.a : 1);
      for (let i = start; i < out.length; i += 2) this.visible.push(alpha > 0 ? 1 : 0);
    }
    return out;
  }
}

function colors(skeleton: Skeleton, out: number[]): number[] {
  out.length = 0;
  for (const slot of skeleton.slots) {
    const { color: c, darkColor: d } = slot;
    out.push(c.r, c.g, c.b, c.a, d ? d.r : 0, d ? d.g : 0, d ? d.b : 0);
  }
  return out;
}

/** Max distance between corresponding vertices; with `mask`, only where mask[vertex] is 1. */
function maxDistance(a: number[], b: number[], mask?: number[]): number {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i += 2) {
    if (!mask || mask[i >> 1]) max = Math.max(max, Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!));
  }
  return max;
}

function maxAbs(a: number[], b: number[]): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

/**
 * Measure `decoded` (compressed, then loaded) against `exact` (the same bake
 * before compression) at every sample, and against live playback of `data`
 * between samples.
 */
export function measureBakeError(data: SkeletonData, atlas: AtlasData, exact: BakedSkeletonData, decoded: BakedSkeletonData): AnimationBakeError[] {
  const live = new Clip(data, { yDown: exact.yDown });
  const reference = new Clip(data, { yDown: exact.yDown, baked: exact });
  const compressed = new Clip(data, { yDown: exact.yDown, baked: decoded });
  const a = new GeometryCapture(atlas);
  const b = new GeometryCapture(atlas);
  const ca: number[] = [];
  const cb: number[] = [];

  return decoded.animations.map((anim) => {
    const result: AnimationBakeError = {
      animation: anim.name, samples: anim.frameCount, refinedSamples: anim.frameCount - bakeGridCount(anim.duration, anim.fps),
      encodeError: 0, colorError: 0, interpolationError: 0,
    };
    live.play(anim.name).pause();
    reference.play(anim.name).pause();
    compressed.play(anim.name).pause();
    for (let f = 0; f < anim.frameCount; f++) {
      const t = bakedFrameTime(anim, f);
      reference.seek(t);
      compressed.seek(t);
      result.encodeError = Math.max(result.encodeError, maxDistance(a.capture(reference.skeleton), b.capture(compressed.skeleton)));
      result.colorError = Math.max(result.colorError, maxAbs(colors(reference.skeleton, ca), colors(compressed.skeleton, cb)));
      if (f + 1 < anim.frameCount) {
        const next = bakedFrameTime(anim, f + 1);
        for (const u of PROBES) {
          const probe = t + (next - t) * u;
          live.seek(probe);
          compressed.seek(probe);
          const error = maxDistance(a.capture(live.skeleton), b.capture(compressed.skeleton), a.visible);
          result.interpolationError = Math.max(result.interpolationError, error);
        }
      }
    }
    return result;
  });
}

/** Options for {@link bakeToBuffer}. */
export interface BakeOptions {
  /** Sample rate. Default: a multiple of the authoring key rate ≥ 30 fps (see autoBakeFps in core/bake). */
  fps?: number;
  /** Comma-separated animation names. Default: all. */
  animations?: string;
  /** Skin to bake with. */
  skin?: string;
  /** Vertex error budget in skeleton units; 0 = lossless. Default {@link DEFAULT_BAKE_MAX_ERROR}. */
  maxError?: number;
  /** Largest deviation from live between samples, skeleton units (0 = fixed rate only). Default: core DEFAULT_BAKE_TOLERANCE. */
  tolerance?: number;
  /** Skip the error report (it renders every sample twice). */
  noReport?: boolean;
}

/** Result of {@link bakeToBuffer}. */
export interface BakeResult {
  bytes: ArrayBuffer;
  /** Size without compression (maxError 0), for comparison. */
  losslessBytes: number;
  report: AnimationBakeError[] | null;
}

/** Bake and compress `data`; with an atlas, also measure the errors. */
export function bakeToBuffer(data: SkeletonData, atlas: AtlasData | null, options: BakeOptions = {}): BakeResult {
  const baked = bakeSkeletonAnimations(data, {
    fps: options.fps,
    animations: options.animations?.split(',').map((s) => s.trim()),
    skin: options.skin,
    tolerance: options.tolerance,
  });
  const maxError = options.maxError ?? DEFAULT_BAKE_MAX_ERROR;
  const bytes = serializeBakedData(baked, bakeEncoding(data, maxError));
  const losslessBytes = maxError > 0 ? serializeBakedData(baked).byteLength : bytes.byteLength;
  const report = atlas && !options.noReport ? measureBakeError(data, atlas, baked, deserializeBakedData(bytes)) : null;
  return { bytes, losslessBytes, report };
}
