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

test('formatPerfAtlasMemory all scope reports gpu and content lines', () => {
  const a = inst('a', 0, 1);
  const b = inst('b', 1, 2);
  const { primary, secondary } = formatPerfAtlasMemory('all', [a, b], null);
  assert.match(primary, /MB GPU \(2 textures\)/);
  assert.match(secondary, /unique atlas file/);
});

test('formatPerfAtlasMemory selected reports marginal when shared file', () => {
  const a = inst('a', 0, 1);
  const b = inst('b', 1, 2);
  const { primary, secondary } = formatPerfAtlasMemory('selected', [a, b], b);
  assert.match(primary, /local/);
  assert.match(secondary, /0\.00 MB unique on stage/);
  assert.match(secondary, /shared/);
  assert.doesNotMatch(secondary, /GPU/);
});
