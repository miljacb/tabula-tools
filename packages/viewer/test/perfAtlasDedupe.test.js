import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentPageKey,
  marginalAtlasBytesForInstance,
  measureInstance,
  sceneAtlasMemorySummary,
  sumAtlasByContentKey,
} from '../src/features/perf.js';

/** @param {string} id @param {number} z @param {number} uid @param {string} name */
function mockInst(id, z, uid, name) {
  const w = 1024;
  const h = 1024;
  const base = { uid, realWidth: w, realHeight: h, width: w, height: h, format: 6408 };
  const page = { name, width: w, height: h, texture: { texture: { baseTexture: base } } };
  return {
    id,
    zIndex: z,
    spine: { skeleton: { drawOrder: [], bones: [], data: {} } },
    atlas: { pages: [page] },
  };
}

test('contentPageKey ignores GPU uid', () => {
  const page = { name: 'hero.webp', width: 512, height: 256 };
  const a = contentPageKey(page, { realWidth: 512, realHeight: 256 });
  const b = contentPageKey(page, { uid: 99, realWidth: 512, realHeight: 256 });
  assert.equal(a, b);
  assert.equal(a, 'file:hero.webp:512x256');
});

test('sumAtlasByContentKey dedupes same file across instances', () => {
  const a = mockInst('a', 0, 1, 'shared.webp');
  const b = mockInst('b', 1, 2, 'shared.webp');
  const rows = [measureInstance(a), measureInstance(b)];
  const stacked = rows.reduce((s, r) => s + r.memoryBytes, 0);
  const unique = sumAtlasByContentKey(rows);
  assert.ok(stacked > unique.memoryBytes);
  assert.equal(unique.pageCount, 1);
});

test('marginalAtlasBytesForInstance charges first z-order only once', () => {
  const first = mockInst('a', 0, 1, 'shared.webp');
  const second = mockInst('b', 1, 2, 'shared.webp');
  const stage = [first, second];
  const mFirst = marginalAtlasBytesForInstance(first, stage);
  const mSecond = marginalAtlasBytesForInstance(second, stage);
  assert.equal(mSecond.marginalBytes, 0);
  assert.equal(mSecond.sharedPageCount, 1);
  assert.equal(mFirst.marginalBytes, mFirst.localBytes);
});

test('sceneAtlasMemorySummary reports content vs gpu vs stacked', () => {
  const first = mockInst('a', 0, 1, 'shared.webp');
  const second = mockInst('b', 1, 2, 'shared.webp');
  const summary = sceneAtlasMemorySummary([first, second]);
  assert.equal(summary.contentUniquePageCount, 1);
  assert.equal(summary.gpuUniquePageCount, 2);
  assert.equal(summary.stackedBytes, summary.contentUniqueBytes * 2);
});
