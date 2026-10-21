import assert from 'node:assert/strict';
import test from 'node:test';
import { snapBox, snapToGrid } from '../src/composer/snap.js';

test('snaps the right edge of A to the left edge of B', () => {
  const moving = { x: 90, y: 0, width: 20, height: 10 };
  const other = { x: 112, y: 0, width: 20, height: 10 };
  const snapped = snapBox(moving, [other], 8);
  assert.equal(snapped.box.x + snapped.box.width, other.x);
  assert.equal(snapped.guides.some((guide) => guide.axis === 'x'), true);
});

test('snaps vertical centers', () => {
  const moving = { x: 0, y: 10, width: 10, height: 10 };
  const other = { x: 40, y: 12, width: 10, height: 10 };
  const snapped = snapBox(moving, [other], 8);
  assert.equal(snapped.box.y + snapped.box.height / 2, other.y + other.height / 2);
});

test('leaves the box alone when nothing is close', () => {
  const moving = { x: 0, y: 0, width: 10, height: 10 };
  const snapped = snapBox(moving, [{ x: 100, y: 100, width: 10, height: 10 }], 8);
  assert.equal(snapped.box.x, 0);
  assert.equal(snapped.box.y, 0);
  assert.equal(snapped.guides.length, 0);
});

test('snapToGrid aligns left/top within threshold', () => {
  const moving = { x: 18, y: 14, width: 10, height: 10 };
  const snapped = snapToGrid(moving, 16, 8);
  assert.equal(snapped.box.x, 16);
  assert.equal(snapped.box.y, 16);
});
