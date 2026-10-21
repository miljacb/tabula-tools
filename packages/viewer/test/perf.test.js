import assert from 'node:assert/strict';
import test from 'node:test';
import { measureInstance, sumPerf } from '../src/features/perf.js';

function page(name, width, height, uid) {
  return { name, width, height, texture: { baseTexture: { uid } } };
}

function slot(attachment, blendMode = 0, alpha = 1) {
  return {
    blendMode,
    color: { a: alpha },
    attachment,
  };
}

/** Atlas as the loader hands it over: pages for memory, region data and textures for draw calls. */
function atlasOf(pages, regionPages = {}) {
  const regions = new Map(Object.entries(regionPages).map(([path, p]) => [path, { page: { name: p.name } }]));
  const textures = new Map(pages.map((p) => [p.name, p.texture.baseTexture]));
  return { pages, data: { regions }, textures };
}

test('measureInstance counts drawn vertices and skips empty or clear slots', () => {
  const shared = page('hero.webp', 100, 50, 7);
  const region = { type: 'region', path: 'a' };
  const mesh = { type: 'mesh', path: 'b', worldVerticesLength: 10 };
  const hidden = { type: 'region', path: 'a' };
  const clip = { type: 'clipping', worldVerticesLength: 8 };
  const row = measureInstance({
    atlas: atlasOf([shared], { a: shared, b: shared }),
    spine: {
      skeleton: {
        drawOrder: [slot(null), slot(hidden, 0, 0), slot(region), slot(mesh, 1), slot(clip)],
        bones: [{}, {}],
        data: {},
      },
    },
  });
  assert.equal(row.vertexCount, 9);
  assert.equal(row.drawCalls, 2);
  assert.equal(row.clippingCount, 1);
  assert.equal(row.blends, 'Normal: 1, Additive: 1');
  assert.equal(row.memoryBytes, 100 * 50 * 4);
});

test('sumPerf counts a shared texture once', () => {
  const shared = page('hero.webp', 64, 64, 3);
  const make = () => measureInstance({
    atlas: { pages: [shared] },
    spine: { skeleton: { drawOrder: [], bones: [{}], data: {} } },
  });
  const total = sumPerf([make(), make()]);
  assert.equal(total.memoryBytes, 64 * 64 * 4);
  assert.equal(total.pageInfo.length, 1);
  assert.equal(total.bones, 2);
});

test('power-of-two textures include the mip chain, and separate uploads both count', () => {
  const pot = page('hero.webp', 64, 64, 3);
  pot.texture.baseTexture.mipmap = 1;
  const other = page('hero.webp', 64, 64, 9);
  other.texture.baseTexture.mipmap = 1;
  const row = (atlasPage) => measureInstance({
    atlas: { pages: [atlasPage] },
    spine: { skeleton: { drawOrder: [], bones: [], data: {} } },
  });
  const total = sumPerf([row(pot), row(other)]);
  assert.equal(total.memoryBytes, Math.round(64 * 64 * 4 * 4 / 3) * 2);
  assert.equal(total.pageInfo.length, 2);
  assert.match(total.pageInfo[0], /^1: /);
  assert.match(total.pageInfo[1], /^2: /);
});
