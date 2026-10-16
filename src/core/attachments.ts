/**
 * Attachment geometry with Spine 4.1 semantics: world vertices for
 * vertex attachments (weighted, deformed), region quad offsets and UVs, mesh UVs
 * for every atlas packing rotation, and sequence frame resolution.
 */

import { DEG_TO_RAD } from './math.js';
import type { AtlasRegion, MeshAttachment, RegionAttachment, SequenceData, VertexData } from './types.js';
import type { Slot } from './skeleton.js';

/** Floats per region quad (4 vertices × x,y). */
export const QUAD_FLOATS = 8;

/** Triangles of a region quad in BL, UL, UR, BR vertex order. */
export const QUAD_TRIANGLES: Uint16Array = new Uint16Array([0, 1, 2, 2, 3, 0]);

/**
 * Transform `count` floats of a vertex attachment, starting at float `start`,
 * into world space (spine-core `VertexAttachment.computeWorldVertices`).
 * Uses the slot's deform when present.
 */
export function computeWorldVertices(
  attachment: VertexData,
  slot: Slot,
  start: number,
  count: number,
  out: number[] | Float32Array | Float64Array,
  offset: number,
  stride: number,
): void {
  const end = offset + (count >> 1) * stride;
  const deform = slot.deform;
  const bones = attachment.bones;
  if (!bones) {
    const vertices: ArrayLike<number> = deform.length > 0 ? deform : attachment.vertices;
    const bone = slot.bone;
    const { a, b, c, d, worldX: x, worldY: y } = bone;
    for (let v = start, w = offset; w < end; v += 2, w += stride) {
      const vx = vertices[v]!;
      const vy = vertices[v + 1]!;
      out[w] = vx * a + vy * b + x;
      out[w + 1] = vx * c + vy * d + y;
    }
    return;
  }

  const vertices = attachment.vertices;
  let v = 0;
  let skip = 0;
  for (let i = 0; i < start; i += 2) {
    const n = bones[v]!;
    v += n + 1;
    skip += n;
  }
  const skeletonBones = slot.bone.skeleton.bones;
  const hasDeform = deform.length > 0;
  for (let w = offset, b = skip * 3, f = skip << 1; w < end; w += stride) {
    let wx = 0;
    let wy = 0;
    const n = v + 1 + bones[v]!;
    v++;
    for (; v < n; v++, b += 3, f += 2) {
      const bone = skeletonBones[bones[v]!]!;
      const vx = hasDeform ? vertices[b]! + deform[f]! : vertices[b]!;
      const vy = hasDeform ? vertices[b + 1]! + deform[f + 1]! : vertices[b + 1]!;
      const weight = vertices[b + 2]!;
      wx += (vx * bone.a + vy * bone.b + bone.worldX) * weight;
      wy += (vx * bone.c + vy * bone.d + bone.worldY) * weight;
    }
    out[w] = wx;
    out[w + 1] = wy;
  }
}

// ============================================================================
// Sequences
// ============================================================================

/** Atlas region name of sequence frame `index` (spine-core `Sequence.getPath`). */
export function sequenceFramePath(basePath: string, sequence: SequenceData, index: number): string {
  return basePath + String(sequence.start + index).padStart(sequence.digits, '0');
}

/** Region path an attachment currently shows, resolving the slot's sequence index. */
export function currentRegionPath(attachment: RegionAttachment | MeshAttachment, slot: Slot): string {
  const sequence = attachment.sequence;
  if (!sequence) return attachment.path;
  let index = slot.sequenceIndex;
  if (index === -1) index = sequence.setupIndex;
  if (index >= sequence.count) index = sequence.count - 1;
  return sequenceFramePath(attachment.path, sequence, index);
}

// ============================================================================
// Region attachments
// ============================================================================

/** Region size/UV derived data, computed once per (attachment, atlas region). */
export interface RegionGeometry {
  /** Bone-space quad corners BL, UL, UR, BR. */
  offsets: Float32Array;
  /** UVs for the same corners. */
  uvs: Float32Array;
}

