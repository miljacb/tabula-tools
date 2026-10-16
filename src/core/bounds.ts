/**
 * Bounding box attachments: world-space polygons of the boxes visible in the
 * current pose, and point hit-testing (spine-core `SkeletonBounds`).
 */

import { computeWorldVertices } from './attachments.js';
import type { Skeleton, Slot } from './skeleton.js';
import type { BoundingBoxAttachment } from './types.js';

/** A visible bounding box and its world polygon. */
export interface BoundingBoxPolygon {
  slot: Slot;
  attachment: BoundingBoxAttachment;
  /** x,y pairs in skeleton (world) space; `vertexCount * 2` floats are valid. */
  vertices: Float32Array;
  vertexCount: number;
}

/**
 * Even-odd point-in-polygon test (spine-core `SkeletonBounds.containsPoint`).
 * Works for concave polygons.
 */
export function polygonContainsPoint(vertices: ArrayLike<number>, vertexCount: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = vertexCount - 1; i < vertexCount; j = i++) {
    const xi = vertices[i * 2]!, yi = vertices[i * 2 + 1]!;
    const xj = vertices[j * 2]!, yj = vertices[j * 2 + 1]!;
    if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
      if (xi + ((y - yi) / (yj - yi)) * (xj - xi) < x) inside = !inside;
    }
  }
  return inside;
}

/** World polygons of a skeleton's visible bounding boxes. Reuses its buffers between updates. */
export class SkeletonBounds {
  /** Visible boxes after the last {@link update}, in draw order. */
  readonly polygons: BoundingBoxPolygon[] = [];
  private readonly pool: BoundingBoxPolygon[] = [];

  /** Recompute the polygons from the skeleton's current pose (world transforms must be up to date). */
  update(skeleton: Skeleton): this {
    const polygons = this.polygons;
    polygons.length = 0;
    for (const slot of skeleton.drawOrder) {
      const attachment = slot.attachment;
      if (attachment?.type !== 'boundingbox' || !slot.bone.active) continue;
      const n = attachment.worldVerticesLength;
      let polygon = this.pool[polygons.length];
      if (!polygon) this.pool.push((polygon = { slot, attachment, vertices: new Float32Array(n), vertexCount: 0 }));
      if (polygon.vertices.length < n) polygon.vertices = new Float32Array(n);
      polygon.slot = slot;
      polygon.attachment = attachment;
      polygon.vertexCount = n >> 1;
      computeWorldVertices(attachment, slot, 0, n, polygon.vertices, 0, 2);
      polygons.push(polygon);
    }
    return this;
  }

  /** The last box in draw order (topmost) containing the point, or null. */
  containsPoint(x: number, y: number): BoundingBoxPolygon | null {
    for (let i = this.polygons.length - 1; i >= 0; i--) {
      const p = this.polygons[i]!;
      if (polygonContainsPoint(p.vertices, p.vertexCount, x, y)) return p;
    }
    return null;
  }

  /** The visible box with this attachment name, or null. */
  find(attachmentName: string): BoundingBoxPolygon | null {
    return this.polygons.find((p) => p.attachment.name === attachmentName) ?? null;
  }
}
