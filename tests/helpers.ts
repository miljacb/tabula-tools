/** Test helpers (a subset of tabula-pixi's tests/helpers.ts). */

import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import type { AtlasData, SkeletonData } from 'tabula-pixi/core/types.js';
import type { DrawSink, RegionResolver, TintColors } from 'tabula-pixi/core/renderer.js';
import type { BlendMode } from 'tabula-pixi/core/types.js';

/** Parse an inline Spine JSON object (skeleton header added if missing). */
export function skeletonFrom(json: Record<string, unknown>, name = 'test'): SkeletonData {
  return new SpineJsonParser().parse({ skeleton: { spine: '4.1.00', hash: 'h' }, ...json }, name);
}

export function resolverFor(atlas: AtlasData): RegionResolver<string> {
  return (path) => {
    const region = atlas.regions.get(path);
    return region ? { region, texture: region.page.name } : null;
  };
}

export interface RecordedDraw {
  texture: string;
  blendMode: BlendMode;
  positions: number[];
  uvs: number[];
  indices: number[];
  colors: TintColors;
}

/** DrawSink that records every call (copying the transient arrays). */
export class RecordingSink implements DrawSink<string> {
  readonly draws: RecordedDraw[] = [];
  drawTriangles(
    texture: string, blendMode: BlendMode, positions: ArrayLike<number>, uvs: ArrayLike<number>,
    vertexCount: number, indices: ArrayLike<number>, indexCount: number, colors: TintColors,
  ): void {
    this.draws.push({
      texture,
      blendMode,
      positions: Array.from({ length: vertexCount * 2 }, (_, i) => positions[i]!),
      uvs: Array.from({ length: vertexCount * 2 }, (_, i) => uvs[i]!),
      indices: Array.from({ length: indexCount }, (_, i) => indices[i]!),
      colors: { ...colors },
    });
  }
}