/** spine-core `RegionAttachment.updateRegion`. */
export function computeRegionGeometry(attachment: RegionAttachment, region: AtlasRegion): RegionGeometry {
  const offsets = new Float32Array(QUAD_FLOATS);
  const uvs = new Float32Array(QUAD_FLOATS);
  const { width, height, scaleX, scaleY } = attachment;
  const regionScaleX = (width / region.originalWidth) * scaleX;
  const regionScaleY = (height / region.originalHeight) * scaleY;
  const localX = (-width / 2) * scaleX + region.offsetX * regionScaleX;
  const localY = (-height / 2) * scaleY + region.offsetY * regionScaleY;
  const localX2 = localX + region.width * regionScaleX;
  const localY2 = localY + region.height * regionScaleY;
  const radians = attachment.rotation * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const { x, y } = attachment;
  const localXCos = localX * cos + x;
  const localXSin = localX * sin;
  const localYCos = localY * cos + y;
  const localYSin = localY * sin;
  const localX2Cos = localX2 * cos + x;
  const localX2Sin = localX2 * sin;
  const localY2Cos = localY2 * cos + y;
  const localY2Sin = localY2 * sin;
  offsets[0] = localXCos - localYSin;
  offsets[1] = localYCos + localXSin;
  offsets[2] = localXCos - localY2Sin;
  offsets[3] = localY2Cos + localXSin;
  offsets[4] = localX2Cos - localY2Sin;
  offsets[5] = localY2Cos + localX2Sin;
  offsets[6] = localX2Cos - localYSin;
  offsets[7] = localYCos + localX2Sin;

  const { u, v, u2, v2 } = regionUVBounds(region);
  if (region.degrees === 90) {
    uvs.set([u2, v2, u, v2, u, v, u2, v]);
  } else {
    uvs.set([u, v2, u, v, u2, v, u2, v2]);
  }
  return { offsets, uvs };
}

/** Transform region quad offsets by the slot bone (spine-core `RegionAttachment.computeWorldVertices`). */
export function computeRegionWorldVertices(slot: Slot, offsets: Float32Array, out: Float32Array | Float64Array | number[], offset: number, stride: number): void {
  const { a, b, c, d, worldX: x, worldY: y } = slot.bone;
  for (let i = 0, w = offset; i < QUAD_FLOATS; i += 2, w += stride) {
    const ox = offsets[i]!;
    const oy = offsets[i + 1]!;
    out[w] = ox * a + oy * b + x;
    out[w + 1] = ox * c + oy * d + y;
  }
}

/** Texture-space bounds of a packed region (spine-core atlas u, v, u2, v2). */
export function regionUVBounds(region: AtlasRegion): { u: number; v: number; u2: number; v2: number } {
  const pw = region.page.width;
  const ph = region.page.height;
  const rotated = region.degrees === 90;
  const packedW = rotated ? region.height : region.width;
  const packedH = rotated ? region.width : region.height;
  return {
    u: region.x / pw,
    v: region.y / ph,
    u2: (region.x + packedW) / pw,
    v2: (region.y + packedH) / ph,
  };
}

// ============================================================================
// Mesh attachments
// ============================================================================

/** spine-core `MeshAttachment.updateRegion`: texture UVs for a mesh in a packed region. */
export function computeMeshUVs(attachment: MeshAttachment, region: AtlasRegion): Float32Array {
  const regionUVs = attachment.regionUVs;
  const n = regionUVs.length;
  const uvs = new Float32Array(n);
  const textureWidth = region.page.width;
  const textureHeight = region.page.height;
  let { u, v } = regionUVBounds(region);
  let width: number;
  let height: number;
  switch (region.degrees) {
    case 90:
      u -= (region.originalHeight - region.offsetY - region.height) / textureWidth;
      v -= (region.originalWidth - region.offsetX - region.width) / textureHeight;
      width = region.originalHeight / textureWidth;
      height = region.originalWidth / textureHeight;
      for (let i = 0; i < n; i += 2) {
        uvs[i] = u + regionUVs[i + 1]! * width;
        uvs[i + 1] = v + (1 - regionUVs[i]!) * height;
      }
      return uvs;
    case 180:
      u -= (region.originalWidth - region.offsetX - region.width) / textureWidth;
      v -= region.offsetY / textureHeight;
      width = region.originalWidth / textureWidth;
      height = region.originalHeight / textureHeight;
      for (let i = 0; i < n; i += 2) {
        uvs[i] = u + (1 - regionUVs[i]!) * width;
        uvs[i + 1] = v + (1 - regionUVs[i + 1]!) * height;
      }
      return uvs;
    case 270:
      u -= region.offsetY / textureWidth;
      v -= region.offsetX / textureHeight;
      width = region.originalHeight / textureWidth;
      height = region.originalWidth / textureHeight;
      for (let i = 0; i < n; i += 2) {
        uvs[i] = u + (1 - regionUVs[i + 1]!) * width;
        uvs[i + 1] = v + regionUVs[i]! * height;
      }
      return uvs;
  }
  u -= region.offsetX / textureWidth;
  v -= (region.originalHeight - region.offsetY - region.height) / textureHeight;
  width = region.originalWidth / textureWidth;
  height = region.originalHeight / textureHeight;
  for (let i = 0; i < n; i += 2) {
    uvs[i] = u + regionUVs[i]! * width;
    uvs[i + 1] = v + regionUVs[i + 1]! * height;
  }
  return uvs;
}
