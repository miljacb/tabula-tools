import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AtlasParser } from 'tabula-pixi/core/adapters/atlas-parser.js';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { BatchCounter } from 'tabula-pixi/core/batching.js';
import { SkeletonRenderer } from 'tabula-pixi/core/renderer.js';
import { Skeleton } from 'tabula-pixi/core/skeleton.js';
import { countInstanceDraws, countSceneDraws, measureInstance, setTextureUnits, getGpuTextureUnits } from '../src/features/perf.js';

/** A stand-in for TabulaView built from a real sample: parsed data, set-up skeleton, page textures as strings. */
function loadSample(name, id = name, z = 0) {
  const dir = new URL('../public/samples/', import.meta.url);
  const atlas = new AtlasParser().parse(readFileSync(new URL(`${name}.atlas`, dir), 'utf8'));
  const data = new SpineJsonParser().parse(JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')), name);
  const resolved = new Map();
  for (const [path, region] of atlas.regions) resolved.set(path, { region, texture: `tex:${name}:${region.page.name}` });
  const skeleton = new Skeleton(data);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform();
  const white = { r: 1, g: 1, b: 1, a: 1 };
  return {
    id,
    zIndex: z,
    visible: true,
    spine: {
      clip: { skeleton, tint: white, darkTint: white },
      asset: { resolve: (path) => resolved.get(path) ?? null },
      skeleton,
      worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: z * 1000, ty: 0 },
      worldAlpha: 1,
    },
    atlas: { pages: [] },
  };
}

test('countInstanceDraws matches the renderer batching of the real skeleton', () => {
  const inst = loadSample('badge');
  const exact = countInstanceDraws(inst);
  const reference = new BatchCounter();
  reference.breakSegment();
  new SkeletonRenderer().draw(inst.spine.clip.skeleton, inst.spine.asset.resolve, reference);
  reference.flush();
  assert.equal(exact.drawCalls, reference.stats.drawCalls);
  assert.equal(exact.vertices, reference.stats.vertices);
  assert.equal(exact.triangles, reference.stats.triangles);
  assert.ok(exact.drawCalls >= 1);
});

test('measureInstance reports the exact counts for tabula views', () => {
  const inst = loadSample('box');
  const m = measureInstance(inst);
  const exact = countInstanceDraws(inst);
  assert.equal(m.exact, true);
  assert.equal(m.drawCalls, exact.drawCalls);
  assert.equal(m.vertexCount, exact.vertices);
});

test('countSceneDraws batches skeletons together and skips hidden ones', () => {
  const a = loadSample('badge', 'a', 0);
  const b = loadSample('badge', 'b', 1);
  const alone = countInstanceDraws(a);
  const together = countSceneDraws([a, b]);
  // Same atlas, no overlap (offset 1000 px): the two share draw calls instead of doubling them.
  assert.ok(together.drawCalls < alone.drawCalls * 2);
  assert.equal(together.vertices, alone.vertices * 2);
  b.visible = false;
  assert.equal(countSceneDraws([a, b]).vertices, alone.vertices);
});

test('fewer texture units never lowers the draw call count', () => {
  const inst = loadSample('box');
  const full = countInstanceDraws(inst, getGpuTextureUnits()).drawCalls;
  const one = countInstanceDraws(inst, 1).drawCalls;
  assert.ok(one >= full);
  setTextureUnits(getGpuTextureUnits());
});
