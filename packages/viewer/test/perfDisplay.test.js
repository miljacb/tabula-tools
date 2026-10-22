import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPerfAtlasMemory } from '../src/features/perfDisplay.js';

function page(name, width, height, uid) {
  return { name, width, height, texture: { baseTexture: { uid, realWidth: width, realHeight: height } } };
}

function inst(id, z, uid, name = 'hero.webp') {
  return {
    id,
    zIndex: z,
    atlas: { pages: [page(name, 64, 64, uid)] },
    spine: { skeleton: { drawOrder: [], bones: [], data: {} } },
  };
}

test('formatPerfAtlasMemory all scope counts GPU textures and flags duplicate uploads', () => {
  const a = inst('a', 0, 1);
  const b = inst('b', 1, 2);
  const { primary, secondary } = formatPerfAtlasMemory('all', [a, b], null);
  assert.equal(primary, '0.03 MB · 2 textures');
  assert.equal(secondary, '0.02 MB is 1 duplicate upload of the same image file');
});

test('formatPerfAtlasMemory selected: a shared texture adds nothing', () => {
  const a = inst('a', 0, 1);
  const b = inst('b', 1, 1);
  const { primary, secondary } = formatPerfAtlasMemory('selected', [a, b], b);
  assert.equal(primary, '0.02 MB · 1 page');
  assert.equal(secondary, 'adds 0.00 MB to the stage · 1 shared with a lower skeleton');
});

test('formatPerfAtlasMemory selected: a re-imported file is a duplicate upload', () => {
  const a = inst('a', 0, 1);
  const b = inst('b', 1, 2);
  const { secondary } = formatPerfAtlasMemory('selected', [a, b], b);
  assert.equal(secondary, 'adds 0.02 MB to the stage · 1 duplicate upload (0.02 MB)');
});

test('summarizePageMemory totals bytes per memory type', async () => {
  const { summarizePageMemory } = await import('../src/features/memory.js');
  const out = summarizePageMemory({
    bytes: 1000,
    breakdown: [
      { bytes: 600, types: ['JavaScript'] },
      { bytes: 100, types: ['JavaScript'] },
      { bytes: 250, types: ['DOM'] },
      { bytes: 0, types: [] },
      { bytes: 50, types: [] },
    ],
  });
  assert.equal(out.total, 1000);
  assert.deepEqual(out.byType, { JavaScript: 700, DOM: 250, Other: 50 });
});
