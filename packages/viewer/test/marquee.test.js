import assert from 'node:assert/strict';
import test from 'node:test';
import { rectFullyInside } from '../src/composer/marquee.js';

test('rectFullyInside requires the inner box to fit within the outer box', () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(rectFullyInside({ x: 10, y: 10, width: 20, height: 20 }, outer), true);
  assert.equal(rectFullyInside({ x: 90, y: 10, width: 20, height: 20 }, outer), false);
  assert.equal(rectFullyInside({ x: 0, y: 0, width: 100, height: 100 }, outer), true);
});
