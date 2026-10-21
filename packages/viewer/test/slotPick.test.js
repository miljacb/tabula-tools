import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesFilter, pointInPolygon } from '../src/features/slotPick.js';

test('pointInPolygon detects a point inside a square', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(20, 5, square), false);
});

test('matchesFilter is case-insensitive', () => {
  assert.equal(matchesFilter('HeroIdle', 'idle'), true);
  assert.equal(matchesFilter('HeroIdle', 'walk'), false);
  assert.equal(matchesFilter('HeroIdle', ''), true);
});
